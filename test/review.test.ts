import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeArgs,
  buildContextPrompt,
  buildDiffPrompt,
  parseReviewResult,
  shouldDeepReview,
  stripFences,
} from "../review.ts";

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

test("parseReviewResult unwraps the Claude Code envelope and parses (fenced) JSON", () => {
  const envelope = JSON.stringify({
    result: '```json\n{"summary":"looks fine","comments":[]}\n```',
    other: "ignored",
  });
  const result = parseReviewResult(envelope);
  assert.equal(result.summary, "looks fine");
  assert.deepEqual(result.comments, []);
});
