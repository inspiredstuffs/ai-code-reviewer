/**
 * GitLab provider — drives the GitLab Merge Request webhook + REST API (api/v4).
 * Pure construction: createGitlabProvider takes the env so it's testable without the
 * real environment. The webhook-parsing, diff-assembly, comment-position, and
 * reviewer-math logic is factored into exported pure helpers so it's unit-testable
 * without a live GitLab.
 *
 * GitLab differs from GitHub in ways this file absorbs:
 *  - Webhook auth is a plain `X-Gitlab-Token` equality check, not an HMAC signature.
 *  - There's no `review_requested` event: a reviewer/assignee change rides on a
 *    generic `update` action, detected by diffing `changes.reviewers/assignees`.
 *  - There's no batched "review" object: inline comments are individual discussion
 *    threads (each needs a `position` with the MR's base/start/head SHAs); the summary
 *    is a separate note.
 *  - Auth is one static access token; the bot's own user id is resolved via GET /user.
 *  - The diff comes back as paginated per-file JSON, reassembled into a unified diff.
 */

import type { IncomingHttpHeaders } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { RepositoryProvider, ReviewRequest } from "../repository.ts";
import { headerValue, refKey } from "../repository.ts";
import type { PrIntent, ReviewComment } from "../review.ts";
import { basicAuthHeader, cloneRef } from "../clone.ts";

/** The three SHAs that anchor an inline comment to the diff, from the MR's `diff_refs`. */
export type DiffRefs = { base_sha: string; start_sha: string; head_sha: string };

/** Provider-private payload carried on a GitLab ReviewRequest. */
type GitlabContext = {
  projectId: number;
  mrIid: number;
  reviewerIds: number[];   // current full reviewer set (for the clear PUT)
  assigneeIds: number[];   // current full assignee set
  diffRefs?: DiffRefs;     // filled in fetchDiff, used by postReview
};

/** One file's entry from `GET .../merge_requests/:iid/diffs`. */
export type GitlabDiffFile = {
  old_path: string;
  new_path: string;
  diff: string;            // the per-file hunk body (no `diff --git`/`---`/`+++` headers)
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
};

/** Normalized MR-event fields extracted from a webhook payload. */
export type ParsedMrEvent = {
  ref: { owner: string; repo: string; pull_number: number; head_sha: string };
  projectId: number;
  mrIid: number;
  labels: string[];
  intent: PrIntent;
  reviewerIds: number[];
  assigneeIds: number[];
  triggeredBy: "reviewer" | "assignee";
};

const MR_TRIGGER_ACTIONS = new Set(["open", "reopen", "update"]);

/** Collect numeric ids from an array of GitLab user objects, dropping anything malformed. */
function userIds(arr: unknown): number[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((u) => (u as { id?: unknown })?.id).filter((id): id is number => typeof id === "number");
}

/**
 * Decide whether an MR webhook payload means "the bot was just asked to review", and
 * if so extract the normalized fields. Returns null when it's not a trigger for us.
 *
 * Trigger = the bot is newly present (vs. the `changes` previous set) as a reviewer or
 * assignee, OR the bot's reviewer entry is flagged `re_requested`, OR (on open/reopen,
 * where there's no `changes` delta) the bot is already in the reviewer/assignee set.
 * Pure, so the trigger logic is unit-testable.
 */
