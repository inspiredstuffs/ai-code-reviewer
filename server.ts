/**
 * Alátùńwò AI Code Reviewer — GitHub App webhook service
 *
 * Reacts to `pull_request.review_requested`. When the requested reviewer is
 * REVIEWER_LOGIN, it pulls the PR diff, asks the configured AI provider (Claude by
 * default, on your subscription via its headless CLI) to review it, and posts the
 * result as a single PR review with inline comments — Copilot-style.
 *
 * Auth is provider-specific (the Claude provider uses CLAUDE_CODE_OAUTH_TOKEN from
 * `claude setup-token`, so usage is billed to your subscription, not a metered API
 * key). The provider seam lives in provider.ts / providers/<name>.ts.
 *
 * Delivery & concurrency: GitHub fails a webhook delivery it can't deliver in
 * ~10s and retries it. Reviews take far longer than that, so we ack immediately
 * and run the review in the background, serialised through a queue so only one
 * provider subprocess runs at a time (predictable memory on a small box). Each
 * PR head SHA is reviewed at most once.
 */

import express from "express";
import { App, Octokit } from "octokit";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import PQueue from "p-queue";
import { ReviewStore, type ReviewRef } from "./store.ts";
import {
  buildContextPrompt,
  buildDiffPrompt,
  buildReviewHeader,
  parsePositiveInt,
  shouldDeepReview,
  type PrIntent,
  type ReviewResult,
} from "./review.ts";
import { runReview, selectProvider } from "./provider.ts";
import { clonePrHead, removeWorkdir } from "./clone.ts";

const {
  GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY,
  GITHUB_WEBHOOK_SECRET,
  REVIEWER_LOGIN,                       // login(s) that, when requested as reviewer, trigger a review
  AI_PROVIDER,                          // which review CLI to drive; defaults to "claude"
  DATABASE_PATH = "./data/reviews.db",  // SQLite file; mount a volume here in prod
  DEEP_REVIEW = "false",                // "true" → clone the PR so the model can read surrounding files
  DEEP_REVIEW_MAX_TURNS = "8",          // turn budget for a deep review (diff-only is always 1)
  BOT_NAME = "Alátùńwò AI",             // display name in the review header/notice
  PORT = "3000",
} = process.env;

// Pick the AI provider (Claude by default) and let it fail fast on bad config —
// e.g. the Claude provider rejects a stray ANTHROPIC_API_KEY that would override
// the subscription token. Provider-specific wiring lives in providers/<name>.ts.
const provider = selectProvider(AI_PROVIDER);
provider.validateConfig(process.env);

const now = (): string => new Date().toISOString();

// Deep reviews check out the PR branch and let the model open surrounding files with
// READ-ONLY tools (no Bash/Write/Edit), so untrusted PR code can't be executed. Opt
// in via DEEP_REVIEW=true; otherwise reviews stay diff-only.
const deepReviewEnabled = DEEP_REVIEW.toLowerCase() === "true";
const deepReviewMaxTurns = parsePositiveInt(DEEP_REVIEW_MAX_TURNS, "DEEP_REVIEW_MAX_TURNS");

