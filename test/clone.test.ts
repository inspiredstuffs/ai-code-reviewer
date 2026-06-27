import { test } from "node:test";
import assert from "node:assert/strict";
import { basicAuthHeader } from "../clone.ts";

test("basicAuthHeader base64-encodes <user>:<token> (GitHub x-access-token)", () => {
  const header = basicAuthHeader("x-access-token", "ghs_secret123");
  const expected = Buffer.from("x-access-token:ghs_secret123").toString("base64");
  assert.equal(header, `AUTHORIZATION: basic ${expected}`);
});

test("basicAuthHeader supports the GitLab oauth2 username", () => {
  const header = basicAuthHeader("oauth2", "glpat-secret123");
  const expected = Buffer.from("oauth2:glpat-secret123").toString("base64");
  assert.equal(header, `AUTHORIZATION: basic ${expected}`);
});

test("the raw token never appears in the header (only its base64 form)", () => {
  // Guards the security property: the token is encoded, so a value that leaks the
  // header (e.g. a log line) doesn't directly expose the token string.
  for (const header of [basicAuthHeader("x-access-token", "ghs_topsecret"), basicAuthHeader("oauth2", "glpat_topsecret")]) {
    assert.ok(!header.includes("topsecret"));
  }
});
