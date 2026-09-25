import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Completeness, InterruptionCause, SenderServerMessage, SessionState, SourceLanguage } from '@nerditulos/shared';
import type { ProviderConfigInput, ProviderConnection, ProviderFactory, SonioxResponse } from '../provider/soniox.js';
import type { SenderLink } from '../sessions/senderTarget.js';
import type { FinalChunkInsert, FinalChunkRow, RoomRow, SessionEventInsert, SessionRow, SessionStore, StreamRow, StreamSpec } from '../sessions/SessionStore.js';

const ACTIVE_STATES: ReadonlyArray<SessionState> = ['starting', 'live', 'interrupted', 'finishing'];

/** In-memory store with a controllable clock, injectable failures, and per-call latency. */
export class FakeStore implements SessionStore {
  rooms: RoomRow[] = [];
  sessions = new Map<string, SessionRow>();
  streams: StreamRow[] = [];
  chunks: FinalChunkRow[] = [];
  events: SessionEventInsert[] = [];
  clock: () => number = () => Date.now();
  /** When set, the next matching operations reject. Keyed by method name; value = remaining failures (Infinity = always). */
  failures = new Map<string, number>();
  latency: (op: string) => number = () => 0;
  /** Hook run before an insert commits, to simulate long statements. */
  beforeInsert: ((rows: FinalChunkInsert[]) => Promise<void>) | null = null;
  calls: string[] = [];
  private nextStreamId = 1;
  private nextRoomId = 1;

  private async guard(name: string) {
    this.calls.push(name);
    const remaining = this.failures.get(name);
    if (remaining !== undefined && remaining > 0) {
      if (remaining !== Infinity) this.failures.set(name, remaining - 1);
      throw new Error(`fake failure: ${name}`);
    }
    const delay = this.latency(name);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }

  private now(): Date {
    return new Date(this.clock());
  }

