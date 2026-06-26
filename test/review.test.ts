import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeArgs,
  buildContextPrompt,
  buildDiffPrompt,
  buildReviewHeader,
  buildSubprocessEnv,
  CLAUDE_ENV_ALLOWLIST,
  GIT_ENV_ALLOWLIST,
  parsePositiveInt,
  parseReviewResult,
  shouldDeepReview,
  stripFences,
} from "../review.ts";

test("buildReviewHeader marks a deep review with the bot name, badge, and summary", () => {
  const header = buildReviewHeader("Alátùńwò AI", true, "Looks solid.");
  assert.ok(header.includes("**Alátùńwò AI review**"), "bot name in title");
  assert.ok(header.includes("🔬 Deep"), "deep badge");
  assert.ok(header.toLowerCase().includes("full repository context"), "deep caption");
  assert.ok(header.endsWith("Looks solid."), "summary appended");
});

test("buildReviewHeader marks a diff-only review distinctly", () => {
  const header = buildReviewHeader("Alátùńwò AI", false, "Nits only.");
  assert.ok(header.includes("📄 Diff-only"), "diff-only badge");
  assert.ok(header.includes("diff only"), "diff-only caption");
  assert.ok(!header.includes("🔬 Deep"), "must not claim deep");
});

test("buildReviewHeader handles an empty summary without trailing noise", () => {
  const header = buildReviewHeader("Bot", false, "");
  assert.ok(header.includes("**Bot review**"));
  assert.ok(header.endsWith("_\n\n"), "ends after the caption when there's no summary");
});

test("parsePositiveInt accepts positive integers (trimming whitespace)", () => {
  assert.equal(parsePositiveInt("8", "X"), 8);
  assert.equal(parsePositiveInt(" 12 ", "X"), 12);
});

test("parsePositiveInt rejects empty, non-numeric, fractional, and non-positive values", () => {
  for (const bad of ["", "abc", "8.5", "0", "-3", "NaN"]) {
    assert.throws(() => parsePositiveInt(bad, "DEEP_REVIEW_MAX_TURNS"), /DEEP_REVIEW_MAX_TURNS must be a positive integer/);
  }
});

test("shouldDeepReview: env default off, no label → shallow", () => {
  assert.equal(shouldDeepReview(false, []), false);
  assert.equal(shouldDeepReview(false, ["bug", "wip"]), false);
});

test("shouldDeepReview: the deep-review label opts a PR in (case-insensitive)", () => {
  assert.equal(shouldDeepReview(false, ["deep-review"]), true);
  assert.equal(shouldDeepReview(false, ["Deep-Review"]), true);
  assert.equal(shouldDeepReview(false, ["bug", "deep-review"]), true);
});

test("shouldDeepReview: env default on applies to every PR regardless of labels", () => {
  assert.equal(shouldDeepReview(true, []), true);
  assert.equal(shouldDeepReview(true, ["chore"]), true);
});

test("buildClaudeArgs defaults to a single diff-only pass", () => {
  const args = buildClaudeArgs("claude-sonnet-4-6");
  assert.deepEqual(args, [
    "-p", "--output-format", "json", "--max-turns", "1", "--model", "claude-sonnet-4-6",
  ]);
  assert.ok(!args.includes("--add-dir"), "no working dir by default");
  assert.ok(!args.includes("--allowedTools"), "no tool restriction by default");
});

test("buildClaudeArgs wires deep-review options (dir + read-only tools)", () => {
  const args = buildClaudeArgs("opus", {
    maxTurns: 8,
    addDir: "/tmp/clone",
    allowedTools: ["Read", "Grep", "Glob"],
  });
  assert.equal(args[args.indexOf("--max-turns") + 1], "8");
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/clone");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Read,Grep,Glob");
  // Read-only: nothing that could execute or mutate repo code.
  assert.ok(!args.join(" ").match(/Bash|Write|Edit/), "deep review tools stay read-only");
});

test("an empty allowedTools list is omitted, not passed as an empty flag", () => {
  const args = buildClaudeArgs("m", { allowedTools: [] });
  assert.ok(!args.includes("--allowedTools"));
});

test("both prompts embed the diff and the JSON output contract", () => {
  const diff = "diff --git a/x b/x\n+const y = 1;";
  for (const prompt of [buildDiffPrompt(diff), buildContextPrompt(diff, "/tmp/clone")]) {
    assert.ok(prompt.includes(diff), "diff is included");
    assert.ok(prompt.includes('"summary"'), "schema is described");
    assert.ok(prompt.includes("Only comment on lines that appear in the diff"), "rules included");
  }
});

test("buildContextPrompt points Claude at the checked-out repo path", () => {
  const prompt = buildContextPrompt("d", "/tmp/clone-abc");
  assert.ok(prompt.includes("/tmp/clone-abc"));
  assert.ok(prompt.toLowerCase().includes("checked out"));
});

test("stripFences removes a ```json fence", () => {
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFences('{"a":1}'), '{"a":1}', "leaves unfenced text alone");
});

test("buildSubprocessEnv forwards only allowlisted vars that are present", () => {
  const env = buildSubprocessEnv(
    { PATH: "/usr/bin", HOME: "/home/app", UNLISTED: "nope" },
    ["PATH", "HOME", "TMPDIR"],
  );
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/app" });
  assert.ok(!("UNLISTED" in env), "non-allowlisted var dropped");
  assert.ok(!("TMPDIR" in env), "allowlisted-but-absent var is not set to undefined");
});

test("buildSubprocessEnv merges extra vars, which override the allowlisted source", () => {
  const env = buildSubprocessEnv(
    { PATH: "/usr/bin", HOME: "/old" },
    ["PATH", "HOME"],
    { HOME: "/new", GIT_TERMINAL_PROMPT: "0" },
  );
  assert.equal(env.HOME, "/new", "extra overrides source");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0", "extra var added");
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

test("the git subprocess env never carries the Claude token or service secrets", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/app",
    CLAUDE_CODE_OAUTH_TOKEN: "claude_oauth_real",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
  };
  const env = buildSubprocessEnv(source, GIT_ENV_ALLOWLIST);
  assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in env), "git has no business with the Claude token");
  assert.ok(!("GITHUB_APP_PRIVATE_KEY" in env), "git never sees the app private key");
  assert.equal(env.PATH, "/usr/bin", "git still gets PATH to be found/run");
});

test("parseReviewResult unwraps the Claude Code envelope and parses (fenced) JSON", () => {
  const envelope = JSON.stringify({
    result: '```json\n{"summary":"looks fine","comments":[]}\n```',
    other: "ignored",
  });
  const result = parseReviewResult(envelope);
  assert.equal(result.summary, "looks fine");
  assert.deepEqual(result.comments, []);
});