// Accounts whose requested review triggers a review. REVIEWER_LOGIN may be a single
// login or a comma-separated list (e.g. "ayewobot,inspiredstuffs"), matched
// case-insensitively.
const REVIEWER_LOGINS = new Set(
  (REVIEWER_LOGIN ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Restore the GitHub App private key from its env var. Accepts a PEM with real
 * newlines, a `\n`-escaped one-liner, or base64(PEM). base64 is preferred for
 * deploys: it has no backslashes or newlines for env-file layers to mangle.
 * (Kamal double-escapes backslashes when writing the container env-file, which
 * turned a `\n`-encoded key into `\\n` and broke OpenSSL decoding.)
 */
function loadAppPrivateKey(raw: string): string {
  const v = raw.trim();
  return v.includes("BEGIN") ? v.replace(/\\n/g, "\n") : Buffer.from(v, "base64").toString("utf8");
}

const ghApp = new App({
  appId: GITHUB_APP_ID!,
  privateKey: loadAppPrivateKey(GITHUB_APP_PRIVATE_KEY!),
  webhooks: { secret: GITHUB_WEBHOOK_SECRET! },
});

// One `claude` subprocess at a time. Reviews are memory-heavy and run on a shared
// subscription, so serialising keeps resource use predictable and avoids piling up
// concurrent CLI processes when several reviews are requested at once.
const queue = new PQueue({ concurrency: 1 });

// Durable record of every review request, keyed per (PR, head SHA). Reserving a
// row before work starts dedupes GitHub's redelivery retries and survives process
// restarts. Failed reviews stay retryable; see store.ts. Any row left "pending" by
// a crash is recovered to "failed" at boot so it doesn't block a retry forever.
if (DATABASE_PATH !== ":memory:") mkdirSync(dirname(DATABASE_PATH), { recursive: true });
const store = new ReviewStore(DATABASE_PATH);
const orphaned = store.recoverOrphans(now());
if (orphaned > 0) console.warn(`recovered ${orphaned} review(s) left pending by a previous run`);

/** Diff-only review: the model sees the unified diff plus the PR's stated intent. */
async function reviewDiff(diff: string, intent: PrIntent): Promise<ReviewResult> {
  return runReview(provider, buildDiffPrompt(diff, intent));
}

/**
 * Deep review: check out the PR head, let the model open surrounding files with
 * read-only tools, then always clean up the working dir. The caller only routes
 * here when DEEP_REVIEW is enabled and an installation id is available.
 */
async function reviewWithContext(
  ref: ReviewRef,
  installationId: number,
  diff: string,
  key: string,
  intent: PrIntent,
): Promise<ReviewResult> {
  const token = await mintInstallationToken(installationId, ref.repo);
  let clonePath: string | undefined;
  try {
    clonePath = await clonePrHead({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      token,
    });
    console.log(`[${key}] PR head checked out; deep review (max-turns ${deepReviewMaxTurns})`);
    return runReview(provider, buildContextPrompt(diff, clonePath, intent), {
      maxTurns: deepReviewMaxTurns,
      addDir: clonePath,
      deep: true,
    });
  } finally {
    if (clonePath) await removeWorkdir(clonePath);
  }
}

/**
 * Mint a short-lived installation token scoped to just this repo with contents:read
 * — least privilege, enough to fetch the PR head for a clone.
 */
async function mintInstallationToken(installationId: number, repo: string): Promise<string> {
  const { data } = await ghApp.octokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
    repositories: [repo],
    permissions: { contents: "read" },
  });
  return data.token;
}

/** A short PR note shown when a review couldn't be completed, so the requester
 *  isn't left in limbo and knows to re-request. */
function failureNotice(err: unknown): string {
  const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  return [
    `🤖 **${BOT_NAME} review failed** — I couldn't complete this review.`,
    "",
    "Please re-request a review (the ↻ icon next to the reviewer) to try again.",
    "",
    "<details><summary>Error detail</summary>",
    "",
    "```",
    detail,
    "```",
    "</details>",
  ].join("\n");
}

type ReviewTarget = {
  octokit: Octokit;
  ref: ReviewRef;            // owner/repo/pull_number/head_sha — the store key
  key: string;               // human-readable label for logs
  reviewer: string;          // the requested login to clear once the review is posted
  deep: boolean;             // run a clone-based deep review (env default or PR label)
  installationId?: number;   // needed to mint a token for deep (clone-based) reviews
  intent: PrIntent;          // PR title/body, so the review can judge intent vs. change
};

/**
 * Fetch the PR diff, review it via the configured provider, and post the result as
 * one review. Records the outcome in the store on success; throws on failure so the
 * caller can mark it failed (keeping the head SHA retryable on re-request).
 */
async function processReview({ octokit, ref, key, reviewer, deep, installationId, intent }: ReviewTarget): Promise<void> {
  const { owner, repo, pull_number } = ref;
  // 1. Fetch the PR as a unified diff.
  const diffResp = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  const diff = diffResp.data as unknown as string;

  // 2. Review on your Claude subscription. Deep review clones the PR for file context
  //    when requested and we have an installation id; otherwise it's a diff-only pass.
  //    Track what actually ran so the header reflects reality (not just what was asked).
  let result: ReviewResult;
  let didDeepReview = false;
  if (deep && installationId !== undefined) {
    didDeepReview = true;
    result = await reviewWithContext(ref, installationId, diff, key, intent);
  } else {
    result = await reviewDiff(diff, intent);
  }

  const comments = (result.comments ?? [])
    .filter((c) => c.path && Number.isInteger(c.line))
    .map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? "RIGHT",
      body: c.severity ? `**${c.severity.toUpperCase()}** — ${c.body}` : c.body,
    }));

  const header = buildReviewHeader(BOT_NAME, didDeepReview, result.summary ?? "");

  // 3. Post one review with inline comments. GitHub rejects the whole review (422)
  //    if any inline comment targets a line outside the diff — fall back to summary-only.
  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number,
      event: "COMMENT", // never auto-approve or auto-request-changes
      body: header,
      comments,
    });
  } catch {
    console.warn(`[${key}] inline review rejected; posting summary only`);
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number,
      event: "COMMENT",
      body: header,
    });
  }

  store.markPosted(ref, result.summary ?? "", comments.length, now());
  console.log(`[${key}] review posted`);
  await clearReviewRequest(octokit, { owner, repo, pull_number, key }, reviewer);
}

