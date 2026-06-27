import { test } from "node:test";
import assert from "node:assert/strict";
import { createGithubProvider, loadAppPrivateKey } from "../repositories/github.ts";

const FULL_ENV = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRET: "whsec_test",
  REVIEWER_LOGIN: "ayewobot",
};

test("the factory constructs without throwing on an empty env (App is built lazily in init)", () => {
  assert.doesNotThrow(() => createGithubProvider({}));
});

test("validateConfig requires the App credentials", () => {
  const provider = createGithubProvider(FULL_ENV);
  for (const missing of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"] as const) {
    const env = { ...FULL_ENV, [missing]: undefined };
    assert.throws(() => createGithubProvider(env).validateConfig(env), new RegExp(`${missing} must be set`));
  }
  assert.doesNotThrow(() => provider.validateConfig(FULL_ENV));
});

test("validateConfig requires at least one REVIEWER_LOGIN", () => {
  const env = { ...FULL_ENV, REVIEWER_LOGIN: "  ,  " };
  assert.throws(() => createGithubProvider(env).validateConfig(env), /REVIEWER_LOGIN must list at least one login/);
});

test("parseWebhook rejects a delivery missing the signature header (→ 400)", async () => {
  const provider = createGithubProvider(FULL_ENV);
  await assert.rejects(
    () => provider.parseWebhook({ "x-github-event": "pull_request" }, Buffer.from("{}")),
    /missing X-Hub-Signature-256/,
  );
});

test("loadAppPrivateKey passes through a real PEM and un-escapes \\n one-liners", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJ\n-----END RSA PRIVATE KEY-----";
  assert.equal(loadAppPrivateKey(pem), pem, "real-newline PEM is left intact");
  const escaped = "-----BEGIN RSA PRIVATE KEY-----\\nMIIBOgIBAAJ\\n-----END RSA PRIVATE KEY-----";
  assert.equal(loadAppPrivateKey(escaped), pem, "\\n escapes become real newlines");
});

test("loadAppPrivateKey base64-decodes a key with no BEGIN marker", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJ\n-----END RSA PRIVATE KEY-----";
  const b64 = Buffer.from(pem).toString("base64");
  assert.equal(loadAppPrivateKey(b64), pem, "base64(PEM) is decoded back to the PEM");
});