export function parseMergeRequestEvent(payload: any, botUserId: number): ParsedMrEvent | null {
  if (payload?.object_kind !== "merge_request") return null;
  const attrs = payload.object_attributes ?? {};
  if (!MR_TRIGGER_ACTIONS.has(attrs.action)) return null;

  const reviewers = payload.reviewers ?? [];
  const reviewerIds = Array.isArray(attrs.reviewer_ids) ? attrs.reviewer_ids : userIds(reviewers);
  const assigneeIds = Array.isArray(attrs.assignee_ids) ? attrs.assignee_ids : userIds(payload.assignees);
  const changes = payload.changes ?? {};

  const newlyAdded = (change: any): boolean => {
    if (!change) return false;
    const prev = new Set(userIds(change.previous));
    const curr = new Set(userIds(change.current));
    return curr.has(botUserId) && !prev.has(botUserId);
  };
  const reRequested = reviewers.some(
    (r: any) => r?.id === botUserId && r?.re_requested === true,
  );

  let triggeredBy: "reviewer" | "assignee" | null = null;
  if (newlyAdded(changes.reviewers) || reRequested) triggeredBy = "reviewer";
  else if (newlyAdded(changes.assignees)) triggeredBy = "assignee";
  else if (attrs.action === "open" || attrs.action === "reopen") {
    if (reviewerIds.includes(botUserId)) triggeredBy = "reviewer";
    else if (assigneeIds.includes(botUserId)) triggeredBy = "assignee";
  }
  if (!triggeredBy) return null;

  const project = payload.project ?? {};
  const path: string = project.path_with_namespace ?? "";
  const slash = path.lastIndexOf("/");
  const owner = slash >= 0 ? path.slice(0, slash) : path;
  const repo = slash >= 0 ? path.slice(slash + 1) : path;

  const labels: string[] = (attrs.labels ?? payload.labels ?? [])
    .map((l: any) => l?.title ?? l?.name)
    .filter((t: unknown): t is string => typeof t === "string" && t.length > 0);

  return {
    ref: { owner, repo, pull_number: attrs.iid, head_sha: attrs.last_commit?.id ?? "" },
    projectId: project.id,
    mrIid: attrs.iid,
    labels,
    intent: { title: attrs.title, body: attrs.description },
    reviewerIds,
    assigneeIds,
    triggeredBy,
  };
}

/**
 * Reassemble GitLab's paginated per-file diff JSON into a single unified-diff string.
 * GitLab returns only the hunk body per file, so we synthesize the `diff --git` /
 * `--- a/…` / `+++ b/…` headers (using `/dev/null` for added/deleted files). Pure.
 */
export function assembleUnifiedDiff(files: GitlabDiffFile[]): string {
  return files
    .map((f) => {
      const body = f.diff.endsWith("\n") ? f.diff : `${f.diff}\n`;
      // GitLab returns a bare hunk body. Be defensive: if a representation ever already
      // carries the `diff --git`/`---` file headers, don't synthesize a second set.
      if (/^(diff --git |--- )/.test(f.diff)) return body;
      const oldSide = f.new_file ? "/dev/null" : `a/${f.old_path}`;
      const newSide = f.deleted_file ? "/dev/null" : `b/${f.new_path}`;
      return `diff --git a/${f.old_path} b/${f.new_path}\n--- ${oldSide}\n+++ ${newSide}\n${body}`;
    })
    .join("");
}

/**
 * Build the GitLab discussion `position` object for an inline comment. A RIGHT-side
 * (added/changed) comment anchors on `new_line`; a LEFT-side (removed) one on
 * `old_line`. The AI gives a single file path, used for both old/new paths (rename
 * edge cases may mis-anchor and are caught at post time). Pure.
 */
export function buildPosition(comment: ReviewComment, diffRefs: DiffRefs): Record<string, unknown> {
  const position: Record<string, unknown> = {
    position_type: "text",
    base_sha: diffRefs.base_sha,
    start_sha: diffRefs.start_sha,
    head_sha: diffRefs.head_sha,
    old_path: comment.path,
    new_path: comment.path,
  };
  if ((comment.side ?? "RIGHT") === "LEFT") position.old_line = comment.line;
  else position.new_line = comment.line;
  return position;
}

/** The reviewer/assignee set minus the bot — what we PUT back to unassign it (full replace). */
export function idsWithout(ids: number[], botUserId: number): number[] {
  return ids.filter((id) => id !== botUserId);
}

/**
 * The PUT body that removes the bot from the MR — only the field(s) the bot is
 * actually in. A bot added as both reviewer and assignee is cleared from both (the
 * trigger field alone would leave it lingering in the other). `reviewer_ids`/
 * `assignee_ids` are full-replace, so we send the current set minus the bot. That set
 * is `[]` exactly when the bot was the sole reviewer/assignee, which is correct — it
 * clears only the bot (who was the whole set), not other people. Returns `{}` when the
 * bot is in neither field, so the caller can skip the PUT entirely.
 */