  async upsertRoom(slug: string, name: string): Promise<RoomRow> {
    await this.guard('upsertRoom');
    let room = this.rooms.find((r) => r.slug === slug);
    if (!room) {
      room = { id: this.nextRoomId++, slug, name, visibleSessionId: null };
      this.rooms.push(room);
    }
    return { ...room };
  }
  async listRooms(): Promise<RoomRow[]> {
    await this.guard('listRooms');
    return this.rooms.map((r) => ({ ...r }));
  }
  async getRoomBySlug(slug: string): Promise<RoomRow | null> {
    await this.guard('getRoomBySlug');
    const r = this.rooms.find((x) => x.slug === slug);
    return r ? { ...r } : null;
  }
  async createSession(input: { roomId: number; title: string; sourceLanguage: SourceLanguage; streams: ReadonlyArray<StreamSpec> }) {
    await this.guard('createSession');
    const session: SessionRow = {
      id: randomUUID(),
      roomId: input.roomId,
      title: input.title,
      sourceLanguage: input.sourceLanguage,
      state: 'prepared',
      cause: null,
      startedAt: null,
      finishingAt: null,
      endedAt: null,
      effectiveConfig: null,
      completeness: null,
      providerGeneration: 0,
      createdAt: this.now(),
    };
    this.sessions.set(session.id, session);
    const streams = input.streams.map((spec) => {
      const s: StreamRow = { id: this.nextStreamId++, sessionId: session.id, outputType: spec.outputType, language: spec.language, publishedSeq: null };
      this.streams.push(s);
      return { ...s };
    });
    return { session: { ...session }, streams };
  }
  async getSession(id: string): Promise<SessionRow | null> {
    await this.guard('getSession');
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }
  async listSessions(roomId: number, limit: number): Promise<SessionRow[]> {
    await this.guard('listSessions');
    return [...this.sessions.values()].filter((s) => s.roomId === roomId).reverse().slice(0, limit).map((s) => ({ ...s }));
  }
  async listUnfinishedSessions(): Promise<SessionRow[]> {
    await this.guard('listUnfinishedSessions');
    return [...this.sessions.values()].filter((s) => ACTIVE_STATES.includes(s.state)).map((s) => ({ ...s }));
  }
  async loadStreams(sessionId: string): Promise<StreamRow[]> {
    await this.guard('loadStreams');
    return this.streams.filter((s) => s.sessionId === sessionId).map((s) => ({ ...s }));
  }
  async startSession(id: string, effectiveConfig: Record<string, unknown>): Promise<SessionRow | null> {
    await this.guard('startSession');
    const s = this.sessions.get(id);
    if (!s || s.state !== 'prepared') return null;
    // The partial unique index `event_sessions_one_active_per_room`: a second start in the room fails with 23505.
    if ([...this.sessions.values()].some((x) => x.roomId === s.roomId && x.id !== id && ACTIVE_STATES.includes(x.state))) {
      throw Object.assign(new Error('duplicate key value violates unique constraint "event_sessions_one_active_per_room"'), { code: '23505' });
    }
    s.state = 'starting';
    s.startedAt = this.now();
    s.effectiveConfig = effectiveConfig;
    return { ...s };
  }
  async findBlockingSession(roomId: number, exceptId: string): Promise<SessionRow | null> {
    await this.guard('findBlockingSession');
    const s = [...this.sessions.values()].find((x) => x.roomId === roomId && x.id !== exceptId && ACTIVE_STATES.includes(x.state));
    return s ? { ...s } : null;
  }
  async markLive(id: string, roomId: number, makeVisible: boolean): Promise<boolean> {
    await this.guard('markLive');
    const s = this.sessions.get(id);
    if (!s || (s.state !== 'starting' && s.state !== 'interrupted')) return false;
    s.state = 'live';
    s.cause = null;
    if (makeVisible) {
      const room = this.rooms.find((r) => r.id === roomId);
      if (room) room.visibleSessionId = id;
    }
    return true;
  }
  async markInterrupted(id: string, cause: InterruptionCause): Promise<void> {
    await this.guard('markInterrupted');
    const s = this.sessions.get(id);
    if (s && (s.state === 'starting' || s.state === 'live' || s.state === 'interrupted')) {
      s.state = 'interrupted';
      s.cause = cause;
    }
  }
  async markFinishing(id: string): Promise<Date | null> {
    await this.guard('markFinishing');
    const s = this.sessions.get(id);
    if (!s || s.state === 'finished') return null;
    const at = this.now();
    s.state = 'finishing';
    s.finishingAt = at;
    return at;
  }
  async markFinished(id: string, completeness: Completeness | null, publishedSeqs: Array<{ streamId: number; publishedSeq: number | null }>): Promise<void> {
    await this.guard('markFinished');
    const s = this.sessions.get(id);
    if (s) {
      s.state = 'finished';
      s.cause = null;
      s.endedAt = this.now();
      s.completeness = completeness;
    }
    for (const p of publishedSeqs) {
      const stream = this.streams.find((x) => x.id === p.streamId);
      if (stream) stream.publishedSeq = p.publishedSeq;
    }
  }
  async setProviderGeneration(id: string, generation: number): Promise<void> {
    await this.guard('setProviderGeneration');
    const s = this.sessions.get(id);
    if (s) s.providerGeneration = generation;
  }
  async insertFinals(rows: FinalChunkInsert[]): Promise<Array<{ streamId: number; seq: number }>> {
    await this.guard('insertFinals');
    if (this.beforeInsert) await this.beforeInsert(rows);
    const persisted: Array<{ streamId: number; seq: number }> = [];
    for (const r of rows) {
      if (this.chunks.some((c) => c.streamId === r.streamId && c.seq === r.seq)) continue;
      this.chunks.push({ ...r, persistedAt: this.now() });
      persisted.push({ streamId: r.streamId, seq: r.seq });
    }
    return persisted;
  }
  async readBack(streamId: number, seq: number) {
    await this.guard('readBack');
    const c = this.chunks.find((x) => x.streamId === streamId && x.seq === seq);
    return c ? { text: c.text, providerGeneration: c.providerGeneration } : null;
  }
  async insertEvent(event: SessionEventInsert): Promise<void> {
    await this.guard('insertEvent');
    if (this.events.some((e) => e.sessionId === event.sessionId && e.seq === event.seq)) return;
    this.events.push(event);
  }
  async listEvents(sessionId: string) {
    await this.guard('listEvents');
    return this.events.filter((e) => e.sessionId === sessionId).map((e) => ({ seq: e.seq, kind: e.kind, detail: e.detail, at: e.at }));
  }
  async streamCounters(streamId: number) {
    await this.guard('streamCounters');
    const rows = this.chunks.filter((c) => c.streamId === streamId);
    return { maxSeq: rows.reduce((m, r) => Math.max(m, r.seq), 0), maxSegmentSeq: rows.reduce((m, r) => Math.max(m, r.segmentSeq), 0) };
  }
  async eventCounter(sessionId: string): Promise<number> {
    await this.guard('eventCounter');
    return this.events.filter((e) => e.sessionId === sessionId).reduce((m, e) => Math.max(m, e.seq), 0);
  }
  async loadWindow(streamId: number, segments: number, publishedSeq: number | null): Promise<FinalChunkRow[]> {
    await this.guard('loadWindow');
    const rows = this.chunks.filter((c) => c.streamId === streamId && (publishedSeq === null || c.seq <= publishedSeq)).sort((a, b) => a.seq - b.seq);
    const segs = [...new Set(rows.map((r) => r.segmentSeq))].sort((a, b) => b - a).slice(0, segments);
    return rows.filter((r) => segs.includes(r.segmentSeq)).map((r) => ({ ...r }));
  }
  async seqsAroundBound(streamId: number, bound: Date) {
    await this.guard('seqsAroundBound');
    const rows = this.chunks.filter((c) => c.streamId === streamId);
    const within = rows.filter((r) => r.persistedAt.getTime() <= bound.getTime());
    const after = rows.filter((r) => r.persistedAt.getTime() > bound.getTime()).map((r) => r.seq).sort((a, b) => a - b);
    return { maxSeqWithin: within.length ? Math.max(...within.map((r) => r.seq)) : null, seqsAfter: after };
  }

