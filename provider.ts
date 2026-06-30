import type { ReviewResult } from "./review.ts";
import { createClaudeProvider } from "./providers/claude.ts";
import { createCodexProvider } from "./providers/codex.ts";

export type ReviewRunOpts = {
  maxTurns?: number;
  addDir?: string;
  deep?: boolean;
};

export interface ReviewProvider {
  readonly name: string;
  validateConfig(env: NodeJS.ProcessEnv): void;
  run(prompt: string, opts?: ReviewRunOpts): Promise<ReviewResult>;
}

export async function runReview(
  provider: ReviewProvider,
  prompt: string,
  opts: ReviewRunOpts = {},
): Promise<ReviewResult> {
  return provider.run(prompt, opts);
}

export function selectProvider(name: string | undefined): ReviewProvider {
  const key = (name?.trim() || "claude").toLowerCase();
  switch (key) {
    case "claude":
      return createClaudeProvider(process.env);
    case "codex":
      return createCodexProvider(process.env);
    default:
      throw new Error(`Unknown AI_PROVIDER ${JSON.stringify(name)} — supported: "claude", "codex".`);
  }
}
