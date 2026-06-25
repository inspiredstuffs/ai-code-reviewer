import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewStore, type ReviewRef } from "../store.ts";

const REF: ReviewRef = {
  owner: "acme",
  repo: "widgets",
  pull_number: 7,
  head_sha: "abc123",
};
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";

/** Each test gets its own in-memory DB so they don't share state. */
function freshStore(): ReviewStore {
  return new ReviewStore(":memory:");
}

test("reserve claims a new head SHA exactly once", () => {
  const store = freshStore();
  assert.equal(store.reserve(REF, "bot", T0), true, "first reserve should claim");
  assert.equal(store.reserve(REF, "bot", T1), false, "second reserve should skip");
  assert.equal(store.get(REF)?.status, "pending");
  store.close();
});

test("the same SHA on a different PR is reviewed independently", () => {
  const store = freshStore();
  assert.equal(store.reserve(REF, "bot", T0), true);
  const otherPr: ReviewRef = { ...REF, pull_number: 8 };
  assert.equal(store.reserve(otherPr, "bot", T0), true, "different PR is a different key");
  store.close();
});

test("markPosted records the outcome and blocks re-review", () => {
  const store = freshStore();
  store.reserve(REF, "bot", T0);
  store.markPosted(REF, "looks good", 3, T1);

  const row = store.get(REF);
  assert.equal(row?.status, "posted");
  assert.equal(row?.summary, "looks good");
  assert.equal(row?.comment_count, 3);
  assert.equal(row?.completed_at, T1);
  assert.equal(store.reserve(REF, "bot", T1), false, "a posted SHA is never re-reviewed");
  store.close();
});

test("a failed review can be retried by re-requesting", () => {
  const store = freshStore();
  store.reserve(REF, "bot", T0);
  store.markFailed(REF, "claude exited with code 1", T1);
  assert.equal(store.get(REF)?.status, "failed");

  // Re-request: reserve should reclaim the failed row and let it retry.
  assert.equal(store.reserve(REF, "bot", T1), true, "failed SHA should be retryable");
  const row = store.get(REF);
  assert.equal(row?.status, "pending", "retry resets status to pending");
  assert.equal(row?.error, null, "retry clears the prior error");
  assert.equal(row?.completed_at, null);
  store.close();
});

test("recoverOrphans fails rows left pending by a crashed process", () => {
  const store = freshStore();
  store.reserve(REF, "bot", T0); // left pending — simulates a mid-review crash

  const recovered = store.recoverOrphans(T1);
  assert.equal(recovered, 1);
  assert.equal(store.get(REF)?.status, "failed");
  // And the orphaned (now failed) review is retryable.
  assert.equal(store.reserve(REF, "bot", T1), true);
  store.close();
});

test("recoverOrphans leaves posted and failed rows untouched", () => {
  const store = freshStore();
  store.reserve(REF, "bot", T0);
  store.markPosted(REF, "ok", 0, T1);

  assert.equal(store.recoverOrphans(T1), 0, "nothing pending to recover");
  assert.equal(store.get(REF)?.status, "posted");
  store.close();
});
