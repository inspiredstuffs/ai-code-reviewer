/**
 * Claude PR Reviewer — GitHub App webhook service
 *
 * Reacts to `pull_request.review_requested`. When the requested reviewer is
 * REVIEWER_LOGIN, it pulls the PR diff, asks Claude (on your subscription, via
 * the Claude Code CLI in headless mode) to review it, and posts the result as a
 * single PR review with inline comments — Copilot-style.
 *
 * Auth: uses CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) so usage is
 * billed to your Claude subscription, not a metered API key.
 *
 * Delivery & concurrency: GitHub fails a webhook delivery it can't deliver in
 * ~10s and retries it. Reviews take far longer than that, so we ack immediately
 * and run the review in the background, serialised through a queue so only one
 * `claude` subprocess runs at a time (predictable memory on a small box). Each
 * PR head SHA is reviewed at most once.
 */

import express from "express";
import { App, Octokit } from "octokit";
import { spawn } from "node:child_process";
import PQueue from "p-queue";

const {
  GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY,
  GITHUB_WEBHOOK_SECRET,
  REVIEWER_LOGIN,                       // login(s) that, when requested as reviewer, trigger a review
  CLAUDE_MODEL = "claude-sonnet-4-6",
  PORT = "3000",
} = process.env;

// Accounts whose requested review triggers Claude. REVIEWER_LOGIN may be a single
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

// Head SHAs already reviewed (or in flight), keyed per PR so the same commit on a
// different PR is still reviewed. Reserving the key before work starts also dedupes
// GitHub's redelivery retries. In-memory only: a process restart clears it, which at
// worst re-reviews an open PR once. Failed reviews release their key so a re-request
// can retry.
const reviewedHeads = new Set<string>();

type ReviewComment = {
  path: string;
  line: number;
  side?: "RIGHT" | "LEFT";
  severity?: "info" | "warn" | "blocker";
  body: string;
};
type ReviewResult = { summary: string; comments: ReviewComment[] };

/** Ask Claude to review a unified diff and return structured JSON. */
async function reviewDiff(diff: string): Promise<ReviewResult> {
  const prompt = `You are reviewing a GitHub pull request from the unified diff below.
Respond with ONLY a JSON object (no prose, no markdown fences) of the form:
{"summary": string, "comments": [{"path": string, "line": number, "side": "RIGHT"|"LEFT", "severity": "info"|"warn"|"blocker", "body": string}]}
Rules:
- Only comment on lines that appear in the diff.
- "line" is the line number in the file's NEW version; use side "RIGHT" for added/changed
  lines and "LEFT" for removed lines.
- Be specific and actionable. Skip nitpicks unless they matter.
- If nothing needs changing, return an empty "comments" array.

DIFF:
${diff}`;

  const stdout = await runClaude(prompt);

  const envelope = JSON.parse(stdout);            // Claude Code wraps the reply in an envelope
  const text = String(envelope.result ?? "").trim();
  return JSON.parse(stripFences(text)) as ReviewResult;
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/** A short PR note shown when a review couldn't be completed, so the requester
 *  isn't left in limbo and knows to re-request. */
function failureNotice(err: unknown): string {
  const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  return [
    "🤖 **Claude review failed** — I couldn't complete this review.",
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

/**
 * Run `claude -p` headlessly, feeding the prompt on stdin (NOT as an argv — a diff
 * can exceed the OS argument-length limit) and resolving with its stdout. Uses
 * spawn because promisified execFile silently ignores an `input` option, so the
 * prompt would never reach Claude.
 */
function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Inherit env so CLAUDE_CODE_OAUTH_TOKEN is picked up. ANTHROPIC_API_KEY must
    // NOT be set, or it takes precedence over the subscription token.
    const child = spawn(
      "claude",
      ["-p", "--output-format", "json", "--max-turns", "1", "--model", CLAUDE_MODEL],
      { env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude exited with code ${code}: ${stderr.trim().slice(0, 1000)}`));
    });

    // Surface stdin errors (e.g. EPIPE if Claude exits before reading it all).
    child.stdin.on("error", reject);
    child.stdin.end(prompt);
  });
}

type ReviewTarget = {
  octokit: Octokit;
  owner: string;
  repo: string;
  pull_number: number;
  key: string;
  reviewer: string; // the requested login to clear once the review is posted
};

/**
 * Fetch the PR diff, review it on the Claude subscription, and post the result as
 * one review. Throws on failure so the caller can release the idempotency key for a
 * later retry.
 */
async function processReview({ octokit, owner, repo, pull_number, key, reviewer }: ReviewTarget): Promise<void> {
  // 1. Fetch the PR as a unified diff.
  const diffResp = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  const diff = diffResp.data as unknown as string;

  // 2. Review on your Claude subscription.
  const result = await reviewDiff(diff);

  const comments = (result.comments ?? [])
    .filter((c) => c.path && Number.isInteger(c.line))
    .map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? "RIGHT",
      body: c.severity ? `**${c.severity.toUpperCase()}** — ${c.body}` : c.body,
    }));

  const header = `🤖 **Claude review**\n\n${result.summary ?? ""}`;

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
  const headSha = payload.pull_request.head.sha;
  const key = `${owner}/${repo}#${pull_number}@${headSha}`;

  // Idempotency: skip a head SHA we've already reviewed. Reserving the key now (before
  // any await) also dedupes GitHub's redelivery of webhooks we don't ack in time.
  if (reviewedHeads.has(key)) {
    console.log(`[${key}] already reviewed; skipping`);
    // The review already exists — still clear the re-request so the bot doesn't
    // get stuck "awaiting review" for this commit. Fire-and-forget.
    void clearReviewRequest(octokit, { owner, repo, pull_number, key }, requested);
    return;
  }
  reviewedHeads.add(key);

  // Hand the review to the queue and return immediately, so the webhook is acked well
  // inside GitHub's ~10s window. The work runs in the background, one review at a time.
  void queue
    .add(() => processReview({ octokit, owner, repo, pull_number, key, reviewer: requested }))
    .catch(async (err) => {
      // Release the key so a later re-request can retry this exact head SHA.
      reviewedHeads.delete(key);
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
