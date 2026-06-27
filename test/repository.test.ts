import { test } from "node:test";
import assert from "node:assert/strict";
import { headerValue, refKey, selectRepositoryProvider } from "../repository.ts";

test("selectRepositoryProvider returns GitHub by default and for 'github'", () => {
  assert.equal(selectRepositoryProvider(undefined).name, "github");
  assert.equal(selectRepositoryProvider("github").name, "github");
  assert.equal(selectRepositoryProvider("  GitHub  ").name, "github", "trimmed + case-insensitive");
});

test("selectRepositoryProvider returns GitLab for 'gitlab'", () => {
  assert.equal(selectRepositoryProvider("gitlab").name, "gitlab");
});

test("selectRepositoryProvider fails loudly on an unknown provider name", () => {
  assert.throws(() => selectRepositoryProvider("bitbucket"), /Unknown REPO_PROVIDER/);
});

test("each provider exposes a distinct webhook path and change noun", () => {
  const gh = selectRepositoryProvider("github");
  const gl = selectRepositoryProvider("gitlab");
  assert.equal(gh.webhookPath, "/api/github/webhooks");
  assert.equal(gl.webhookPath, "/api/gitlab/webhooks");
  assert.equal(gh.changeNoun, "pull request");
  assert.equal(gl.changeNoun, "merge request");
});

test("refKey renders a stable, human-readable label", () => {
  assert.equal(
    refKey({ owner: "acme", repo: "widgets", pull_number: 42, head_sha: "abc123" }),
    "acme/widgets#42@abc123",
  );
});

test("headerValue collapses the array form Node uses for repeated headers", () => {
  assert.equal(headerValue({ "x-gitlab-event": "Merge Request Hook" }, "x-gitlab-event"), "Merge Request Hook");
  assert.equal(headerValue({ "set-cookie": ["a", "b"] }, "set-cookie"), "a");
  assert.equal(headerValue({}, "x-missing"), undefined);
});