  chunksOf(streamId: number): FinalChunkRow[] {
    return this.chunks.filter((c) => c.streamId === streamId).sort((a, b) => a.seq - b.seq);
  }
}

/** Fake provider connection driven by the test. */
export class FakeProvider extends EventEmitter implements ProviderConnection {
  audio: Buffer[] = [];
  ended = false;
  terminated = false;
  keepalives = 0;
  opened = false;
  bufferedAmount = 0;
  openBehavior: 'resolve' | 'reject' | 'hang' | 'deferred' = 'resolve';
  /** With `deferred`, completes a pending open. */
  resolveOpen: () => void = () => undefined;

  constructor(readonly input: ProviderConfigInput) {
    super();
  }

  get isOpen(): boolean {
    return this.opened && !this.terminated;
  }

  open(): Promise<void> {
    if (this.openBehavior === 'reject') return Promise.reject(new Error('open failed'));
    if (this.openBehavior === 'hang') return new Promise(() => undefined);
    if (this.openBehavior === 'deferred') {
      return new Promise((resolve) => {
        this.resolveOpen = () => {
          this.opened = true;
          resolve();
        };
      });
    }
    this.opened = true;
    return Promise.resolve();
  }
  sendAudio(pcm: Buffer): void {
    this.audio.push(pcm);
  }
  endAudio(): void {
    this.ended = true;
  }
  keepalive(): void {
    this.keepalives++;
  }
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    queueMicrotask(() => this.emit('close', 1006, 'terminated'));
  }
  /** Test helpers */
  respond(response: SonioxResponse) {
    this.emit('response', response);
  }
  closeFromServer(code = 1006, reason = 'gone') {
    this.terminated = true;
    this.emit('close', code, reason);
  }
  deliveredSamples(): number {
    return this.audio.reduce((n, b) => n + b.length / 2, 0);
  }
}

export function fakeProviderFactory(onCreate?: (p: FakeProvider) => void): ProviderFactory & { all: FakeProvider[]; openBehavior: FakeProvider['openBehavior'] } {
  const all: FakeProvider[] = [];
  const factory = ((input: ProviderConfigInput) => {
    const p = new FakeProvider(input);
    p.openBehavior = factory.openBehavior;
    all.push(p);
    onCreate?.(p);
    return p;
  }) as ProviderFactory & { all: FakeProvider[]; openBehavior: FakeProvider['openBehavior'] };
  factory.all = all;
  factory.openBehavior = 'resolve';
  return factory;
}

export function finalToken(text: string, opts: Partial<{ translation: boolean; start: number; end: number }> = {}) {
  return {
    text,
    is_final: true,
    ...(opts.translation ? { translation_status: 'translation' as const, language: 'es' } : { translation_status: 'original' as const, language: 'en', start_ms: opts.start ?? 0, end_ms: opts.end ?? 0 }),
  };
}

export function partialToken(text: string, translation = false) {
  return { text, is_final: false, ...(translation ? { translation_status: 'translation' as const } : { translation_status: 'original' as const }) };
}

export const endToken = { text: '<end>', is_final: true, translation_status: 'none' as const, confidence: 1 };

export function frameOf(samplePosition: number, samples = 1600, seq = 0) {
  return { seq, samplePosition, pcm: new Int16Array(samples) };
}

/** Sender link that records what a runtime sends and its first close. */
export function fakeLink(id = 1) {
  const link = {
    id,
    sent: [] as SenderServerMessage[],
    closed: null as { code: number; reason: string } | null,
    send(m: SenderServerMessage) {
      this.sent.push(m);
    },
    close(code: number, reason: string) {
      if (!this.closed) this.closed = { code, reason };
    },
  };
  return link as SenderLink & typeof link;
}

export async function flush(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}
