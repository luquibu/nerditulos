import { randomUUID } from 'node:crypto';
import type {
  Completeness,
  InterruptionCause,
  OutputType,
  SessionState,
  SourceLanguage,
} from '@nerditulos/shared';
import type { Pool, PoolClient } from '../db/pool.js';

export interface RoomRow {
  id: number;
  slug: string;
  name: string;
  visibleSessionId: string | null;
}

export interface SessionRow {
  id: string;
  roomId: number;
  title: string;
  sourceLanguage: SourceLanguage;
  state: SessionState;
  cause: InterruptionCause | null;
  startedAt: Date | null;
  finishingAt: Date | null;
  endedAt: Date | null;
  effectiveConfig: Record<string, unknown> | null;
  completeness: Completeness | null;
  providerGeneration: number;
  createdAt: Date;
}

/** A stream's identity within its session; `StreamRow` adds persistence fields. */
export interface StreamSpec {
  outputType: OutputType;
  language: string;
}

export interface StreamRow extends StreamSpec {
  id: number;
  sessionId: string;
  publishedSeq: number | null;
}

export interface FinalChunkInsert {
  streamId: number;
  seq: number;
  segmentSeq: number;
  text: string;
  tokens: unknown[];
  providerGeneration: number;
  receivedAt: Date;
}

export interface FinalChunkRow extends FinalChunkInsert {
  persistedAt: Date;
}

export type DeleteSessionResult = 'deleted' | 'missing' | 'not_prepared' | 'has_data';

export interface SessionEventInsert {
  sessionId: string;
  seq: number;
  kind: string;
  detail: Record<string, unknown>;
  at: Date;
}

export interface SessionStore {
  upsertRoom(slug: string, name: string): Promise<RoomRow>;
  listRooms(): Promise<RoomRow[]>;
  getRoomBySlug(slug: string): Promise<RoomRow | null>;

  /**
   * Inserts the session in `prepared` with exactly the given streams; which streams a session gets
   * is decided by the caller. Invariant the schema does not enforce and the runtime (indexed by
   * output type) and the hub (indexed by language) rely on: per session, at most one stream per
   * output type and one per language, and the translation language differs from the source language.
   */
  createSession(input: { roomId: number; title: string; sourceLanguage: SourceLanguage; streams: ReadonlyArray<StreamSpec> }): Promise<{
    session: SessionRow;
    streams: StreamRow[];
  }>;
  getSession(id: string): Promise<SessionRow | null>;
  /**
   * The room's sessions the console needs, newest first: every one that is not finished, the
   * visible one whatever its state, and the `finishedLimit` most recent finished ones.
   */
  listRoomSessions(roomId: number, visibleSessionId: string | null, finishedLimit: number): Promise<SessionRow[]>;
  listUnfinishedSessions(): Promise<SessionRow[]>;
  /**
   * Removes a session that is still `prepared`, with its streams, in one transaction that locks the
   * row first. `has_data` when anything still references it (text, events, or a room's visible
   * pointer); nothing is deleted then. `missing` is not an error: a repeated delete is idempotent.
   */
  deleteSession(id: string): Promise<DeleteSessionResult>;
  loadStreams(sessionId: string): Promise<StreamRow[]>;

  /** Conditional `prepared -> starting`; null when the row was not in `prepared`. */
  startSession(id: string, effectiveConfig: Record<string, unknown>): Promise<SessionRow | null>;
  findBlockingSession(roomId: number, exceptId: string): Promise<SessionRow | null>;
  /**
   * `live` plus, when requested, the room's visible session, in one transaction. Applies only to a
   * row in `starting` or `interrupted`, so a late write never overrides a finish; returns whether it applied.
   */
  markLive(id: string, roomId: number, makeVisible: boolean): Promise<boolean>;
  /** `interrupted` with its cause; applies only to a row in `starting`, `live`, or `interrupted`. */
  markInterrupted(id: string, cause: InterruptionCause): Promise<void>;
  /**
   * `finishing` with the DB clock in `finishing_at`; returns that timestamp, or null when the row
   * was already `finished` (a retried write that lost the race with the finish transaction).
   */
  markFinishing(id: string): Promise<Date | null>;
  /** Terminal write: state, ended_at, completeness, and each stream's published_seq. */
  markFinished(
    id: string,
    completeness: Completeness | null,
    publishedSeqs: Array<{ streamId: number; publishedSeq: number | null }>,
  ): Promise<void>;
  setProviderGeneration(id: string, generation: number): Promise<void>;
  /** Persisted rows are returned; missing rows already existed. */
  insertFinals(rows: FinalChunkInsert[]): Promise<Array<{ streamId: number; seq: number }>>;
  readBack(streamId: number, seq: number): Promise<{ text: string; providerGeneration: number } | null>;
  insertEvent(event: SessionEventInsert): Promise<void>;
  listEvents(sessionId: string): Promise<Array<{ seq: number; kind: string; detail: Record<string, unknown>; at: Date }>>;

