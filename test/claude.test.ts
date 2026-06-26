import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSubprocessEnv } from "../review.ts";
import { selectProvider } from "../provider.ts";
import { createClaudeProvider, CLAUDE_ENV_ALLOWLIST } from "../providers/claude.ts";

test("claude buildArgs defaults to a single diff-only pass on the default model", () => {
  const args = createClaudeProvider({}).buildArgs({});
  assert.deepEqual(args, [
    "-p", "--output-format", "json", "--max-turns", "1", "--model", "claude-sonnet-4-6",
  ]);
  assert.ok(!args.includes("--add-dir"), "no working dir by default");
  assert.ok(!args.includes("--allowedTools"), "no tool restriction by default");
});

test("claude buildArgs honours CLAUDE_MODEL", () => {
  const args = createClaudeProvider({ CLAUDE_MODEL: "claude-opus-4-8" }).buildArgs({});
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-4-8");
});

test("claude buildArgs wires a deep review (dir + read-only tools, turn budget)", () => {
  const args = createClaudeProvider({}).buildArgs({ maxTurns: 8, addDir: "/tmp/clone", deep: true });
  assert.equal(args[args.indexOf("--max-turns") + 1], "8");
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/clone");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Read,Grep,Glob");
  // Read-only: nothing that could execute or mutate the checked-out PR code.
  assert.ok(!args.join(" ").match(/Bash|Write|Edit/), "deep review tools stay read-only");
});

test("claude parseReply unwraps the Claude Code envelope to the model's text", () => {
  const stdout = JSON.stringify({ result: '```json\n{"summary":"ok"}\n```', other: "ignored" });
  assert.equal(createClaudeProvider({}).parseReply(stdout), '```json\n{"summary":"ok"}\n```');
});

test("claude validateConfig rejects ANTHROPIC_API_KEY (would bypass the subscription)", () => {
  const provider = createClaudeProvider({});
  assert.throws(() => provider.validateConfig({ ANTHROPIC_API_KEY: "sk-ant-x" }), /ANTHROPIC_API_KEY must not be set/);
  assert.doesNotThrow(() => provider.validateConfig({ CLAUDE_CODE_OAUTH_TOKEN: "claude_oauth_x" }));
});

test("the claude subprocess env carries the OAuth token but never the service secrets", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/app",
    CLAUDE_CODE_OAUTH_TOKEN: "claude_oauth_real",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
    GITHUB_WEBHOOK_SECRET: "whsec_real",
    GITHUB_APP_ID: "123456",
    ANTHROPIC_API_KEY: "sk-ant-should-never-leak",
  };
  const env = buildSubprocessEnv(source, CLAUDE_ENV_ALLOWLIST);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "claude_oauth_real", "subscription token forwarded");
  for (const secret of ["GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "ANTHROPIC_API_KEY"]) {
    assert.ok(!(secret in env), `${secret} must not reach the reviewer subprocess`);
  }
});

test("selectProvider returns the Claude provider for 'claude' and by default", () => {
  assert.equal(selectProvider("claude").name, "claude");
  assert.equal(selectProvider(undefined).name, "claude");
  assert.equal(selectProvider("  CLAUDE  ").name, "claude", "trimmed + case-insensitive");
});

test("selectProvider fails loudly on an unknown provider name", () => {
  assert.throws(() => selectProvider("codex"), /Unknown AI_PROVIDER/);
});