export function unassignBotJson(
  reviewerIds: number[],
  assigneeIds: number[],
  botUserId: number,
): { reviewer_ids?: number[]; assignee_ids?: number[] } {
  const json: { reviewer_ids?: number[]; assignee_ids?: number[] } = {};
  if (reviewerIds.includes(botUserId)) json.reviewer_ids = idsWithout(reviewerIds, botUserId);
  if (assigneeIds.includes(botUserId)) json.assignee_ids = idsWithout(assigneeIds, botUserId);
  return json;
}

/** Constant-time equality of the received `X-Gitlab-Token` against the configured secret. */
function tokenMatches(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Build a GitLab provider bound to the configured token, API URL, and webhook secret. */
export function createGitlabProvider(env: NodeJS.ProcessEnv): RepositoryProvider {
  const token = env.GITLAB_TOKEN ?? "";
  const webhookSecret = env.GITLAB_WEBHOOK_SECRET ?? "";
  // Base URL with no /api/v4 suffix (we add it per-call). It doubles as the git base
  // for clone URLs, so a subpath-hosted instance (e.g. https://host/gitlab) is honored
  // verbatim rather than collapsed to its origin.
  const apiUrl = (env.GITLAB_API_URL?.trim() || "https://gitlab.com").replace(/\/+$/, "");

  // Resolved in init() via GET /user; -1 never matches a real reviewer id.
  let botUserId = -1;

  /** One JSON REST call against api/v4. Fails loudly with method, path, and status. */
  const api = async (
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; json?: unknown } = {},
  ): Promise<any> => {
    const url = new URL(`${apiUrl}/api/v4${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { "PRIVATE-TOKEN": token };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    const resp = await fetch(url, { method, headers, body });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`${method} /api/v4${path} failed: ${resp.status} ${detail.slice(0, 300)}`);
    }
    return resp.status === 204 ? null : resp.json();
  };

  /** Page through a list endpoint via the `x-next-page` header until exhausted. */
  const getAllPages = async (path: string, query: Record<string, string> = {}): Promise<any[]> => {
    const out: any[] = [];
    let page = 1;
    for (;;) {
      const url = new URL(`${apiUrl}/api/v4${path}`);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const resp = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`GET /api/v4${path} failed: ${resp.status} ${detail.slice(0, 300)}`);
      }
      out.push(...((await resp.json()) as unknown[]));
      // GitLab signals "no more pages" with an empty x-next-page; guard "0" too so a
      // stray sentinel can't drive page=0 (an invalid request / potential loop).
      const next = resp.headers.get("x-next-page");
      if (!next || next === "0") break;
      page = Number(next);
    }
    return out;
  };

  const mrPath = (ctx: GitlabContext): string =>
    `/projects/${ctx.projectId}/merge_requests/${ctx.mrIid}`;

  return {
    name: "gitlab",
    webhookPath: "/api/gitlab/webhooks",
    changeNoun: "merge request",

    validateConfig(e: NodeJS.ProcessEnv): void {
      if (!e.GITLAB_TOKEN) throw new Error("GITLAB_TOKEN must be set for REPO_PROVIDER=gitlab.");
      if (!e.GITLAB_WEBHOOK_SECRET) {
        throw new Error("GITLAB_WEBHOOK_SECRET must be set for REPO_PROVIDER=gitlab.");
      }
    },

    async init(): Promise<void> {
      // Resolve the bot's own user id from the token, so reviewer/assignee detection
      // and unassignment key off the right account. Fails boot if the token is invalid.
      const me = await api("GET", "/user");
      if (typeof me?.id !== "number") {
        throw new Error("could not resolve GitLab bot user id from GET /user (check GITLAB_TOKEN)");
      }
      botUserId = me.id;
    },

    async parseWebhook(headers: IncomingHttpHeaders, rawBody: Buffer): Promise<ReviewRequest | null> {
      // Plain token equality (constant-time), not an HMAC signature; bad token → 400.
      if (!tokenMatches(headerValue(headers, "x-gitlab-token"), webhookSecret)) {
        throw new Error("invalid X-Gitlab-Token");
      }
      if (headerValue(headers, "x-gitlab-event") !== "Merge Request Hook") return null;

      const parsed = parseMergeRequestEvent(JSON.parse(rawBody.toString("utf8")), botUserId);
      if (!parsed) return null;

      return {
        ref: parsed.ref,
        reviewer: String(botUserId),
        labels: parsed.labels,
        intent: parsed.intent,
        deepCapable: true,
        context: {
          projectId: parsed.projectId,
          mrIid: parsed.mrIid,
          reviewerIds: parsed.reviewerIds,
          assigneeIds: parsed.assigneeIds,
        } satisfies GitlabContext,
      };
    },

    async fetchDiff(req: ReviewRequest): Promise<string> {
      const ctx = req.context as GitlabContext;
      // Read the diff SHAs from the same MR snapshot we diff, so inline comments anchor
      // correctly (stale SHAs are rejected by GitLab).
      const mr = await api("GET", mrPath(ctx));
      ctx.diffRefs = mr?.diff_refs;
      const files = (await getAllPages(`${mrPath(ctx)}/diffs`, { unidiff: "true" })) as GitlabDiffFile[];
      return assembleUnifiedDiff(files);
    },

    async postReview(req: ReviewRequest, header: string, comments: ReviewComment[]): Promise<void> {
      const ctx = req.context as GitlabContext;
      const discussions = `${mrPath(ctx)}/discussions`;
      // GitLab has no batched review — each inline comment is its own discussion
      // thread. Post them individually, skipping any the API rejects (the analog of
      // GitHub's 422 fall-back), then post the summary as a positionless note.
      if (ctx.diffRefs) {
        for (const c of comments) {
          try {
            await api("POST", discussions, { json: { body: c.body, position: buildPosition(c, ctx.diffRefs) } });
          } catch (err) {
            console.warn(`[${refKey(req.ref)}] inline comment on ${c.path}:${c.line} rejected; skipping`, err);
          }
        }
      } else {
        console.warn(`[${refKey(req.ref)}] no diff_refs available; posting summary only`);
      }
      // Guard the summary too: unlike GitHub's atomic createReview, a GitLab review is
      // several POSTs. If this threw, processReview would mark the SHA failed and a
      // re-request would re-post every inline comment as a duplicate. Swallow it so the
      // review is recorded posted exactly once (a dropped summary is logged, not retried).
      try {
        await api("POST", discussions, { json: { body: header } });
      } catch (err) {
        console.warn(`[${refKey(req.ref)}] summary note rejected:`, err);
      }
    },

    async postFailureNotice(req: ReviewRequest, body: string): Promise<void> {
      const ctx = req.context as GitlabContext;
      await api("POST", `${mrPath(ctx)}/discussions`, { json: { body } });
    },

    async clearReviewRequest(req: ReviewRequest): Promise<void> {
      const ctx = req.context as GitlabContext;
      // Remove the bot from whichever of reviewer/assignee it's in, so it doesn't
      // linger on the MR. Best-effort.
      const json = unassignBotJson(ctx.reviewerIds, ctx.assigneeIds, botUserId);
      if (Object.keys(json).length === 0) return;
      try {
        await api("PUT", mrPath(ctx), { json });
      } catch (err) {
        console.warn(`[${refKey(req.ref)}] could not unassign bot:`, err);
      }
    },

    async cloneHead(req: ReviewRequest): Promise<string> {
      const ctx = req.context as GitlabContext;
      // GitLab git-over-HTTPS uses Basic auth with username `oauth2` and the token as
      // the password; `merge-requests/<iid>/head` is fork-agnostic like GitHub's
      // `pull/<n>/head`. The token rides the auth header, never the URL.
      return cloneRef({
        cloneUrl: `${apiUrl}/${req.ref.owner}/${req.ref.repo}.git`,
        fetchRef: `merge-requests/${ctx.mrIid}/head`,
        authHeader: basicAuthHeader("oauth2", token),
      });
    },
  };
}