  streamCounters(streamId: number): Promise<{ maxSeq: number; maxSegmentSeq: number; maxEventSeq?: number }>;
  eventCounter(sessionId: string): Promise<number>;
  /** Rows of the last `segments` distinct segment_seq values, bounded by `publishedSeq` when set. */
  loadWindow(streamId: number, segments: number, publishedSeq: number | null): Promise<FinalChunkRow[]>;
  /** Highest seq persisted at or before `bound` (DB clock), and the seqs persisted after it. */
  seqsAroundBound(streamId: number, bound: Date): Promise<{ maxSeqWithin: number | null; seqsAfter: number[] }>;
}

function toRoom(r: Record<string, unknown>): RoomRow {
  return {
    id: r.id as number,
    slug: r.slug as string,
    name: r.name as string,
    visibleSessionId: (r.visible_session_id as string | null) ?? null,
  };
}

function toSession(r: Record<string, unknown>): SessionRow {
  return {
    id: r.id as string,
    roomId: r.room_id as number,
    title: r.title as string,
    sourceLanguage: r.source_language as SourceLanguage,
    state: r.state as SessionState,
    cause: (r.cause as InterruptionCause | null) ?? null,
    startedAt: (r.started_at as Date | null) ?? null,
    finishingAt: (r.finishing_at as Date | null) ?? null,
    endedAt: (r.ended_at as Date | null) ?? null,
    effectiveConfig: (r.effective_config as Record<string, unknown> | null) ?? null,
    completeness: (r.completeness as Completeness | null) ?? null,
    providerGeneration: r.provider_generation as number,
    createdAt: r.created_at as Date,
  };
}

function toStream(r: Record<string, unknown>): StreamRow {
  return {
    id: r.id as number,
    sessionId: r.session_id as string,
    outputType: r.output_type as OutputType,
    language: r.language as string,
    publishedSeq: r.published_seq === null || r.published_seq === undefined ? null : Number(r.published_seq),
  };
}

function toChunk(r: Record<string, unknown>): FinalChunkRow {
  return {
    streamId: r.stream_id as number,
    seq: Number(r.seq),
    segmentSeq: r.segment_seq as number,
    text: r.text as string,
    tokens: r.tokens as unknown[],
    providerGeneration: r.provider_generation as number,
    receivedAt: r.received_at as Date,
    persistedAt: r.persisted_at as Date,
  };
}

const SESSION_COLUMNS =
  'id, room_id, title, source_language, state, cause, started_at, finishing_at, ended_at, effective_config, completeness, provider_generation, created_at';

/** Thrown inside a transaction to roll it back and report `has_data` (a foreign key refused the delete). */
class ReferencedError extends Error {}

