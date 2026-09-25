import { AUDIO_FORMAT, SENDER_CLOSE, type AdminRoom, type AdminSourceTest, type OutputType, type SessionRecord, type SourceLanguage, type SourceTestTarget } from '@nerditulos/shared';
import type { Logger } from '../log.js';
import type { StreamHub } from '../public/streamHub.js';
import type { ProviderFactory } from '../provider/soniox.js';
import { recoverFinishingSession, translationTargetOf } from './recovery.js';
import type { SenderLink, SenderTarget } from './senderTarget.js';
import { SessionRuntime, type RuntimeConfig } from './SessionRuntime.js';
import type { RoomRow, SessionRow, SessionStore } from './SessionStore.js';
import { SourceTestRuntime } from './SourceTestRuntime.js';

/**
 * Streams a newly prepared session gets, by source language: the original plus one translation.
 * Applies only when preparing; an existing session keeps the streams it was prepared with, and
 * everything downstream (offered languages, provider translation target) derives from those rows.
 * The value type keeps the store's invariant: one output type per entry and a translation
 * language that differs from the source.
 */
const STREAMS_BY_SOURCE_LANGUAGE: Record<SourceLanguage, ReadonlyArray<{ outputType: OutputType; language: SourceLanguage }>> = {
  es: [
    { outputType: 'original', language: 'es' },
    { outputType: 'translation', language: 'en' },
  ],
  en: [
    { outputType: 'original', language: 'en' },
    { outputType: 'translation', language: 'es' },
  ],
};

/** Finished sessions listed per room, besides every unfinished one and the visible one. */
export const FINISHED_HISTORY_LIMIT = 20;

export class ManagerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'ManagerError';
  }
}

export function toRecord(session: SessionRow, roomSlug: string, senderActive = false): SessionRecord {
  return {
    sessionId: session.id,
    title: session.title,
    sourceLanguage: session.sourceLanguage,
    state: session.state,
    cause: session.cause,
    completeness: session.completeness,
    roomSlug,
    createdAt: session.createdAt.toISOString(),
    startedAt: session.startedAt ? session.startedAt.toISOString() : null,
    endedAt: session.endedAt ? session.endedAt.toISOString() : null,
    senderActive,
  };
}

export type AttachResult<T extends SenderTarget> = { ok: true; runtime: T; epoch: number; expectedPosition: number } | { ok: false; code: number; reason: string; lastHeardAt?: number };

export interface StartOptions {
  /** The room's source test the caller agrees to end. A running test with another id refuses the start. */
  confirmedTestId: string | null;
}

export interface FinishResult {
  session: SessionRecord;
  /** The session was already finished or finishing before this call. */
  alreadyFinished: boolean;
}

export interface SessionManager {
  listAdminRooms(): Promise<AdminRoom[]>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  prepare(slug: string, input: { title: string; sourceLanguage: SourceLanguage }): Promise<SessionRecord>;
  start(sessionId: string, opts: StartOptions): Promise<SessionRecord>;
  finish(sessionId: string): Promise<FinishResult>;
  /** Removes a prepared session. Idempotent: a session that no longer exists is not an error. */
  delete(sessionId: string): Promise<void>;
  attachSender(sessionId: string, link: SenderLink): AttachResult<SessionRuntime>;
  /** A source test for a room without an active session; at most one per room. */
  attachTest(input: SourceTestTarget, link: SenderLink): AttachResult<SourceTestRuntime>;
}

export interface ManagerDeps {
  store: SessionStore;
  rooms: RoomRow[];
  hub: StreamHub;
  providerFactory: ProviderFactory;
  log: Logger;
  config: RuntimeConfig;
  now?: () => number;
}

/**
 * Room-level decisions (start, delete, finish) run one at a time per room, in arrival order, and
 * re-read the row inside their turn: two consoles acting on the same room never decide on the
 * same stale state. Source tests attach synchronously and are refused while a start is deciding.
 */
