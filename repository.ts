/**
 * Repository provider seam. The service is host-agnostic everywhere except the
 * cluster of "talk to a code-host" concerns captured by RepositoryProvider: verifying
 * and parsing its webhook, fetching a change's diff, posting the review, clearing the
 * review request, and checking out the change head for a deep review. GitHub is the
 * default; GitLab is the second implementation. Adding a third host means writing one
 * repositories/<name>.ts and adding a case to selectRepositoryProvider — the
 * queue/store/AI-provider machinery doesn't change.
 *
 * This mirrors the AI seam in provider.ts: a small interface, a name→factory switch,
 * and concrete impls under repositories/. server.ts only ever sees the normalized
 * ReviewRequest below; everything host-specific lives behind the interface.
 */

import type { IncomingHttpHeaders } from "node:http";
import type { ReviewRef } from "./store.ts";
import type { PrIntent, ReviewComment } from "./review.ts";
import { createGithubProvider } from "./repositories/github.ts";
import { createGitlabProvider } from "./repositories/gitlab.ts";

export type { ReviewRef };

/**
 * A normalized review request, distilled from a host webhook. Host-specific details
 * (which client to call, the numeric project id, the current reviewer set, the diff
 * SHAs) ride along in `context`, opaque to server.ts and read back only by the
 * provider that produced it.
 */
export type ReviewRequest = {
  ref: ReviewRef;          // owner/repo/pull_number/head_sha — the store key
  reviewer: string;        // identity to clear once the review is posted (login or user id)
  labels: string[];        // change labels, for shouldDeepReview()
  intent: PrIntent;        // title/body, so the review can judge intent vs. change
  deepCapable: boolean;    // whether the head can be cloned for a deep review
  context: unknown;        // provider-private payload (client, ids, diff refs, …)
};

/** The host-specific surface — everything that differs between code hosts. */
export interface RepositoryProvider {
  readonly name: string;          // "github" | "gitlab"
  readonly webhookPath: string;   // where the host posts deliveries, e.g. "/api/github/webhooks"
  readonly changeNoun: string;    // host term for the unit under review ("pull request" | "merge request")

  /** Boot-time config check; throw with an actionable message to fail fast. */
  validateConfig(env: NodeJS.ProcessEnv): void;
  /** One-time async setup (e.g. resolve the bot's own user id). Called once at boot. */
  init(): Promise<void>;

  /**
   * Verify and parse a raw webhook delivery. Returns a ReviewRequest when it's a
   * review trigger for us, `null` when it isn't (wrong event/action/reviewer), and
   * throws when verification fails (bad signature/token) so the caller answers 400.
   */
  parseWebhook(headers: IncomingHttpHeaders, rawBody: Buffer): Promise<ReviewRequest | null>;

  /** Fetch the change as a unified-diff string. */
  fetchDiff(req: ReviewRequest): Promise<string>;
  /** Post the review: a summary header plus inline comments on diff lines. */
  postReview(req: ReviewRequest, header: string, comments: ReviewComment[]): Promise<void>;
  /** Post a short note when a review couldn't be completed, so the requester isn't left in limbo. */
  postFailureNotice(req: ReviewRequest, body: string): Promise<void>;
  /** Remove the bot from the change's requested reviewers (best-effort). */
  clearReviewRequest(req: ReviewRequest): Promise<void>;
  /** Check out the change head into a throwaway dir for a deep review; caller removes it. */
  cloneHead(req: ReviewRequest): Promise<string>;
}

/** Human-readable label for a review, used in log lines: `owner/repo#42@<sha>`. */
export function refKey(ref: ReviewRef): string {
  return `${ref.owner}/${ref.repo}#${ref.pull_number}@${ref.head_sha}`;
}

/** Read a single header value, collapsing the array form Node uses for repeated headers. */
export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Pick the repository provider by name (REPO_PROVIDER), defaulting to GitHub so
 * existing deploys are unaffected. Unknown names fail loudly rather than silently
 * no-op.
 */
export function selectRepositoryProvider(name: string | undefined): RepositoryProvider {
  const key = (name ?? "github").trim().toLowerCase();
  switch (key) {
    case "github":
      return createGithubProvider(process.env);
    case "gitlab":
      return createGitlabProvider(process.env);
    default:
      throw new Error(
        `Unknown REPO_PROVIDER ${JSON.stringify(name)} — supported: "github", "gitlab".`,
      );
  }
}