export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export class PgSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async upsertRoom(slug: string, name: string): Promise<RoomRow> {
    const result = await this.pool.query(
      'INSERT INTO rooms (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id, slug, name, visible_session_id',
      [slug, name],
    );
    return toRoom(result.rows[0]);
  }

  async listRooms(): Promise<RoomRow[]> {
    const result = await this.pool.query('SELECT id, slug, name, visible_session_id FROM rooms ORDER BY id');
    return result.rows.map(toRoom);
  }

  async getRoomBySlug(slug: string): Promise<RoomRow | null> {
    const result = await this.pool.query('SELECT id, slug, name, visible_session_id FROM rooms WHERE slug = $1', [slug]);
    return result.rows[0] ? toRoom(result.rows[0]) : null;
  }

  async createSession(input: { roomId: number; title: string; sourceLanguage: SourceLanguage; streams: ReadonlyArray<StreamSpec> }) {
    const id = randomUUID();
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO event_sessions (id, room_id, title, source_language, state) VALUES ($1, $2, $3, $4, 'prepared') RETURNING ${SESSION_COLUMNS}`,
        [id, input.roomId, input.title, input.sourceLanguage],
      );
      const streams: StreamRow[] = [];
      for (const spec of input.streams) {
        const s = await client.query(
          'INSERT INTO text_streams (session_id, output_type, language) VALUES ($1, $2, $3) RETURNING id, session_id, output_type, language, published_seq',
          [id, spec.outputType, spec.language],
        );
        streams.push(toStream(s.rows[0]));
      }
      return { session: toSession(inserted.rows[0]), streams };
    });
  }

  async getSession(id: string): Promise<SessionRow | null> {
    const result = await this.pool.query(`SELECT ${SESSION_COLUMNS} FROM event_sessions WHERE id = $1`, [id]);
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  async listRoomSessions(roomId: number, visibleSessionId: string | null, finishedLimit: number): Promise<SessionRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM (
         SELECT ${SESSION_COLUMNS} FROM event_sessions WHERE room_id = $1 AND (state <> 'finished' OR id = $2::uuid)
         UNION
         (SELECT ${SESSION_COLUMNS} FROM event_sessions WHERE room_id = $1 AND state = 'finished' ORDER BY created_at DESC LIMIT $3)
       ) AS s ORDER BY created_at DESC, id`,
      [roomId, visibleSessionId, finishedLimit],
    );
    return result.rows.map(toSession);
  }

  async deleteSession(id: string): Promise<DeleteSessionResult> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const row = await client.query('SELECT state FROM event_sessions WHERE id = $1 FOR UPDATE', [id]);
        if (row.rowCount === 0) return 'missing' as const;
        if (row.rows[0].state !== 'prepared') return 'not_prepared' as const;
        try {
          await client.query('DELETE FROM text_streams WHERE session_id = $1', [id]);
          await client.query('DELETE FROM event_sessions WHERE id = $1', [id]);
        } catch (error) {
          if ((error as { code?: string }).code === '23503') throw new ReferencedError();
          throw error;
        }
        return 'deleted' as const;
      });
    } catch (error) {
      if (error instanceof ReferencedError) return 'has_data';
      throw error;
    }
  }

  async listUnfinishedSessions(): Promise<SessionRow[]> {
    const result = await this.pool.query(
      `SELECT ${SESSION_COLUMNS} FROM event_sessions WHERE state IN ('starting', 'live', 'interrupted', 'finishing') ORDER BY created_at`,
    );
    return result.rows.map(toSession);
  }

  async loadStreams(sessionId: string): Promise<StreamRow[]> {
    const result = await this.pool.query(
      'SELECT id, session_id, output_type, language, published_seq FROM text_streams WHERE session_id = $1 ORDER BY id',
      [sessionId],
    );
    return result.rows.map(toStream);
  }

  async startSession(id: string, effectiveConfig: Record<string, unknown>): Promise<SessionRow | null> {
    const result = await this.pool.query(
      `UPDATE event_sessions SET state = 'starting', cause = NULL, started_at = now(), effective_config = $2
       WHERE id = $1 AND state = 'prepared' RETURNING ${SESSION_COLUMNS}`,
      [id, JSON.stringify(effectiveConfig)],
    );
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  async findBlockingSession(roomId: number, exceptId: string): Promise<SessionRow | null> {
    const result = await this.pool.query(
      `SELECT ${SESSION_COLUMNS} FROM event_sessions WHERE room_id = $1 AND id <> $2 AND state IN ('starting', 'live', 'interrupted', 'finishing') LIMIT 1`,
      [roomId, exceptId],
    );
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  async markLive(id: string, roomId: number, makeVisible: boolean): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        "UPDATE event_sessions SET state = 'live', cause = NULL WHERE id = $1 AND state IN ('starting', 'interrupted')",
        [id],
      );
      if (updated.rowCount === 0) return false;
      if (makeVisible) {
        await client.query('UPDATE rooms SET visible_session_id = $2 WHERE id = $1', [roomId, id]);
      }
      return true;
    });
  }

  async markInterrupted(id: string, cause: InterruptionCause): Promise<void> {
    await this.pool.query(
      "UPDATE event_sessions SET state = 'interrupted', cause = $2 WHERE id = $1 AND state IN ('starting', 'live', 'interrupted')",
      [id, cause],
    );
  }

  async markFinishing(id: string): Promise<Date | null> {
    const result = await this.pool.query(
      "UPDATE event_sessions SET state = 'finishing', finishing_at = now() WHERE id = $1 AND state <> 'finished' RETURNING finishing_at",
      [id],
    );
    return (result.rows[0]?.finishing_at as Date | undefined) ?? null;
  }

  async markFinished(
    id: string,
    completeness: Completeness | null,
    publishedSeqs: Array<{ streamId: number; publishedSeq: number | null }>,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        "UPDATE event_sessions SET state = 'finished', cause = NULL, ended_at = now(), completeness = $2 WHERE id = $1",
        [id, completeness],
      );
      for (const s of publishedSeqs) {
        await client.query('UPDATE text_streams SET published_seq = $2 WHERE id = $1', [s.streamId, s.publishedSeq]);
      }
    });
  }

  async setProviderGeneration(id: string, generation: number): Promise<void> {
    await this.pool.query('UPDATE event_sessions SET provider_generation = $2 WHERE id = $1', [id, generation]);
  }

  async insertFinals(rows: FinalChunkInsert[]): Promise<Array<{ streamId: number; seq: number }>> {
    if (rows.length === 0) return [];
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      const base = i * 7;
      values.push(r.streamId, r.seq, r.segmentSeq, r.text, JSON.stringify(r.tokens), r.providerGeneration, r.receivedAt);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}, $${base + 7})`;
    });
    const result = await this.pool.query(
      `INSERT INTO final_chunks (stream_id, seq, segment_seq, text, tokens, provider_generation, received_at)
       VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING RETURNING stream_id, seq`,
      values,
    );
    return result.rows.map((r) => ({ streamId: r.stream_id as number, seq: Number(r.seq) }));
  }

  async readBack(streamId: number, seq: number): Promise<{ text: string; providerGeneration: number } | null> {
    const result = await this.pool.query('SELECT text, provider_generation FROM final_chunks WHERE stream_id = $1 AND seq = $2', [
      streamId,
      seq,
    ]);
    const row = result.rows[0];
    return row ? { text: row.text as string, providerGeneration: row.provider_generation as number } : null;
  }

  async insertEvent(event: SessionEventInsert): Promise<void> {
    await this.pool.query(
      'INSERT INTO session_events (session_id, seq, kind, detail, at) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT DO NOTHING',
      [event.sessionId, event.seq, event.kind, JSON.stringify(event.detail), event.at],
    );
  }

  async listEvents(sessionId: string) {
    const result = await this.pool.query('SELECT seq, kind, detail, at FROM session_events WHERE session_id = $1 ORDER BY seq', [
      sessionId,
    ]);
    return result.rows.map((r) => ({
      seq: r.seq as number,
      kind: r.kind as string,
      detail: r.detail as Record<string, unknown>,
      at: r.at as Date,
    }));
  }

  async streamCounters(streamId: number): Promise<{ maxSeq: number; maxSegmentSeq: number }> {
    const result = await this.pool.query(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq, COALESCE(MAX(segment_seq), 0) AS max_segment FROM final_chunks WHERE stream_id = $1',
      [streamId],
    );
    return { maxSeq: Number(result.rows[0].max_seq), maxSegmentSeq: Number(result.rows[0].max_segment) };
  }

  async eventCounter(sessionId: string): Promise<number> {
    const result = await this.pool.query('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_events WHERE session_id = $1', [
      sessionId,
    ]);
    return Number(result.rows[0].max_seq);
  }

  async loadWindow(streamId: number, segments: number, publishedSeq: number | null): Promise<FinalChunkRow[]> {
    const result = await this.pool.query(
      `SELECT stream_id, seq, segment_seq, text, tokens, provider_generation, received_at, persisted_at
       FROM final_chunks
       WHERE stream_id = $1 AND ($3::bigint IS NULL OR seq <= $3)
         AND segment_seq IN (
           SELECT DISTINCT segment_seq FROM final_chunks
           WHERE stream_id = $1 AND ($3::bigint IS NULL OR seq <= $3)
           ORDER BY segment_seq DESC LIMIT $2
         )
       ORDER BY seq`,
      [streamId, segments, publishedSeq],
    );
    return result.rows.map(toChunk);
  }

  async seqsAroundBound(streamId: number, bound: Date): Promise<{ maxSeqWithin: number | null; seqsAfter: number[] }> {
    const within = await this.pool.query('SELECT MAX(seq) AS max_seq FROM final_chunks WHERE stream_id = $1 AND persisted_at <= $2', [
      streamId,
      bound,
    ]);
    const after = await this.pool.query('SELECT seq FROM final_chunks WHERE stream_id = $1 AND persisted_at > $2 ORDER BY seq', [
      streamId,
      bound,
    ]);
    const max = within.rows[0].max_seq;
    return {
      maxSeqWithin: max === null || max === undefined ? null : Number(max),
      seqsAfter: after.rows.map((r) => Number(r.seq)),
    };
  }
}
