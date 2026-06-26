/**
 * AI provider seam. The service is provider-agnostic everywhere except the small
 * cluster of "drive a review CLI" concerns captured by ReviewProvider: which binary
 * to spawn, which flags it takes, which secrets it may inherit, and how to unwrap
 * its output. Claude is the only implementation today; adding another (e.g. a Codex
 * CLI) means writing one providers/<name>.ts and adding a case to selectProvider —
 * the GitHub/webhook/store/clone machinery doesn't change.
 *
 * Assumption: providers are subscription-auth CLIs that take a prompt on stdin and
 * print a reply on stdout. That matches this project's premise (use a subscription
 * via its CLI, not a metered API key). A provider that called an HTTP API directly
 * would need a different shape than this.
 */

import { spawn } from "node:child_process";
import { buildSubprocessEnv, parseReviewJson, type ReviewResult } from "./review.ts";
import { createClaudeProvider } from "./providers/claude.ts";

/** Knobs for a single review run. The provider maps these to its own CLI flags. */
export type ReviewRunOpts = {
  maxTurns?: number;   // turn budget; defaults to 1 (a single diff-only pass)
  addDir?: string;    // deep review: grant the CLI read access to this checked-out dir
  deep?: boolean;     // deep review: provider restricts itself to read-only tools
};

/** The provider-specific surface — everything that differs between review CLIs. */
export interface ReviewProvider {
  readonly name: string;                          // "claude"
  readonly command: string;                       // binary to spawn, e.g. "claude"
  readonly envAllowlist: readonly string[];       // secrets/infra vars it may inherit
  /** Boot-time config check; throw to fail fast (e.g. reject a conflicting key). */
  validateConfig(env: NodeJS.ProcessEnv): void;
  /** Build the CLI argv for one run. */
  buildArgs(opts: ReviewRunOpts): string[];
  /** Unwrap the CLI's stdout envelope into the model's raw text reply. */
  parseReply(stdout: string): string;
}

/**
 * Spawn a CLI, feed `stdin` on its standard input (NOT as an argv — a diff can
 * exceed the OS arg-length limit), and resolve with its stdout. Generic over the
 * provider's command; mirrors the error contract the Claude path used before.
 */
function spawnText(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(0, 1000)}`));
    });
    child.stdin.on("error", reject); // e.g. EPIPE if the CLI exits before reading it all
    child.stdin.end(stdin);
  });
}

/**
 * Run one review through a provider: build the minimal subprocess env, spawn the
 * CLI with the prompt on stdin, then parse its reply into a ReviewResult via the
 * shared JSON contract. The only provider-specific steps are buildArgs/parseReply.
 */
export async function runReview(
  provider: ReviewProvider,
  prompt: string,
  opts: ReviewRunOpts = {},
): Promise<ReviewResult> {
  const env = buildSubprocessEnv(process.env, provider.envAllowlist);
  const stdout = await spawnText(provider.command, provider.buildArgs(opts), env, prompt);
  return parseReviewJson(provider.parseReply(stdout));
}

/**
 * Pick the review provider by name (AI_PROVIDER), defaulting to Claude so existing
 * deploys are unaffected. Unknown names fail loudly rather than silently no-op.
 */
export function selectProvider(name: string | undefined): ReviewProvider {
  const key = (name ?? "claude").trim().toLowerCase();
  switch (key) {
    case "claude":
      return createClaudeProvider(process.env);
    default:
      throw new Error(`Unknown AI_PROVIDER ${JSON.stringify(name)} — supported: "claude".`);
  }
}
