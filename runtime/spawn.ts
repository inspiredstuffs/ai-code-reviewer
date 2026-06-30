import { spawn } from "node:child_process";

/**
 * Non-secret process vars safe to forward to subprocesses: enough to be found on
 * PATH, locate config under HOME, write temp files, render UTF-8 output, and reach
 * the network through a proxy / custom CA. Deliberately excludes everything else so
 * service secrets are default-denied rather than inherited wholesale.
 */
export const BASE_ENV_ALLOWLIST = [
  "PATH", "HOME", "TMPDIR", "USER", "SHELL",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
] as const;

/**
 * Env allowlist for the `git` clone subprocess. It needs no secret from the
 * environment; the installation token is injected separately via GIT_CONFIG_*.
 */
export const GIT_ENV_ALLOWLIST = BASE_ENV_ALLOWLIST;

/**
 * Build a minimal subprocess environment: copy only the allowlisted names that are
 * actually set in `source`, then layer `extra` on top.
 */
export function buildSubprocessEnv(
  source: NodeJS.ProcessEnv,
  allowlist: readonly string[],
  extra: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Spawn a CLI, feed `stdin` on standard input, and resolve with stdout.
 * Generic process infrastructure; provider-specific code decides the command,
 * args, env allowlist, and how to parse stdout.
 */
export function spawnText(
  command: string,
  args: string[],
  env: Record<string, string>,
  stdin: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(0, 1000)}`));
    });
    child.stdin.on("error", reject);
    child.stdin.end(stdin);
  });
}
