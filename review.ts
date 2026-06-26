/**
 * Pure, provider-agnostic helpers for the reviewer: prompt building, the JSON
 * output contract + parsing, review-header formatting, and minimal subprocess env
 * construction. No side effects — unit-testable without starting the server or
 * shelling out. Provider-specific CLI wiring lives in providers/<name>.ts.
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

/**
 * Non-secret process vars safe to forward to any subprocess: enough to be found on
 * PATH, locate config under HOME, write temp files, render UTF-8 output, and reach
 * the network through a proxy / custom CA. Deliberately excludes everything else so
 * service secrets are default-denied rather than inherited wholesale. Providers
 * extend this with the one token they need (see providers/<name>.ts).
 */
export const BASE_ENV_ALLOWLIST = [
  "PATH", "HOME", "TMPDIR", "USER", "SHELL",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
] as const;

/**
 * Env allowlist for the `git` clone subprocess. It needs no secret from the
 * environment — the installation token is injected separately via GIT_CONFIG_* —
 * so it gets the base infra vars only.
 */
export const GIT_ENV_ALLOWLIST = BASE_ENV_ALLOWLIST;

/**
 * Build a minimal subprocess environment: copy only the allowlisted names that are
 * actually set in `source` (never introducing `undefined` keys), then layer `extra`
 * on top (which wins on conflict). Pure — the caller passes `process.env` in.
 */
export function buildSubprocessEnv(
  source: NodeJS.ProcessEnv,
  allowlist: readonly string[],
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return { ...env, ...extra };
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

/**
 * Build the posted review's header: the bot title, a badge for the review depth,
 * and a one-line caption telling the reader how much context the review had. `deep`
 * must reflect what actually ran (a deep review that fell back to diff-only is not
 * deep), so readers can calibrate how much to trust a clean result.
 */
export function buildReviewHeader(botName: string, deep: boolean, summary: string): string {
  const badge = deep ? "🔬 Deep" : "📄 Diff-only";
  const caption = deep
    ? "Reviewed with full repository context — surrounding files, call sites, and tests."
    : "Reviewed from the pull request diff only (no surrounding files).";
  return `🤖 **${botName} review** · ${badge}\n\n> _${caption}_\n\n${summary}`;
}

/** Strip a leading/trailing ```json fence Claude sometimes adds despite instructions. */
export function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * Parse the model's text reply (the review JSON, possibly fenced) into a
 * ReviewResult. This is the shared output contract; unwrapping any provider-specific
 * stdout envelope into this text happens first, in the provider's parseReply.
 */
export function parseReviewJson(text: string): ReviewResult {
  return JSON.parse(stripFences(text)) as ReviewResult;
}
