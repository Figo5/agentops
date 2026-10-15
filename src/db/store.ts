/**
 * The store: one append-only table of events.
 *
 * There is no run, stage, attempt or approval table any more, because this
 * service no longer runs anything — it receives what agents report. Everything
 * the field draws (actors, sessions, handoffs, verdicts) is derived from this
 * stream, so the only durable thing is the stream itself.
 *
 * `:memory:` is the default so tests and a throwaway server cost nothing; the
 * binary passes a real path under the data directory.
 */
import { DatabaseSync } from "node:sqlite";
import type { EventRecord, IngestedEvent } from "../core/events.js";

export interface StoreOptions {
  /** SQLite file, or `:memory:` (the default). */
  path?: string;
}

export interface EventQuery {
  /** Exclusive cursor: only events with a higher id are returned. */
  afterId?: number;
  session?: string | null;
  limit?: number;
}

/** Hard ceiling on one query, so a client cannot ask for the whole history. */
const MAX_LIMIT = 1000;

interface Row {
  id: number;
  created_at: string;
  actor: string;
  action: string;
  session: string | null;
  provider: string | null;
  target: string | null;
  parent: string | null;
  summary: string | null;
  status: string | null;
  verdict: string | null;
  issues: string;
  detail: string;
}

function toRecord(row: Row): EventRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    actor: row.actor,
    action: row.action,
    session: row.session,
    provider: row.provider,
    target: row.target,
    parent: row.parent,
    summary: row.summary,
    status: row.status as EventRecord["status"],
    verdict: row.verdict,
    // Stored as JSON text: parsed back defensively so one unreadable row
    // cannot take down a whole query.
    issues: parseJson(row.issues, []) as EventRecord["issues"],
    detail: parseJson(row.detail, {}) as Record<string, unknown>,
  };
}

function parseJson(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(options: StoreOptions = {}) {
    this.db = new DatabaseSync(options.path ?? ":memory:");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          session TEXT,
          provider TEXT,
          target TEXT,
          parent TEXT,
          summary TEXT,
          status TEXT,
          verdict TEXT,
          issues TEXT NOT NULL DEFAULT '[]',
          detail TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS events_session_idx ON events (session, id);
        CREATE INDEX IF NOT EXISTS events_actor_idx ON events (actor, id);
      `);
    } catch (cause) {
      // A database written by an older AgentOps has an `events` table without
      // these columns, so `CREATE TABLE IF NOT EXISTS` finds one and the index
      // then fails. Say what to do instead of surfacing a bare SQL error.
      const where = options.path ?? ":memory:";
      throw new Error(
        `Could not initialise the events table in ${where}. If this database ` +
          `was written by an older AgentOps, move it aside (or set ` +
          `AGENTOPS_DATA_DIR to a new directory) and start again. Underlying ` +
          `error: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  append(event: IngestedEvent): EventRecord {
    const createdAt = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO events
        (created_at, actor, action, session, provider, target, parent,
         summary, status, verdict, issues, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);
    const row = statement.get(
      createdAt,
      event.actor,
      event.action,
      event.session,
      event.provider,
      event.target,
      event.parent,
      event.summary,
      event.status,
      event.verdict,
      JSON.stringify(event.issues),
      JSON.stringify(event.detail),
    ) as unknown as Row;
    return toRecord(row);
  }

  list(query: EventQuery = {}): EventRecord[] {
    const limit = Math.min(Math.max(1, query.limit ?? 200), MAX_LIMIT);
    const afterId = Math.max(0, Math.trunc(query.afterId ?? 0));
    // Newest-first with a limit, then reversed: a fresh client gets the most
    // recent window rather than the oldest events in the database.
    const rows = query.session
      ? (this.db
          .prepare(
            `SELECT * FROM events WHERE id > ? AND session = ?
             ORDER BY id DESC LIMIT ?`,
          )
          .all(afterId, query.session, limit) as unknown as Row[])
      : (this.db
          .prepare(`SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?`)
          .all(afterId, limit) as unknown as Row[]);
    return rows.map(toRecord).reverse();
  }

  /** Events after a cursor in ascending order: what the SSE pump sends. */
  since(afterId: number, limit = 200): EventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(
        Math.max(0, Math.trunc(afterId)),
        Math.min(limit, MAX_LIMIT),
      ) as unknown as Row[];
    return rows.map(toRecord);
  }

  latestId(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM events`)
      .get() as unknown as { id: number };
    return row.id;
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events`)
      .get() as unknown as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
