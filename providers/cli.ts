import type { ReviewProvider, ReviewRunOpts } from "../provider.ts";
import { parseReviewJson, type ReviewResult } from "../review.ts";
import { buildSubprocessEnv, spawnText } from "../runtime/spawn.ts";

export type CliProviderConfig = {
  name: string;
  command: string;
  envAllowlist: readonly string[];
  sourceEnv?: NodeJS.ProcessEnv;
  validateConfig?(env: NodeJS.ProcessEnv): void;
  buildArgs(opts: ReviewRunOpts): string[];
  parseReply(stdout: string): string;
};

/**
 * Default adapter for providers backed by a CLI that accepts the review prompt on
 * stdin and prints a parseable response to stdout.
 */
export function createCliBackedProvider(config: CliProviderConfig): ReviewProvider {
  return {
    name: config.name,

    validateConfig(env: NodeJS.ProcessEnv): void {
      config.validateConfig?.(env);
    },

    async run(prompt: string, opts: ReviewRunOpts = {}): Promise<ReviewResult> {
      const env = buildSubprocessEnv(config.sourceEnv ?? process.env, config.envAllowlist);
      const stdout = await spawnText(config.command, config.buildArgs(opts), env, prompt);
      return parseReviewJson(config.parseReply(stdout));
    },
  };
}
