import { test } from "node:test";
import assert from "node:assert/strict";
import { installationAuthHeader } from "../clone.ts";

test("installationAuthHeader base64-encodes x-access-token:<token>", () => {
  const header = installationAuthHeader("ghs_secret123");
  const expected = Buffer.from("x-access-token:ghs_secret123").toString("base64");
  assert.equal(header, `AUTHORIZATION: basic ${expected}`);
});

test("the raw token never appears in the header (only its base64 form)", () => {
  // Guards the security property: the token is encoded, so a value that leaks the
  // header (e.g. a log line) doesn't directly expose the token string.
  const header = installationAuthHeader("ghs_topsecret");
  assert.ok(!header.includes("ghs_topsecret"));
});
