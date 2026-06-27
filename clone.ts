/**
 * Check out a change's head commit into a throwaway working directory so a deep
 * review can read surrounding files. Host-agnostic: the caller (a RepositoryProvider)
 * supplies the clone URL, the fetch ref, and the auth header, so the same machinery
 * serves GitHub PR heads (`pull/<n>/head`) and GitLab MR heads
 * (`merge-requests/<iid>/head`). Side-effectful (spawns git, touches the filesystem)
 * but free of top-level effects, so it's safe to import.
 *
 * Security: the access token is passed through GIT_CONFIG_* env vars, never the clone
 * URL or a `-c` CLI arg. That keeps it out of .git/config (on disk) and out of the
 * process list (`ps`). The working dir is always removed by the caller.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSubprocessEnv, GIT_ENV_ALLOWLIST } from "./review.ts";

/**
 * Build an HTTP `AUTHORIZATION: basic …` header from a username + token. The token is
 * base64-encoded (not plaintext) so a value that leaks the header doesn't directly
 * expose the token string. GitHub uses user `x-access-token`; GitLab uses `oauth2`.
 */
export function basicAuthHeader(user: string, token: string): string {
  const basic = Buffer.from(`${user}:${token}`).toString("base64");
  return `AUTHORIZATION: basic ${basic}`;
}

/** Run one git command; reject with trimmed stderr on a non-zero exit. */
function git(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim().slice(0, 500)}`)),
    );
  });
}

export type CloneSpec = {
  cloneUrl: string;    // e.g. https://github.com/owner/repo.git
  fetchRef: string;    // e.g. pull/42/head | merge-requests/42/head
  authHeader: string;  // an AUTHORIZATION header value (see basicAuthHeader)
};

/**
 * Shallow-fetch a single ref into a fresh temp dir and check it out. Returns the dir.
 * Hosts expose a per-change head ref (`pull/<n>/head` on GitHub,
 * `merge-requests/<iid>/head` on GitLab) that resolves on the base repo even for fork
 * changes, so we never need to clone the fork. On any failure the partial dir is
 * cleaned up before re-throwing.
 */
export async function cloneRef(spec: CloneSpec): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pr-review-"));
  // Minimal env: base infra vars only (no service secrets — the token is injected via
  // GIT_CONFIG_* below, never inherited from the parent environment).
  const env = buildSubprocessEnv(process.env, GIT_ENV_ALLOWLIST, {
    GIT_TERMINAL_PROMPT: "0",         // never block on an interactive credential prompt
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: spec.authHeader,
  });
  try {
    await git(["init", "-q", dir], env);
    await git(["-C", dir, "remote", "add", "origin", spec.cloneUrl], env);
    await git(["-C", dir, "fetch", "--depth", "1", "--no-tags", "origin", spec.fetchRef], env);
    await git(["-C", dir, "checkout", "-q", "FETCH_HEAD"], env);
    return dir;
  } catch (err) {
    await removeWorkdir(dir);
    throw err;
  }
}

/** Remove a working directory; never throws (best-effort cleanup). */
export async function removeWorkdir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