/**
 * Remove the bot from the PR's requested reviewers so it doesn't sit in "awaiting
 * review" — the App comments as itself, which never satisfies the request.
 * Best-effort: failures are logged, not thrown.
 */
async function clearReviewRequest(
  octokit: Octokit,
  ref: { owner: string; repo: string; pull_number: number; key: string },
  reviewer: string,
): Promise<void> {
  try {
    await octokit.rest.pulls.removeRequestedReviewers({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      reviewers: [reviewer],
    });
  } catch (err) {
    console.warn(`[${ref.key}] could not clear review request for ${reviewer}:`, err);
  }
}

ghApp.webhooks.on("pull_request.review_requested", async ({ octokit, payload }) => {
  // Only act when *our* designated reviewer is the one requested.
  // (Team requests carry `requested_team` instead and are ignored here.)
  const requested =
    "requested_reviewer" in payload ? payload.requested_reviewer?.login : undefined;
  // Match against the allowed reviewer logins (case-insensitive). A mismatch
  // silently no-ops with no log line — the failure mode we hit during setup.
  if (!requested || !REVIEWER_LOGINS.has(requested.toLowerCase())) return;

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pull_number = payload.pull_request.number;
  const head_sha = payload.pull_request.head.sha;
  const installationId = payload.installation?.id;  // present on App-scoped deliveries
  const ref: ReviewRef = { owner, repo, pull_number, head_sha };
  const key = `${owner}/${repo}#${pull_number}@${head_sha}`;

  // Deep review when it's the configured default, or the PR carries the deep-review label.
  const labels = payload.pull_request.labels?.map((l) => l.name) ?? [];
  const deep = shouldDeepReview(deepReviewEnabled, labels);

  // The PR's stated intent, so the review can judge "does the change do what it claims?".
  const intent: PrIntent = { title: payload.pull_request.title, body: payload.pull_request.body };

  // Idempotency: reserve this head SHA. A `false` return means it's already posted
  // or in flight — skip. Reserving synchronously (before any await) also dedupes
  // GitHub's redelivery of webhooks we don't ack in time.
  if (!store.reserve(ref, requested, now())) {
    console.log(`[${key}] already reviewed or in flight; skipping`);
    // The review already exists — still clear the re-request so the bot doesn't
    // get stuck "awaiting review" for this commit. Fire-and-forget.
    void clearReviewRequest(octokit, { owner, repo, pull_number, key }, requested);
    return;
  }

  // Hand the review to the queue and return immediately, so the webhook is acked well
  // inside GitHub's ~10s window. The work runs in the background, one review at a time.
  void queue
    .add(() => processReview({ octokit, ref, key, reviewer: requested, deep, installationId, intent }))
    .catch(async (err) => {
      // Mark failed so a later re-request can retry this exact head SHA.
      store.markFailed(ref, err instanceof Error ? err.message : String(err), now());
      console.error(`[${key}] review failed:`, err);
      // Don't leave the PR in limbo — post a short note so the requester knows it
      // failed and can re-request. Best-effort; ignore errors posting it.
      try {
        await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number,
          event: "COMMENT",
          body: failureNotice(err),
        });
      } catch (postErr) {
        console.error(`[${key}] could not post failure notice:`, postErr);
      }
    });
});

const server = express();
server.get("/health", (_req, res) => res.send("ok"));

// Webhooks-only service: receive the GitHub delivery directly via the App's
// Webhooks instance. We deliberately do NOT use octokit's App middleware
// (createNodeMiddleware(app)) — it also mounts OAuth routes and throws at boot
// unless oauth.clientId/clientSecret are set, which this app has no use for.
// express.raw captures the exact bytes needed to verify X-Hub-Signature-256;
// no JSON body parser may run before it.
server.post(
  "/api/github/webhooks",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      await ghApp.webhooks.verifyAndReceive({
        id: req.headers["x-github-delivery"] as string,
        name: req.headers["x-github-event"] as string,
        signature: req.headers["x-hub-signature-256"] as string,
        payload: req.body.toString("utf8"),
      });
      res.status(200).end();
    } catch (err) {
      console.error("webhook verify/receive failed:", err);
      res.status(400).end();
    }
  },
);
server.listen(Number(PORT), () => console.log(`Claude PR reviewer listening on :${PORT}`));
