/**
 * Durable review store — SQLite via better-sqlite3.
 *
 * Two jobs in one table:
 *   1. Idempotency. A UNIQUE key on (owner, repo, pull_number, head_sha) means a
 *      given commit on a given PR is reviewed at most once, even across process
 *      restarts and GitHub's webhook redelivery retries. Replaces the old
 *      in-memory `Set`, which a restart wiped.
 *   2. Audit log. Every requested review leaves a row recording who asked, the
 *      outcome (pending → posted | failed), a short summary / error, and timing.
 *
 * better-sqlite3 is synchronous: every call here blocks the event loop briefly.
 * That's fine — reviews are serialised through a concurrency-1 queue and the DB
 * lives on a local file, so each statement is sub-millisecond.
 */

import Database from "better-sqlite3";

export type ReviewStatus = "pending" | "posted" | "failed";

/** Identifies one review: a specific head SHA on a specific PR. */
export type ReviewRef = {
  owner: string;
  repo: string;
  pull_number: number;
  head_sha: string;
};

/** A persisted review row, as returned by {@link ReviewStore.get}. */
export type ReviewRecord = ReviewRef & {
  reviewer: string;
  status: ReviewStatus;
  summary: string | null;
  comment_count: number | null;
  error: string | null;
  requested_at: string;
  completed_at: string | null;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS reviews (
    owner         TEXT    NOT NULL,
    repo          TEXT    NOT NULL,
    pull_number   INTEGER NOT NULL,
    head_sha      TEXT    NOT NULL,
    reviewer      TEXT    NOT NULL,
    status        TEXT    NOT NULL CHECK (status IN ('pending','posted','failed')),
    summary       TEXT,
    comment_count INTEGER,
    error         TEXT,
    requested_at  TEXT    NOT NULL,
    completed_at  TEXT,
    PRIMARY KEY (owner, repo, pull_number, head_sha)
  );
`;

export class ReviewStore {
  #db: Database.Database;

  /**
   * Open (creating if needed) the SQLite database at `path`. Pass `:memory:` for
   * an ephemeral DB in tests. WAL mode lets the health check read while a review
   * writes; `busy_timeout` rides out the brief contention instead of erroring.
   */
  constructor(path: string) {
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("busy_timeout = 5000");
    this.#db.exec(SCHEMA);
  }

  /**
   * Reserve a review for this head SHA. Returns `true` if the caller should
   * proceed (the SHA is newly claimed, or a prior attempt failed and is being
   * retried), `false` if it's already posted or currently in flight.
   *
   * Atomic: the read-and-claim runs in a single transaction, so concurrent
   * callers can't both reserve the same key. A failed row is flipped back to
   * `pending` in place — the audit history of the failure is preserved.
   */
  reserve(ref: ReviewRef, reviewer: string, now: string): boolean {
    const claim = this.#db.transaction((): boolean => {
      const inserted = this.#db
        .prepare(
          `INSERT INTO reviews
             (owner, repo, pull_number, head_sha, reviewer, status, requested_at)
           VALUES (@owner, @repo, @pull_number, @head_sha, @reviewer, 'pending', @now)
           ON CONFLICT DO NOTHING`,
        )
        .run({ ...ref, reviewer, now });
      if (inserted.changes === 1) return true;

      const existing = this.get(ref);
      if (existing?.status !== "failed") return false;

      // A previous attempt failed; a re-request is retrying. Reclaim the row.
      this.#db
        .prepare(
          `UPDATE reviews
              SET status = 'pending', reviewer = @reviewer, requested_at = @now,
                  error = NULL, completed_at = NULL
            WHERE owner = @owner AND repo = @repo
              AND pull_number = @pull_number AND head_sha = @head_sha`,
        )
        .run({ ...ref, reviewer, now });
      return true;
    });
    return claim();
  }

  /** Mark a reserved review as successfully posted, recording its outcome. */
  markPosted(ref: ReviewRef, summary: string, commentCount: number, now: string): void {
    this.#db
      .prepare(
        `UPDATE reviews
            SET status = 'posted', summary = @summary,
                comment_count = @commentCount, completed_at = @now
          WHERE owner = @owner AND repo = @repo
            AND pull_number = @pull_number AND head_sha = @head_sha`,
      )
      .run({ ...ref, summary, commentCount, now });
  }

  /**
   * Mark a reserved review as failed. The row stays so {@link reserve} can detect
   * the failure and let a re-request retry the same head SHA.
   */
  markFailed(ref: ReviewRef, error: string, now: string): void {
    this.#db
      .prepare(
        `UPDATE reviews
            SET status = 'failed', error = @error, completed_at = @now
          WHERE owner = @owner AND repo = @repo
            AND pull_number = @pull_number AND head_sha = @head_sha`,
      )
      .run({ ...ref, error, now });
  }

  /**
   * Fail any rows still `pending` at startup. Such rows belong to a previous
   * process that died mid-review — without this they'd block retries forever.
   * Returns how many were recovered. Mirrors the old in-memory behaviour where a
   * restart cleared all in-flight keys.
   */
  recoverOrphans(now: string): number {
    return this.#db
      .prepare(
        `UPDATE reviews
            SET status = 'failed',
                error = 'orphaned: process restarted mid-review',
                completed_at = @now
          WHERE status = 'pending'`,
      )
      .run({ now }).changes;
  }

  /** Fetch a single review row, or `undefined` if none exists for this SHA. */
  get(ref: ReviewRef): ReviewRecord | undefined {
    return this.#db
      .prepare(
        `SELECT * FROM reviews
          WHERE owner = @owner AND repo = @repo
            AND pull_number = @pull_number AND head_sha = @head_sha`,
      )
      .get(ref) as ReviewRecord | undefined;
  }

  close(): void {
    this.#db.close();
  }
}
