/**
 * Check out a PR's head commit into a throwaway working directory so a deep review
 * can read surrounding files. Side-effectful (spawns git, touches the filesystem)
 * but free of top-level effects, so it's safe to import.
 *
 * Security: the installation token is passed through GIT_CONFIG_* env vars, never
 * the clone URL or a `-c` CLI arg. That keeps it out of .git/config (on disk) and
 * out of the process list (`ps`). The working dir is always removed by the caller.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Build the base64 `AUTHORIZATION: basic …` header for an installation token. */
export function installationAuthHeader(token: string): string {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
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

export type ClonePrHeadOpts = {
  owner: string;
  repo: string;
  pull_number: number;
  token: string;
};

/**
 * Shallow-fetch the PR head into a fresh temp dir and check it out. Returns the dir.
 * Uses `refs/pull/<n>/head`, which resolves on the base repo even for fork PRs, so
 * we never need to clone the fork. On any failure the partial dir is cleaned up
 * before re-throwing.
 */
export async function clonePrHead(opts: ClonePrHeadOpts): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pr-review-"));
  const url = `https://github.com/${opts.owner}/${opts.repo}.git`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",         // never block on an interactive credential prompt
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: installationAuthHeader(opts.token),
  };
  try {
    await git(["init", "-q", dir], env);
    await git(["-C", dir, "remote", "add", "origin", url], env);
    await git(["-C", dir, "fetch", "--depth", "1", "--no-tags", "origin", `pull/${opts.pull_number}/head`], env);
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
