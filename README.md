# Alátùńwò AI Code Reviewer (GitHub App)

A self-hosted GitHub App that reviews pull requests with an AI provider —
Copilot-style. Install it once across your account/org; whenever a designated
reviewer is requested on any PR, the App pulls the diff, runs the review on your
subscription, and posts inline review comments.

Unlike a GitHub Action, there is **no per-repo workflow file**. The App listens
to webhooks for every repo it's installed on.

**Providers.** The review engine is pluggable. **Claude** (via the Claude Code
CLI) is the default and currently only provider; the seam (`provider.ts`,
`providers/<name>.ts`) is built so another subscription CLI can be added without
touching the GitHub/webhook machinery. Select one with `AI_PROVIDER` (default
`claude`).

## How it works

```
PR: "Request review from <you>"
        │  (pull_request.review_requested webhook)
        ▼
  This service  ──►  ack immediately; dedupe this head SHA (SQLite); enqueue
        │
        ├──►  fetch PR diff (installation token)
        │
        ├──►  AI_PROVIDER CLI (headless, on your subscription; Claude by default)
        │            returns JSON: { summary, comments[] }
        ▼
  POST a single PR review with inline comments; record the outcome
```

## What the review covers

The reviewer is **language-agnostic** — it detects the stack from the diff and
applies that language's idioms, so the same rubric works for any codebase. Each
review weighs correctness/logic bugs, edge cases and error handling, security,
performance, API/contract changes, missing tests, and maintainability — and
deliberately skips pure formatting a linter already enforces. The PR title and
description are fed in (as untrusted data) so it can judge whether the change does
what it claims. Findings are graded `blocker` / `warn` / `info`, and the summary
leads with what matters. For deeper, context-aware comments, see
[Deep reviews](#deep-reviews-optional).

## 1. Create the GitHub App

Settings → Developer settings → **GitHub Apps** → New GitHub App.

- **Webhook URL:** `https://YOUR_HOST/api/github/webhooks`
- **Webhook secret:** a long random string (also goes in `.env`)
- **Repository permissions:**
  - Pull requests: **Read & write** (read the diff, post the review)
  - Contents: **Read-only** (lets you later check out files for deeper review)
  - Metadata: **Read-only** (mandatory)
- **Subscribe to events:** **Pull request**
- After creating: note the **App ID**, generate a **private key** (.pem), then
  **Install** the App on your account and choose **All repositories**.

> **Security — keep the App private.** Set the App to **"Only on this account"**
> (not public/installable by others). The trigger is just a reviewer login, which
> is public knowledge once this repo is open-source. If anyone could install the
> App, they could open PRs requesting your reviewer login and loop them to drain
> your Claude subscription. A private App is the primary defense; the service does
> not yet enforce an installation/owner allowlist.

## 2. Get a Claude subscription token

On any machine with a browser:

```bash
npm i -g @anthropic-ai/claude-code
claude setup-token        # complete the OAuth flow; copy the printed token
```

Put it in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. It's valid ~1 year and bills to
your Pro/Max plan. (On a browserless server, run `setup-token` on your laptop and
copy the token over, or SSH-forward the OAuth callback port.)

## 3. Configure

```bash
cp .env.example .env      # fill in App ID, private key, webhook secret, reviewer login, token
npm install
```

## 4. Host it

The service must run the `claude` CLI, so it needs Node 18+ **and** the Claude
Code CLI installed — a container or a small VPS, not a thin serverless function.

```bash
npm i -g @anthropic-ai/claude-code   # on the host
npm start
```

Put it behind HTTPS (Caddy/nginx, or your platform's TLS). The public URL must
match the App's Webhook URL. For local testing, use a tunnel (e.g. smee.io or
cloudflared) as the Webhook URL.

## Reliability

These are implemented, not aspirational:

- **Fast ack + background queue:** GitHub fails a webhook it can't answer within
  ~10s and retries it. The service acks the delivery immediately and runs the
  review in the background, serialised through a one-at-a-time queue so only a
  single `claude` subprocess runs at once (predictable memory on a small box).
- **Idempotency & audit log:** every requested review is recorded in a SQLite
  store keyed by PR head SHA, so GitHub's retries — and process restarts — never
  produce duplicate reviews. The same table doubles as an audit log (status,
  summary, error, timestamps). A failed review stays retryable: re-request the
  review to try the same commit again. Set `DATABASE_PATH` (defaults to
  `./data/reviews.db`); in a container, point it at a mounted volume so it
  survives redeploys — already wired in `config/deploy.yml`.
- **Inline-comment 422s:** if Claude comments on a line outside the diff, GitHub
  rejects the whole review; the code falls back to a summary-only comment.

## Limits

- **Trigger identity:** a custom App can't be *added* as a reviewer like Copilot
  (that's first-party only). Request **yourself** or a dedicated machine-user as
  reviewer; the App reacts and posts under its own bot identity. Set that account
  in `REVIEWER_LOGIN`.
- **Usage:** headless reviews draw from your subscription's normal usage limits.
  `--max-turns 1` (already set) keeps each review to a single pass. Watch your
  quota if many PRs come through.
- **Single instance:** the in-process queue and the local SQLite file both assume
  exactly one running instance. Don't scale to multiple replicas without moving
  the queue and store onto shared infrastructure.
- **Unbounded, in-memory queue:** reviews run one at a time (queue concurrency 1),
  but the backlog is unbounded and lives in memory. A burst of requests grows
  memory and latency with no backpressure, and a restart drops everything still
  queued — those rows are recovered to `failed` at boot, so each dropped PR must
  be re-requested. Fine for personal / small-org use; for heavier load, add a
  bounded queue that posts a "busy, please re-request" notice rather than raising
  concurrency (which trades away the predictable-memory guarantee).

## Deep reviews (optional)

By default a review sees only the unified diff. A deep review instead clones the
PR head and lets Claude open **surrounding files** (definitions, call sites, tests)
for richer, context-aware comments.

- **Per PR:** add the `deep-review` label to a pull request. The next time the bot
  is requested (or re-requested) as reviewer, that PR gets a deep review.
- **Globally:** set `DEEP_REVIEW=true` to make every review deep. The label still
  works; it just opts individual PRs in when the global default is off.

- **How it works:** a short-lived, repo-scoped installation token (contents:read)
  fetches `refs/pull/<n>/head` into a throwaway temp dir — shallow, and working for
  fork PRs too. Claude runs against that checkout with a raised turn budget
  (`DEEP_REVIEW_MAX_TURNS`, default 8); the temp dir is always removed afterward.
- **Security:** Claude gets **read-only** tools (`Read`, `Grep`, `Glob`) — never
  `Bash`/`Write`/`Edit` — so untrusted PR code is read, never executed. The token
  is passed via `GIT_CONFIG_*` env, so it never lands in `.git/config` or the
  process list. The worst case from a malicious PR is a wrong comment, not RCE.
- **Cost:** every deep review clones a repo and uses multiple turns, drawing more
  from your subscription than a diff-only pass. Leave it off unless you want it.
- **Requirements:** `git` on the host (bundled in the image) and the App's
  Contents: Read permission (already in the setup above).
