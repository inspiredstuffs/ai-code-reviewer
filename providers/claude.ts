/**
 * Claude provider — drives the Claude Code CLI (`claude -p`) on a subscription
 * token. The default (and currently only) ReviewProvider implementation. Pure
 * construction: createClaudeProvider takes the env so it's testable without the
 * real environment.
 */

import { BASE_ENV_ALLOWLIST } from "../review.ts";
import type { ReviewProvider, ReviewRunOpts } from "../provider.ts";

/** Default model when CLAUDE_MODEL is unset. */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Read-only tools granted during a deep review. No Bash/Write/Edit, so untrusted
 * PR code that's been checked out can be read for context but never executed.
 */
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

/**
 * Env the `claude` subprocess may inherit. It's driven by untrusted PR content and
 * its output is posted publicly, so it gets base infra vars plus ONLY the
 * subscription token — never the GitHub App key, webhook secret, or ANTHROPIC_API_KEY.
 */
export const CLAUDE_ENV_ALLOWLIST = [...BASE_ENV_ALLOWLIST, "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/** Build a Claude provider bound to the configured model. */
export function createClaudeProvider(env: NodeJS.ProcessEnv): ReviewProvider {
  const model = env.CLAUDE_MODEL?.trim() || DEFAULT_MODEL;

  return {
    name: "claude",
    command: "claude",
    envAllowlist: CLAUDE_ENV_ALLOWLIST,

    validateConfig(e: NodeJS.ProcessEnv): void {
      // Auth must flow through CLAUDE_CODE_OAUTH_TOKEN (the subscription). A stray
      // ANTHROPIC_API_KEY would take precedence and silently move usage onto metered
      // API billing, so refuse to start rather than bill the wrong way.
      if (e.ANTHROPIC_API_KEY) {
        throw new Error(
          "ANTHROPIC_API_KEY must not be set: it overrides CLAUDE_CODE_OAUTH_TOKEN and moves " +
            "usage onto metered API billing. Unset it and use the subscription token instead.",
        );
      }
    },

    buildArgs(opts: ReviewRunOpts): string[] {
      const args = [
        "-p",
        "--output-format", "json",
        "--max-turns", String(opts.maxTurns ?? 1),
        "--model", model,
      ];
      if (opts.addDir) args.push("--add-dir", opts.addDir);
      if (opts.deep) args.push("--allowedTools", READ_ONLY_TOOLS.join(","));
      return args;
    },

    parseReply(stdout: string): string {
      // Claude Code wraps the model's reply in an envelope ({ result, ... }); the
      // reply itself is the review JSON (possibly fenced), parsed by parseReviewJson.
      const envelope = JSON.parse(stdout);
      return String(envelope.result ?? "").trim();
    },
  };
}
