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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import PQueue from "p-queue";

const execFileAsync = promisify(execFile);

const {
  GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY,
  GITHUB_WEBHOOK_SECRET,
  REVIEWER_LOGIN,                       // user/bot account that, when requested, triggers a review
  CLAUDE_MODEL = "claude-sonnet-4-6",
  PORT = "3000",
} = process.env;

const ghApp = new App({
  appId: GITHUB_APP_ID!,
  // PEM is usually stored on one line with literal "\n" — restore real newlines:
  privateKey: GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
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

  const { stdout } = await execFileAsync(
    "claude",
    ["-p", "--output-format", "json", "--max-turns", "1", "--model", CLAUDE_MODEL],
    {
      input: prompt,
      maxBuffer: 16 * 1024 * 1024,
      // Inherit env so CLAUDE_CODE_OAUTH_TOKEN is picked up.
      // Ensure ANTHROPIC_API_KEY is NOT set, or it takes precedence over the subscription.
      env: process.env,
    },
  );

  const envelope = JSON.parse(stdout);            // Claude Code wraps the reply in an envelope
  const text = String(envelope.result ?? "").trim();
  return JSON.parse(stripFences(text)) as ReviewResult;
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

type ReviewTarget = {
  octokit: Octokit;
  owner: string;
  repo: string;
  pull_number: number;
  key: string;
};

/**
 * Fetch the PR diff, review it on the Claude subscription, and post the result as
 * one review. Throws on failure so the caller can release the idempotency key for a
 * later retry.
 */
async function processReview({ octokit, owner, repo, pull_number, key }: ReviewTarget): Promise<void> {
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
}

ghApp.webhooks.on("pull_request.review_requested", async ({ octokit, payload }) => {
  // Only act when *our* designated reviewer is the one requested.
  // (Team requests carry `requested_team` instead and are ignored here.)
  const requested =
    "requested_reviewer" in payload ? payload.requested_reviewer?.login : undefined;
  if (requested !== REVIEWER_LOGIN) return;

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pull_number = payload.pull_request.number;
  const headSha = payload.pull_request.head.sha;
  const key = `${owner}/${repo}#${pull_number}@${headSha}`;

  // Idempotency: skip a head SHA we've already reviewed. Reserving the key now (before
  // any await) also dedupes GitHub's redelivery of webhooks we don't ack in time.
  if (reviewedHeads.has(key)) {
    console.log(`[${key}] already reviewed; skipping`);
    return;
  }
  reviewedHeads.add(key);

  // Hand the review to the queue and return immediately, so the webhook is acked well
  // inside GitHub's ~10s window. The work runs in the background, one review at a time.
  void queue
    .add(() => processReview({ octokit, owner, repo, pull_number, key }))
    .catch((err) => {
      // Release the key so a later re-request can retry this exact head SHA.
      reviewedHeads.delete(key);
      console.error(`[${key}] review failed:`, err);
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
