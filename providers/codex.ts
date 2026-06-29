import { Codex, type CodexOptions, type ThreadOptions, type TurnOptions } from "@openai/codex-sdk";
import { parseReviewJson, type ReviewResult } from "../review.ts";
import type { ReviewProvider, ReviewRunOpts } from "../provider.ts";
import { BASE_ENV_ALLOWLIST, buildSubprocessEnv } from "../runtime/spawn.ts";
import schema from "./codex-review.schema.json" with { type: "json" };

export const CODEX_ENV_ALLOWLIST = [
  ...BASE_ENV_ALLOWLIST,
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "CODEX_CA_CERTIFICATE",
  "RUST_LOG",
] as const;

type CodexThread = {
  run(input: string, options?: TurnOptions): Promise<{ finalResponse: string }>;
};

type CodexClient = {
  startThread(options?: ThreadOptions): CodexThread;
};

type CodexClientFactory = (options: CodexOptions) => CodexClient;

export type CodexProviderDeps = {
  createClient?: CodexClientFactory;
};

function codexEnvAllowlist(env: NodeJS.ProcessEnv): readonly string[] {
  return env.CODEX_API_KEY?.trim()
    ? CODEX_ENV_ALLOWLIST.filter((key) => key !== "CODEX_ACCESS_TOKEN")
    : CODEX_ENV_ALLOWLIST;
}

function codexClientOptions(env: NodeJS.ProcessEnv): CodexOptions {
  const subprocessEnv = buildSubprocessEnv(env, codexEnvAllowlist(env));
  const apiKey = env.CODEX_API_KEY?.trim();
  const profile = env.CODEX_PROFILE?.trim();
  const config: NonNullable<CodexOptions["config"]> = {};

  if (profile) config.profile = profile;

  return {
    env: subprocessEnv,
    ...(apiKey ? { apiKey } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

function threadOptions(env: NodeJS.ProcessEnv, opts: ReviewRunOpts): ThreadOptions {
  const model = env.CODEX_MODEL?.trim();
  return {
    sandboxMode: "read-only",
    approvalPolicy: "never",
    ...(model ? { model } : {}),
    ...(opts.addDir ? { workingDirectory: opts.addDir, additionalDirectories: [opts.addDir] } : {}),
  };
}

export function createCodexProvider(env: NodeJS.ProcessEnv, deps: CodexProviderDeps = {}): ReviewProvider {
  const createClient = deps.createClient ?? ((options: CodexOptions) => new Codex(options));

  return {
    name: "codex",

    validateConfig(e: NodeJS.ProcessEnv): void {
      const hasExplicitAuth = Boolean(e.CODEX_API_KEY?.trim() || e.CODEX_ACCESS_TOKEN?.trim());
      const hasConfiguredHome = Boolean(e.CODEX_HOME?.trim());
      if (!hasExplicitAuth && !hasConfiguredHome) {
        console.warn(
          "AI_PROVIDER=codex without CODEX_API_KEY, CODEX_ACCESS_TOKEN, or CODEX_HOME; " +
            "falling back to Codex's default ~/.codex auth/config. Ensure the host has run `codex login`.",
        );
      }
    },

    async run(prompt: string, opts: ReviewRunOpts = {}): Promise<ReviewResult> {
      const client = createClient(codexClientOptions(env));
      const thread = client.startThread(threadOptions(env, opts));
      const turn = await thread.run(prompt, { outputSchema: schema });
      return parseReviewJson(turn.finalResponse);
    },
  };
}

export const __test = {
  codexClientOptions,
  codexEnvAllowlist,
  threadOptions,
};
