/**
 * Pure helpers for driving the `claude` CLI as a PR reviewer: prompt building,
 * argv construction, and parsing Claude Code's JSON envelope back into a review.
 * No side effects — kept separate from server.ts so they're unit-testable without
 * starting the HTTP server.
 */

export type ReviewComment = {
  path: string;
  line: number;
  side?: "RIGHT" | "LEFT";
  severity?: "info" | "warn" | "blocker";
  body: string;
};
export type ReviewResult = { summary: string; comments: ReviewComment[] };

/**
 * Parse an env var that must be a positive integer, throwing an actionable error
 * otherwise. Guards against `Number("")`/`Number("abc")` silently yielding `0`/`NaN`
 * and reaching `claude --max-turns NaN`. Validated at boot so misconfig fails fast.
 */
export function parsePositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer, got: ${JSON.stringify(value)}`);
  }
  return n;
}

/** PR label that opts a single pull request into a deep review. */
export const DEEP_REVIEW_LABEL = "deep-review";

/**
 * Decide whether a PR gets a deep (clone-based) review. True when deep review is
 * the configured default, or when the PR carries the deep-review label
 * (case-insensitive). Pure so the trigger logic is unit-testable.
 */
export function shouldDeepReview(envDefault: boolean, labels: readonly string[]): boolean {
  return envDefault || labels.some((name) => name.toLowerCase() === DEEP_REVIEW_LABEL);
}

/** Options that shape a single `claude -p` invocation. */
export type ClaudeRunOpts = {
  maxTurns?: number;              // default 1 (single pass)
  addDir?: string;               // grant tool access to this directory
  allowedTools?: readonly string[]; // restrict tools (e.g. read-only for deep reviews)
};

/** Build the argv for `claude -p`. Separated out so the flag wiring is testable. */
export function buildClaudeArgs(model: string, opts: ClaudeRunOpts = {}): string[] {
  const args = [
    "-p",
    "--output-format", "json",
    "--max-turns", String(opts.maxTurns ?? 1),
    "--model", model,
  ];
  if (opts.addDir) args.push("--add-dir", opts.addDir);
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }
  return args;
}

// Output contract shared by both prompts. The diff-only and context reviews differ
// only in whether Claude may open surrounding files.
const SCHEMA_AND_RULES = `Respond with ONLY a JSON object (no prose, no markdown fences) of the form:
{"summary": string, "comments": [{"path": string, "line": number, "side": "RIGHT"|"LEFT", "severity": "info"|"warn"|"blocker", "body": string}]}
Rules:
- Only comment on lines that appear in the diff.
- "line" is the line number in the file's NEW version; use side "RIGHT" for added/changed
  lines and "LEFT" for removed lines.
- Be specific and actionable. Skip nitpicks unless they matter.
- If nothing needs changing, return an empty "comments" array.`;

/** Diff-only review prompt — Claude sees just the unified diff. */
export function buildDiffPrompt(diff: string): string {
  return `You are reviewing a GitHub pull request from the unified diff below.
${SCHEMA_AND_RULES}

DIFF:
${diff}`;
}

/**
 * Deep-review prompt — the repo is checked out at `repoPath` (PR head), so Claude
 * can open surrounding files for context. Output contract is identical; comments
 * still only land on diff lines.
 */
export function buildContextPrompt(diff: string, repoPath: string): string {
  return `You are reviewing a GitHub pull request. The repository is checked out at
${repoPath} at the PR's head commit. Open surrounding files there for context
(definitions, call sites, tests) before commenting, but only comment on lines in the diff.
${SCHEMA_AND_RULES}

DIFF:
${diff}`;
}

/** Strip a leading/trailing ```json fence Claude sometimes adds despite instructions. */
export function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * Parse `claude --output-format json` stdout into a ReviewResult. Claude Code wraps
 * the model's reply in an envelope ({ result, ... }); the reply itself is the review
 * JSON, possibly fenced.
 */
export function parseReviewResult(stdout: string): ReviewResult {
  const envelope = JSON.parse(stdout);
  const text = String(envelope.result ?? "").trim();
  return JSON.parse(stripFences(text)) as ReviewResult;
}
