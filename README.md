# Claude PR Reviewer (GitHub App)

A self-hosted GitHub App that reviews pull requests with Claude — Copilot-style.
Install it once across your account/org; whenever a designated reviewer is
requested on any PR, the App pulls the diff, runs Claude on your subscription,
and posts inline review comments.

Unlike a GitHub Action, there is **no per-repo workflow file**. The App listens
to webhooks for every repo it's installed on.

## How it works

```
PR: "Request review from <you>"
        │  (pull_request.review_requested webhook)
        ▼
  This service  ──►  fetch PR diff (installation token)
        │
        ├──►  claude -p  (headless, CLAUDE_CODE_OAUTH_TOKEN → your subscription)
        │            returns JSON: { summary, comments[] }
        ▼
  POST a single PR review with inline comments
```

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

## Notes, limits & next steps

- **Trigger identity:** a custom App can't be *added* as a reviewer like Copilot
  (that's first-party only). Request **yourself** or a dedicated machine-user as
  reviewer; the App reacts and posts under its own bot identity. Set that account
  in `REVIEWER_LOGIN`.
- **Usage:** headless reviews draw from your subscription's normal usage limits.
  `--max-turns 1` (already set) keeps each review to a single pass. Watch your
  quota if many PRs come through.
- **Ack fast:** GitHub expects a webhook response within ~10s, but a Claude
  review takes longer. For production, ack immediately and process in a
  background queue/worker; otherwise GitHub marks the delivery failed and may
  **retry**, causing duplicate reviews. Add idempotency (e.g. skip if the App has
  already reviewed the current head SHA).
- **Inline-comment 422s:** if Claude comments on a line outside the diff, GitHub
  rejects the whole review; the code falls back to a summary-only comment.
- **Deeper reviews:** for more than diff-only analysis, clone the repo with the
  installation token, check out the PR branch, and run `claude -p` in that
  working dir so it can open surrounding files (raise `--max-turns`).
