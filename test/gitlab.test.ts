import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleUnifiedDiff,
  buildPosition,
  createGitlabProvider,
  idsWithout,
  parseMergeRequestEvent,
  unassignBotJson,
  type DiffRefs,
  type GitlabDiffFile,
} from "../repositories/gitlab.ts";

const BOT = 88;

function mrPayload(overrides: Record<string, unknown> = {}): any {
  return {
    object_kind: "merge_request",
    project: { id: 100, path_with_namespace: "group/sub/widgets" },
    object_attributes: {
      iid: 42,
      action: "update",
      title: "Add retry to uploader",
      description: "Fixes flaky uploads",
      last_commit: { id: "deadbeef" },
      reviewer_ids: [55, BOT],
      assignee_ids: [],
      labels: [{ title: "deep-review" }],
    },
    reviewers: [
      { id: 55, username: "alice" },
      { id: BOT, username: "review-bot", re_requested: false },
    ],
    assignees: [],
    changes: { reviewers: { previous: [{ id: 55 }], current: [{ id: 55 }, { id: BOT }] } },
    ...overrides,
  };
}

test("parseMergeRequestEvent fires when the bot is newly added as a reviewer", () => {
  const parsed = parseMergeRequestEvent(mrPayload(), BOT);
  assert.ok(parsed, "should trigger");
  assert.equal(parsed.triggeredBy, "reviewer");
  assert.deepEqual(parsed.ref, { owner: "group/sub", repo: "widgets", pull_number: 42, head_sha: "deadbeef" });
  assert.equal(parsed.projectId, 100);
  assert.equal(parsed.mrIid, 42);
  assert.deepEqual(parsed.labels, ["deep-review"]);
  assert.deepEqual(parsed.intent, { title: "Add retry to uploader", body: "Fixes flaky uploads" });
  assert.deepEqual(parsed.reviewerIds, [55, BOT]);
});

test("parseMergeRequestEvent fires when the bot is newly added as an assignee", () => {
  const payload = mrPayload({
    reviewers: [{ id: 55, username: "alice" }],
    assignees: [{ id: BOT, username: "review-bot" }],
    object_attributes: { ...mrPayload().object_attributes, reviewer_ids: [55], assignee_ids: [BOT] },
    changes: { assignees: { previous: [], current: [{ id: BOT }] } },
  });
  const parsed = parseMergeRequestEvent(payload, BOT);
  assert.ok(parsed);
  assert.equal(parsed.triggeredBy, "assignee");
  assert.deepEqual(parsed.assigneeIds, [BOT]);
});

test("parseMergeRequestEvent fires on a re-request even without a membership change", () => {
  const payload = mrPayload({
    reviewers: [{ id: 55, username: "alice" }, { id: BOT, username: "review-bot", re_requested: true }],
    changes: {}, // no reviewer delta — the bot was already a reviewer
  });
  const parsed = parseMergeRequestEvent(payload, BOT);
  assert.ok(parsed);
  assert.equal(parsed.triggeredBy, "reviewer");
});

test("parseMergeRequestEvent fires on 'open' when the bot is already a reviewer (no changes block)", () => {
  const payload = mrPayload({
    object_attributes: { ...mrPayload().object_attributes, action: "open" },
    changes: {},
  });
  const parsed = parseMergeRequestEvent(payload, BOT);
  assert.ok(parsed);
  assert.equal(parsed.triggeredBy, "reviewer");
});

test("parseMergeRequestEvent ignores events that don't add the bot", () => {
  // Bot already present before and after — not a fresh request.
  const unchanged = mrPayload({ changes: { reviewers: { previous: [{ id: 55 }, { id: BOT }], current: [{ id: 55 }, { id: BOT }] } } });
  assert.equal(parseMergeRequestEvent(unchanged, BOT), null);
  // A different reviewer was added, not the bot.
  const someoneElse = mrPayload({ changes: { reviewers: { previous: [{ id: 55 }], current: [{ id: 55 }, { id: 77 }] } } });
  assert.equal(parseMergeRequestEvent(someoneElse, BOT), null);
});

test("parseMergeRequestEvent ignores non-MR payloads and non-trigger actions", () => {
  assert.equal(parseMergeRequestEvent({ object_kind: "push" }, BOT), null);
  assert.equal(parseMergeRequestEvent(mrPayload({ object_attributes: { ...mrPayload().object_attributes, action: "merge" } }), BOT), null);
  assert.equal(parseMergeRequestEvent(mrPayload({ object_attributes: { ...mrPayload().object_attributes, action: "close" } }), BOT), null);
});