export class RuntimeSessionManager implements SessionManager {
  private readonly runtimes = new Map<string, SessionRuntime>();
  /** Source tests by room slug. */
  private readonly tests = new Map<string, SourceTestRuntime>();
  private testCounter = 0;
  private readonly roomLocks = new Map<number, Promise<void>>();
  private readonly startsInFlight = new Set<number>();
  private readonly finishes = new Map<string, Promise<FinishResult>>();
  private disposed = false;
  private readonly store: SessionStore;
  private readonly rooms: RoomRow[];
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly deps: ManagerDeps) {
    this.store = deps.store;
    this.rooms = deps.rooms;
    this.log = deps.log.child({ component: 'sessions' });
    this.now = deps.now ?? (() => Date.now());
  }

  private roomBySlug(slug: string): RoomRow | null {
    return this.rooms.find((r) => r.slug === slug) ?? null;
  }

  private roomById(id: number): RoomRow | null {
    return this.rooms.find((r) => r.id === id) ?? null;
  }

  getRuntime(sessionId: string): SessionRuntime | null {
    return this.runtimes.get(sessionId) ?? null;
  }

  runtimeForRoom(roomId: number): SessionRuntime | null {
    for (const r of this.runtimes.values()) if (r.room.id === roomId) return r;
    return null;
  }

  liveRuntimes(): SessionRuntime[] {
    return [...this.runtimes.values()];
  }

  testForRoom(slug: string): SourceTestRuntime | null {
    return this.tests.get(slug) ?? null;
  }

  /** Runs `fn` after every earlier operation on the room has settled, then releases the room. */
  private withRoomLock<T>(roomId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.roomLocks.get(roomId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.roomLocks.set(roomId, tail);
    void tail.then(() => {
      if (this.roomLocks.get(roomId) === tail) this.roomLocks.delete(roomId);
    });
    return run;
  }

  /**
   * Boot recovery, before the hub warm-up: `finishing` sessions are finished as incomplete with the
   * fenced watermark; `starting|live|interrupted` sessions get a runtime in `interrupted` so the
   * sender can re-authenticate with the same session id.
   */
  async boot(): Promise<void> {
    const unfinished = await this.store.listUnfinishedSessions();
    for (const session of unfinished) {
      const room = this.roomById(session.roomId);
      const streams = await this.store.loadStreams(session.id);
      if (session.state === 'finishing') {
        await recoverFinishingSession(this.store, session, streams, this.deps.config.drainTimeoutMs, this.deps.config.statementTimeoutMs ?? 5000, this.log);
        continue;
      }
      if (!room) {
        this.log.warn('unfinished session without a seeded room; finishing as incomplete', { sessionId: session.id });
        await this.store.markFinished(session.id, 'incomplete', streams.map((s) => ({ streamId: s.id, publishedSeq: null })));
        continue;
      }
      const counters = new Map<number, { maxSeq: number; maxSegmentSeq: number }>();
      const lastPersisted: Record<string, number> = {};
      for (const s of streams) {
        const c = await this.store.streamCounters(s.id);
        counters.set(s.id, c);
        lastPersisted[`${s.outputType}:${s.language}`] = c.maxSeq;
      }
      let eventSeq = await this.store.eventCounter(session.id);
      let row = session;
      if (session.state === 'starting' || session.state === 'live') {
        await this.store.markInterrupted(session.id, 'interrupted_on_restart');
        await this.store.insertEvent({ sessionId: session.id, seq: ++eventSeq, kind: 'interrupted_on_restart', detail: { previousState: session.state }, at: new Date() });
        await this.store.insertEvent({ sessionId: session.id, seq: ++eventSeq, kind: 'discontinuity', detail: { epoch: null, kind: 'restart', extentSamples: 'unknown', lastPersistedSeq: lastPersisted }, at: new Date() });
        row = { ...session, state: 'interrupted', cause: 'interrupted_on_restart' };
        this.log.warn('session interrupted on restart', { sessionId: session.id, previousState: session.state });
      }
      const visible = room.visibleSessionId === session.id;
      const runtime = new SessionRuntime(this.runtimeDeps(), row, room, streams, { counters, eventSeq, visible, hubSession: null });
      this.runtimes.set(session.id, runtime);
    }
  }

  private runtimeDeps() {
    return {
      store: this.store,
      hub: this.deps.hub,
      providerFactory: this.deps.providerFactory,
      log: this.log,
      config: this.deps.config,
      now: this.deps.now,
      onFinished: (runtime: SessionRuntime) => {
        if (this.runtimes.get(runtime.id) === runtime) this.runtimes.delete(runtime.id);
      },
    };
  }

  async listAdminRooms(): Promise<AdminRoom[]> {
    const fresh = await this.store.listRooms();
    const out: AdminRoom[] = [];
    for (const [index, room] of this.rooms.entries()) {
      const current = fresh.find((r) => r.id === room.id) ?? room;
      room.visibleSessionId = current.visibleSessionId;
      const sessions = await this.store.listRoomSessions(room.id, current.visibleSessionId, FINISHED_HISTORY_LIMIT);
      const test = this.tests.get(room.slug);
      out.push({
        slug: room.slug,
        name: room.name,
        index: index + 1,
        visibleSessionId: current.visibleSessionId,
        sessions: sessions.map((s) => {
          const runtime = this.runtimes.get(s.id);
          return runtime ? this.recordOf(runtime) : toRecord(s, room.slug);
        }),
        test: test ? this.testRecord(test) : null,
      });
    }
    return out;
  }

  private testRecord(test: SourceTestRuntime): AdminSourceTest {
    return { id: test.id, sourceLanguage: test.sourceLanguage, startedAt: new Date(test.startedAt).toISOString() };
  }

  private recordOf(runtime: SessionRuntime): SessionRecord {
    return toRecord({ ...runtime.session, state: runtime.state, cause: runtime.cause, completeness: runtime.completeness }, runtime.room.slug, runtime.senderActive);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) return this.recordOf(runtime);
    const session = await this.store.getSession(sessionId);
    if (!session) return null;
    return toRecord(session, this.roomById(session.roomId)?.slug ?? '');
  }

  async prepare(slug: string, input: { title: string; sourceLanguage: SourceLanguage }): Promise<SessionRecord> {
    const room = this.roomBySlug(slug);
    if (!room) throw new ManagerError(404, 'room_not_found');
    const title = input.title.trim();
    if (!title || title.length > 200) throw new ManagerError(400, 'invalid_title');
    if (input.sourceLanguage !== 'es' && input.sourceLanguage !== 'en') throw new ManagerError(400, 'invalid_language');
    const { session } = await this.store.createSession({ roomId: room.id, title, sourceLanguage: input.sourceLanguage, streams: STREAMS_BY_SOURCE_LANGUAGE[input.sourceLanguage] });
    return toRecord(session, room.slug);
  }

  async start(sessionId: string, opts: StartOptions): Promise<SessionRecord> {
    const first = await this.store.getSession(sessionId);
    if (!first) throw new ManagerError(404, 'session_not_found');
    const room = this.roomById(first.roomId);
    if (!room) throw new ManagerError(404, 'room_not_found');
    return this.withRoomLock(room.id, async () => {
      this.startsInFlight.add(room.id);
      try {
        return await this.startLocked(sessionId, room, opts);
      } finally {
        this.startsInFlight.delete(room.id);
      }
    });
  }

  private async startLocked(sessionId: string, room: RoomRow, opts: StartOptions): Promise<SessionRecord> {
    if (this.disposed) throw new ManagerError(503, 'shutting_down');
    // Decided on the row as it is now: an earlier turn may have deleted or started it.
    const session = await this.store.getSession(sessionId);
    if (!session) throw new ManagerError(404, 'session_not_found');
    if (session.state !== 'prepared') throw new ManagerError(409, 'not_prepared', { state: session.state });
    const test = this.tests.get(room.slug) ?? null;
    if (test && test.id !== opts.confirmedTestId) {
      throw new ManagerError(409, 'test_active', { testId: test.id, testSourceLanguage: test.sourceLanguage });
    }
    const blocking = await this.store.findBlockingSession(room.id, session.id);
    if (blocking) throw new ManagerError(409, 'room_busy', { blockingSessionId: blocking.id, blockingTitle: blocking.title, blockingState: blocking.state });
    // Read once, before the state write: the recorded configuration and the runtime see the same rows.
    const streams = await this.store.loadStreams(session.id);
    const effectiveConfig = {
      model: this.deps.config.sonioxModel,
      sourceLanguage: session.sourceLanguage,
      translationTarget: translationTargetOf(streams, this.log),
      audioFormat: AUDIO_FORMAT,
      languageHints: [session.sourceLanguage],
      endpointDetection: true,
      drainTimeoutMs: this.deps.config.drainTimeoutMs,
      publicWindowSegments: this.deps.config.publicWindowSegments,
      segmentMaxChars: this.deps.config.segmentMaxChars,
    };
    let started: SessionRow | null;
    try {
      started = await this.store.startSession(session.id, effectiveConfig);
    } catch (error) {
      // Two starts in the same room raced past the check: the partial unique index rejects the second.
      if ((error as { code?: string }).code === '23505') throw new ManagerError(409, 'room_busy');
      this.log.warn('start write failed; reconciling', { sessionId: session.id, error: (error as Error).message });
      started = await this.reconcileStart(session.id);
    }
    if (!started) {
      const now = await this.store.getSession(session.id);
      if (!now) throw new ManagerError(404, 'session_not_found');
      throw new ManagerError(409, 'not_prepared', { state: now.state });
    }
    if (this.disposed) {
      // The row is `starting`; the next boot recovers it as interrupted.
      this.log.warn('start committed during shutdown; no runtime created', { sessionId: session.id });
      return toRecord(started, room.slug);
    }
    const runtime = new SessionRuntime(this.runtimeDeps(), started, room, streams, {
      counters: new Map(),
      eventSeq: 0,
      visible: room.visibleSessionId === session.id,
      hubSession: null,
    });
    this.runtimes.set(session.id, runtime);
    // The room is taken: the confirmed test (still the same one, tests cannot attach meanwhile) ends
    // before the session's sender can attach.
    const current = this.tests.get(room.slug);
    if (current && current === test) current.end('session_started');
    this.log.info('session starting', { sessionId: session.id, room: room.slug, sourceLanguage: session.sourceLanguage, confirmedTest: test?.id ?? null });
    return this.recordOf(runtime);
  }

  /**
   * The start write failed without saying whether it committed. Within the room's turn nobody else
   * writes this row, so a row now in `starting` is ours; one still `prepared` means the write was lost.
   */
  private async reconcileStart(sessionId: string): Promise<SessionRow | null> {
    const budget = this.deps.config.retryBudgetMs ?? 10000;
    const interval = this.deps.config.retryIntervalMs ?? 500;
    const startedAt = this.now();
    for (;;) {
      try {
        const row = await this.store.getSession(sessionId);
        if (!row) throw new ManagerError(404, 'session_not_found');
        if (row.state === 'starting') return row;
        if (row.state !== 'prepared') throw new ManagerError(409, 'not_prepared', { state: row.state });
      } catch (error) {
        if (error instanceof ManagerError) throw error;
        this.log.warn('start reconciliation read failed', { sessionId, error: (error as Error).message });
      }
      if (this.now() - startedAt + interval > budget) throw new ManagerError(503, 'storage_unavailable');
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  async delete(sessionId: string): Promise<void> {
    const first = await this.store.getSession(sessionId);
    if (!first) return;
    return this.withRoomLock(first.roomId, async () => {
      if (this.disposed) throw new ManagerError(503, 'shutting_down');
      const runtime = this.runtimes.get(sessionId);
      if (runtime) throw new ManagerError(409, 'not_deletable', { state: runtime.state });
      let result: Awaited<ReturnType<SessionStore['deleteSession']>>;
      try {
        result = await this.store.deleteSession(sessionId);
      } catch (error) {
        this.log.warn('delete failed; checking the row', { sessionId, error: (error as Error).message });
        let row: SessionRow | null;
        try {
          row = await this.store.getSession(sessionId);
        } catch {
          throw new ManagerError(503, 'storage_unavailable');
        }
        if (!row) return;
        throw new ManagerError(503, 'storage_unavailable');
      }
      if (result === 'deleted' || result === 'missing') {
        if (result === 'deleted') this.log.info('session deleted', { sessionId, room: this.roomById(first.roomId)?.slug ?? null });
        return;
      }
      if (result === 'has_data') throw new ManagerError(409, 'session_has_data');
      const row = await this.store.getSession(sessionId);
      throw new ManagerError(409, 'not_deletable', { state: row?.state ?? 'unknown' });
    });
  }

  finish(sessionId: string): Promise<FinishResult> {
    // Two consoles finishing the same session share one outcome instead of racing the runtime.
    const inFlight = this.finishes.get(sessionId);
    if (inFlight) return inFlight;
    const promise = this.finishOnce(sessionId).finally(() => {
      if (this.finishes.get(sessionId) === promise) this.finishes.delete(sessionId);
    });
    this.finishes.set(sessionId, promise);
    return promise;
  }

  private async finishOnce(sessionId: string): Promise<FinishResult> {
    const roomId = this.runtimes.get(sessionId)?.room.id ?? (await this.store.getSession(sessionId))?.roomId;
    if (roomId === undefined) throw new ManagerError(404, 'session_not_found');
    return this.withRoomLock(roomId, async () => {
      const runtime = this.runtimes.get(sessionId);
      if (runtime) {
        const alreadyFinished = runtime.state === 'finished' || runtime.state === 'finishing';
        await runtime.finish('http');
        return { session: this.recordOf(runtime), alreadyFinished };
      }
      const session = await this.store.getSession(sessionId);
      if (!session) throw new ManagerError(404, 'session_not_found');
      const slug = this.roomById(session.roomId)?.slug ?? '';
      if (session.state === 'prepared') throw new ManagerError(409, 'not_started');
      // `finishing` without a runtime: the session finished in memory and its write is still being retried.
      if (session.state === 'finished' || session.state === 'finishing') return { session: toRecord(session, slug), alreadyFinished: true };
      // A started row without a runtime (its start committed while the process was stopping): finish it directly.
      this.log.warn('finishing a session without a runtime', { sessionId, state: session.state });
      const streams = await this.store.loadStreams(sessionId);
      await this.store.markFinished(sessionId, null, streams.map((s) => ({ streamId: s.id, publishedSeq: null })));
      const finished = (await this.store.getSession(sessionId)) ?? { ...session, state: 'finished' as const, cause: null };
      return { session: toRecord(finished, slug), alreadyFinished: false };
    });
  }

  attachSender(sessionId: string, link: SenderLink): AttachResult<SessionRuntime> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return { ok: false, code: SENDER_CLOSE.NOT_JOINABLE, reason: 'session-not-joinable' };
    const result = runtime.attachSender(link);
    if (!result.ok) return result;
    return { ok: true, runtime, epoch: result.epoch, expectedPosition: result.expectedPosition };
  }

  attachTest(input: SourceTestTarget, link: SenderLink): AttachResult<SourceTestRuntime> {
    const room = this.roomBySlug(input.room);
    if (!room) return { ok: false, code: SENDER_CLOSE.NOT_JOINABLE, reason: 'room-not-found' };
    // A start is deciding on this room, or the process is stopping: no new test may slip in.
    if (this.disposed || this.startsInFlight.has(room.id)) return { ok: false, code: SENDER_CLOSE.SENDER_ACTIVE, reason: 'room-busy' };
    // A `finish()` from `starting` leaves a finished runtime in the map while its write runs; that room is free.
    const active = this.runtimeForRoom(room.id);
    if (active && active.state !== 'finished') return { ok: false, code: SENDER_CLOSE.SENDER_ACTIVE, reason: 'room-busy' };
    if (this.tests.has(room.slug)) return { ok: false, code: SENDER_CLOSE.SENDER_ACTIVE, reason: 'test-active' };
    const runtime = new SourceTestRuntime(
      {
        providerFactory: this.deps.providerFactory,
        log: this.log,
        config: this.deps.config,
        now: this.deps.now,
        onEnded: (ended) => {
          if (this.tests.get(room.slug) === ended) this.tests.delete(room.slug);
        },
      },
      room.slug,
      input.sourceLanguage,
      link,
      ++this.testCounter,
    );
    this.tests.set(room.slug, runtime);
    runtime.open();
    return { ok: true, runtime, epoch: 1, expectedPosition: 0 };
  }

  dispose() {
    this.disposed = true;
    for (const runtime of this.runtimes.values()) runtime.dispose();
    for (const test of this.tests.values()) test.dispose();
    this.tests.clear();
  }
}
