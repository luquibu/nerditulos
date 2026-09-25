import { AUDIO_FORMAT, SENDER_CLOSE, type AdminRoom, type OutputType, type SessionRecord, type SourceLanguage, type SourceTestTarget } from '@nerditulos/shared';
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

export function toRecord(session: SessionRow, roomSlug: string): SessionRecord {
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
  };
}

export type AttachResult<T extends SenderTarget> = { ok: true; runtime: T; epoch: number; expectedPosition: number } | { ok: false; code: number; reason: string; lastHeardAt?: number };

export interface SessionManager {
  listAdminRooms(): Promise<AdminRoom[]>;
  prepare(slug: string, input: { title: string; sourceLanguage: SourceLanguage }): Promise<SessionRecord>;
  start(sessionId: string): Promise<SessionRecord>;
  finish(sessionId: string): Promise<SessionRecord>;
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

export class RuntimeSessionManager implements SessionManager {
  private readonly runtimes = new Map<string, SessionRuntime>();
  /** Source tests by room slug. */
  private readonly tests = new Map<string, SourceTestRuntime>();
  private testCounter = 0;
  private readonly store: SessionStore;
  private readonly rooms: RoomRow[];
  private readonly log: Logger;

  constructor(private readonly deps: ManagerDeps) {
    this.store = deps.store;
    this.rooms = deps.rooms;
    this.log = deps.log.child({ component: 'sessions' });
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
        this.runtimes.delete(runtime.id);
      },
    };
  }

  async listAdminRooms(): Promise<AdminRoom[]> {
    const fresh = await this.store.listRooms();
    const out: AdminRoom[] = [];
    for (const [index, room] of this.rooms.entries()) {
      const current = fresh.find((r) => r.id === room.id) ?? room;
      room.visibleSessionId = current.visibleSessionId;
      const sessions = await this.store.listSessions(room.id, 20);
      out.push({
        slug: room.slug,
        name: room.name,
        index: index + 1,
        visibleSessionId: current.visibleSessionId,
        sessions: sessions.map((s) => {
          const runtime = this.runtimes.get(s.id);
          return runtime ? this.recordOf(runtime) : toRecord(s, room.slug);
        }),
      });
    }
    return out;
  }

  private recordOf(runtime: SessionRuntime): SessionRecord {
    return toRecord({ ...runtime.session, state: runtime.state, cause: runtime.cause, completeness: runtime.completeness }, runtime.room.slug);
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

  async start(sessionId: string): Promise<SessionRecord> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new ManagerError(404, 'session_not_found');
    const room = this.roomById(session.roomId);
    if (!room) throw new ManagerError(404, 'room_not_found');
    if (session.state !== 'prepared') throw new ManagerError(409, 'not_prepared', { state: session.state });
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
      throw error;
    }
    if (!started) throw new ManagerError(409, 'not_prepared');
    const runtime = new SessionRuntime(this.runtimeDeps(), started, room, streams, {
      counters: new Map(),
      eventSeq: 0,
      visible: room.visibleSessionId === session.id,
      hubSession: null,
    });
    this.runtimes.set(session.id, runtime);
    // The room is taken: a source test in it ends before the session's sender can attach.
    this.tests.get(room.slug)?.end('session_started');
    this.log.info('session starting', { sessionId: session.id, room: room.slug, sourceLanguage: session.sourceLanguage });
    return this.recordOf(runtime);
  }

  async finish(sessionId: string): Promise<SessionRecord> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      await runtime.finish('http');
      return this.recordOf(runtime);
    }
    const session = await this.store.getSession(sessionId);
    if (!session) throw new ManagerError(404, 'session_not_found');
    const room = this.roomById(session.roomId);
    if (session.state === 'prepared') throw new ManagerError(409, 'not_started');
    // `finishing` without a runtime: the session finished in memory and its write is still being retried.
    if (session.state === 'finished' || session.state === 'finishing') return toRecord(session, room?.slug ?? '');
    throw new ManagerError(409, 'not_controllable', { state: session.state });
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
    for (const runtime of this.runtimes.values()) runtime.dispose();
    for (const test of this.tests.values()) test.dispose();
    this.tests.clear();
  }
}