test("assembleUnifiedDiff synthesizes git/---/+++ headers and concatenates hunks", () => {
  const files: GitlabDiffFile[] = [
    { old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new\n" },
    { old_path: "new.ts", new_path: "new.ts", diff: "@@ -0,0 +1 @@\n+hi", new_file: true },
    { old_path: "gone.ts", new_path: "gone.ts", diff: "@@ -1 +0,0 @@\n-bye\n", deleted_file: true },
  ];
  const out = assembleUnifiedDiff(files);
  assert.ok(out.includes("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@"));
  assert.ok(out.includes("--- /dev/null\n+++ b/new.ts\n"), "added file uses /dev/null old side");
  assert.ok(out.includes("--- a/gone.ts\n+++ /dev/null\n"), "deleted file uses /dev/null new side");
  assert.ok(out.includes("+hi\n"), "a hunk missing a trailing newline gets one");
});

test("buildPosition anchors RIGHT comments on new_line and LEFT on old_line", () => {
  const refs: DiffRefs = { base_sha: "b", start_sha: "s", head_sha: "h" };
  const right = buildPosition({ path: "a.ts", line: 18, side: "RIGHT", body: "x" }, refs);
  assert.deepEqual(right, {
    position_type: "text",
    base_sha: "b",
    start_sha: "s",
    head_sha: "h",
    old_path: "a.ts",
    new_path: "a.ts",
    new_line: 18,
  });
  const left = buildPosition({ path: "a.ts", line: 7, side: "LEFT", body: "x" }, refs);
  assert.equal(left.old_line, 7);
  assert.ok(!("new_line" in left), "LEFT comment carries no new_line");
});

test("buildPosition defaults to RIGHT when side is omitted", () => {
  const refs: DiffRefs = { base_sha: "b", start_sha: "s", head_sha: "h" };
  const pos = buildPosition({ path: "a.ts", line: 3, body: "x" }, refs);
  assert.equal(pos.new_line, 3);
});

test("idsWithout drops only the bot from the full reviewer set", () => {
  assert.deepEqual(idsWithout([55, 88, 99], 88), [55, 99]);
  assert.deepEqual(idsWithout([88], 88), [], "removing the sole reviewer yields an empty set");
  assert.deepEqual(idsWithout([55], 88), [55], "no-op when the bot isn't present");
});

test("unassignBotJson clears only the field(s) the bot is actually in", () => {
  // Reviewer only.
  assert.deepEqual(unassignBotJson([55, 88], [], 88), { reviewer_ids: [55] });
  // Assignee only.
  assert.deepEqual(unassignBotJson([55], [88], 88), { assignee_ids: [] });
  // Both — the bug the review caught: clear from both, not just the trigger field.
  assert.deepEqual(unassignBotJson([55, 88], [88, 99], 88), { reviewer_ids: [55], assignee_ids: [99] });
  // Neither — nothing to PUT.
  assert.deepEqual(unassignBotJson([55], [99], 88), {});
});

test("assembleUnifiedDiff does not double-emit headers a hunk already carries", () => {
  const prefixed: GitlabDiffFile = {
    old_path: "a.ts",
    new_path: "a.ts",
    diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  };
  const out = assembleUnifiedDiff([prefixed]);
  assert.equal(out, prefixed.diff, "an already-headed hunk passes through untouched");
  assert.equal(out.match(/diff --git/g)?.length, 1, "exactly one git header");
});

test("the GitLab factory constructs without throwing on an empty env", () => {
  assert.doesNotThrow(() => createGitlabProvider({}));
});

test("validateConfig requires the token and webhook secret", () => {
  assert.throws(() => createGitlabProvider({}).validateConfig({}), /GITLAB_TOKEN must be set/);
  assert.throws(
    () => createGitlabProvider({}).validateConfig({ GITLAB_TOKEN: "glpat-x" }),
    /GITLAB_WEBHOOK_SECRET must be set/,
  );
  assert.doesNotThrow(() =>
    createGitlabProvider({}).validateConfig({ GITLAB_TOKEN: "glpat-x", GITLAB_WEBHOOK_SECRET: "s" }),
  );
});

test("parseWebhook rejects a mismatched X-Gitlab-Token (→ 400)", async () => {
  const provider = createGitlabProvider({ GITLAB_TOKEN: "glpat-x", GITLAB_WEBHOOK_SECRET: "right-secret" });
  await assert.rejects(
    () => provider.parseWebhook({ "x-gitlab-token": "wrong-secret" }, Buffer.from("{}")),
    /invalid X-Gitlab-Token/,
  );
  await assert.rejects(
    () => provider.parseWebhook({}, Buffer.from("{}")),
    /invalid X-Gitlab-Token/,
    "a missing token is also rejected",
  );
});

test("parseWebhook accepts the token but ignores non-MR events", async () => {
  const provider = createGitlabProvider({ GITLAB_TOKEN: "glpat-x", GITLAB_WEBHOOK_SECRET: "s" });
  const result = await provider.parseWebhook(
    { "x-gitlab-token": "s", "x-gitlab-event": "Push Hook" },
    Buffer.from("{}"),
  );
  assert.equal(result, null);
});
