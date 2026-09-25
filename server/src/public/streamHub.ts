import type { ServerResponse } from 'node:http';
import {
  encodeCursor,
  parseCursor,
  type GapMarker,
  type OutputType,
  type PartialEvent,
  type PublicRoom,
  type RoomSummary,
  type SessionSummary,
  type SnapshotEvent,
  type SnapshotSegment,
  type StateEvent,
  type StorageStatus,
} from '@nerditulos/shared';
import type { Logger } from '../log.js';

export interface RingRow {
  seq: number;
  segmentSeq: number;
  text: string;
  receivedAt: number;
  publishedAt: number;
}

export interface HubStream {
  outputType: OutputType;
  language: string;
  rows: RingRow[];
  latestSeq: number;
  currentSegmentSeq: number;
  partial: PartialEvent | null;
  gaps: GapMarker[];
}

export interface HubSession {
  summary: SessionSummary;
  storage: StorageStatus;
  /** Keyed by language: within a session each offered language maps to exactly one stream. */
  streams: Map<string, HubStream>;
}

export function createHubStream(outputType: OutputType, language: string): HubStream {
  return { outputType, language, rows: [], latestSeq: 0, currentSegmentSeq: 0, partial: null, gaps: [] };
}

export interface HubOptions {
  publicWindowSegments: number;
  log: Logger;
  now?: () => number;
  pingIntervalMs?: number;
  stallTimeoutMs?: number;
  maxWritableLength?: number;
}

// Slow reader limits (recorded in the report): a backpressured write is allowed 5 s to drain,
// and a reader whose pending buffer exceeds 256 KB is destroyed immediately.
const DEFAULT_STALL_TIMEOUT_MS = 5000;
const DEFAULT_MAX_WRITABLE = 256 * 1024;

export function sseFrame(event: string, data: unknown, id?: string): string {
  let frame = '';
  if (id !== undefined) frame += `id: ${id}\n`;
  frame += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return frame;
}

class Subscriber {
  backpressured = false;
  closed = false;
  private stallTimer: NodeJS.Timeout | null = null;
  private skippedPartial: PartialEvent | null = null;

  constructor(
    readonly id: number,
    readonly room: string,
    readonly lang: string,
    readonly res: ServerResponse,
    private readonly opts: { stallTimeoutMs: number; maxWritableLength: number; log: Logger; onClose: () => void },
  ) {
    res.on('drain', () => this.onDrain());
    res.on('close', () => this.close());
    res.on('error', () => this.close());
  }

  write(chunk: string): void {
    if (this.closed) return;
    if (this.res.writableLength > this.opts.maxWritableLength) {
      this.opts.log.warn('sse reader destroyed: buffer limit', { room: this.room, lang: this.lang, subscriber: this.id });
      this.destroy();
      return;
    }
    const ok = this.res.write(chunk);
    if (!ok && !this.backpressured) {
      this.backpressured = true;
      this.stallTimer = setTimeout(() => {
        this.opts.log.warn('sse reader destroyed: stalled', { room: this.room, lang: this.lang, subscriber: this.id });
        this.destroy();
      }, this.opts.stallTimeoutMs);
    }
  }

  /** Partials are skipped while backpressured; the latest one is resent on drain. */
  writePartial(partial: PartialEvent): void {
    if (this.closed) return;
    if (this.backpressured) {
      this.skippedPartial = partial;
      return;
    }
    this.write(sseFrame('partial', partial));
  }

  /** A skipped partial belongs to the text window it was published for; a session switch or a fresh partial supersedes it. */
  clearSkippedPartial(): void {
    this.skippedPartial = null;
  }

  private onDrain() {
    this.backpressured = false;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    const skipped = this.skippedPartial;
    this.skippedPartial = null;
    if (skipped) this.write(sseFrame('partial', skipped));
  }

  destroy() {
    if (this.closed) return;
    this.res.destroy();
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    this.opts.onClose();
  }
}

interface RoomEntry {
  room: RoomSummary;
  session: HubSession | null;
  subscribers: Set<Subscriber>;
}

/**
 * In-memory map room -> visible session -> streams, the only source for public reads.
 * Every publish method is synchronous: snapshot construction, registration, and the
 * first write happen in one tick, so a reader never misses a row between them.
 */
export class StreamHub {
  private readonly rooms = new Map<string, RoomEntry>();
  private nextSubscriberId = 1;
  private readonly now: () => number;
  private readonly pingTimer: NodeJS.Timeout;

  constructor(private readonly opts: HubOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.pingTimer = setInterval(() => this.ping(), opts.pingIntervalMs ?? 15000);
    this.pingTimer.unref();
  }

  close() {
    clearInterval(this.pingTimer);
    for (const entry of this.rooms.values()) for (const s of entry.subscribers) s.destroy();
  }

  setRoom(room: RoomSummary) {
    const existing = this.rooms.get(room.slug);
    if (existing) existing.room = room;
    else this.rooms.set(room.slug, { room, session: null, subscribers: new Set() });
  }

  hasRoom(slug: string): boolean {
    return this.rooms.has(slug);
  }

  subscriberCount(slug: string): number {
    return this.rooms.get(slug)?.subscribers.size ?? 0;
  }

  getSession(slug: string): HubSession | null {
    return this.rooms.get(slug)?.session ?? null;
  }

  getPublicRoom(slug: string): PublicRoom | null {
    const entry = this.rooms.get(slug);
    if (!entry) return null;
    return { room: entry.room, session: entry.session ? entry.session.summary : null };
  }

  listPublicRooms(): PublicRoom[] {
    return [...this.rooms.values()]
      .sort((a, b) => a.room.index - b.room.index)
      .map((e) => ({ room: e.room, session: e.session ? e.session.summary : null }));
  }

  /** Boot warm-up: installs a session without notifying anyone. */
  installSession(slug: string, session: HubSession | null) {
    const entry = this.rooms.get(slug);
    if (!entry) throw new Error(`unknown room ${slug}`);
    entry.session = session;
  }

  /** Session switch: every reader gets `session`; offered languages also get an empty-window snapshot. */
  switchSession(slug: string, session: HubSession) {
    const entry = this.rooms.get(slug);
    if (!entry) throw new Error(`unknown room ${slug}`);
    entry.session = session;
    for (const sub of entry.subscribers) {
      sub.clearSkippedPartial();
      sub.write(sseFrame('session', session.summary));
      const stream = session.streams.get(sub.lang);
      if (stream) this.writeSnapshot(sub, session, stream);
    }
  }

  private summaryOf(slug: string, sessionId: string): { entry: RoomEntry; session: HubSession } | null {
    const entry = this.rooms.get(slug);
    if (!entry || !entry.session || entry.session.summary.sessionId !== sessionId) return null;
    return { entry, session: entry.session };
  }

  publishFinal(slug: string, sessionId: string, lang: string, row: RingRow): boolean {
    const found = this.summaryOf(slug, sessionId);
    if (!found) return false;
    const stream = found.session.streams.get(lang);
    if (!stream) return false;
    stream.rows.push(row);
    stream.latestSeq = Math.max(stream.latestSeq, row.seq);
    stream.currentSegmentSeq = Math.max(stream.currentSegmentSeq, row.segmentSeq);
    this.trim(stream);
    const id = encodeCursor({ sessionId, outputType: stream.outputType, language: stream.language, seq: row.seq });
    const frame = sseFrame('final', { seq: row.seq, segmentSeq: row.segmentSeq, text: row.text, receivedAt: row.receivedAt, publishedAt: row.publishedAt }, id);
    for (const sub of found.entry.subscribers) if (sub.lang === lang) sub.write(frame);
    return true;
  }

  publishPartial(slug: string, sessionId: string, lang: string, partial: PartialEvent): boolean {
    const found = this.summaryOf(slug, sessionId);
    if (!found) return false;
    const stream = found.session.streams.get(lang);
    if (!stream) return false;
    stream.partial = partial;
    for (const sub of found.entry.subscribers) if (sub.lang === lang) sub.writePartial(partial);
    return true;
  }

  publishState(slug: string, sessionId: string, event: StateEvent): boolean {
    const found = this.summaryOf(slug, sessionId);
    if (!found) return false;
    found.session.summary.state = event.state;
    found.session.summary.cause = event.cause;
    found.session.summary.completeness = event.completeness;
    found.session.storage = event.storage;
    const frame = sseFrame('state', event);
    for (const sub of found.entry.subscribers) sub.write(frame);
    return true;
  }

  /** Records a discontinuity after each stream's latest seq and tells readers through `state`. */
  publishGap(slug: string, sessionId: string, extent: number | 'unknown', state: Omit<StateEvent, 'gap'>): boolean {
    const found = this.summaryOf(slug, sessionId);
    if (!found) return false;
    for (const [lang, stream] of found.session.streams) {
      const gap: GapMarker = { afterSeq: stream.latestSeq, extent };
      stream.gaps.push(gap);
      const frame = sseFrame('state', { ...state, gap });
      for (const sub of found.entry.subscribers) if (sub.lang === lang) sub.write(frame);
    }
    return true;
  }

  /**
   * Registers a reader and writes its first events synchronously. `Last-Event-ID` (or `after`)
   * yields a delta only when it belongs to the visible session's stream for `lang` and lies
   * inside the ring; any other cursor gets a snapshot and never an error.
   */
  subscribe(slug: string, lang: string, cursorText: string | null, res: ServerResponse): boolean {
    const entry = this.rooms.get(slug);
    if (!entry) return false;
    const sub = new Subscriber(this.nextSubscriberId++, slug, lang, res, {
      stallTimeoutMs: this.opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
      maxWritableLength: this.opts.maxWritableLength ?? DEFAULT_MAX_WRITABLE,
      log: this.opts.log,
      onClose: () => {
        entry.subscribers.delete(sub);
      },
    });
    entry.subscribers.add(sub);
    const session = entry.session;
    sub.write(sseFrame('session', session ? session.summary : null));
    if (!session) return true;
    const stream = session.streams.get(lang);
    if (!stream) return true;
    const cursor = parseCursor(cursorText);
    const oldest = stream.rows[0]?.seq ?? null;
    const valid =
      cursor !== null &&
      cursor.sessionId === session.summary.sessionId &&
      cursor.outputType === stream.outputType &&
      cursor.language === stream.language &&
      (oldest === null ? cursor.seq <= stream.latestSeq : cursor.seq >= oldest - 1) &&
      cursor.seq <= stream.latestSeq;
    if (valid) {
      for (const row of stream.rows) {
        if (row.seq <= cursor.seq) continue;
        const id = encodeCursor({ sessionId: session.summary.sessionId, outputType: stream.outputType, language: stream.language, seq: row.seq });
        sub.write(sseFrame('final', { seq: row.seq, segmentSeq: row.segmentSeq, text: row.text, receivedAt: row.receivedAt, publishedAt: row.publishedAt }, id));
      }
      this.writeStateAndPartial(sub, session, stream);
    } else {
      this.writeSnapshot(sub, session, stream);
    }
    return true;
  }

  buildSnapshot(session: HubSession, stream: HubStream): { id: string; snapshot: SnapshotEvent } {
    const segments: SnapshotSegment[] = [];
    for (const row of stream.rows) {
      const last = segments[segments.length - 1];
      if (last && last.segmentSeq === row.segmentSeq) last.rows.push({ seq: row.seq, text: row.text });
      else segments.push({ segmentSeq: row.segmentSeq, rows: [{ seq: row.seq, text: row.text }] });
    }
    const latest = stream.rows[stream.rows.length - 1];
    const id = latest
      ? encodeCursor({ sessionId: session.summary.sessionId, outputType: stream.outputType, language: stream.language, seq: latest.seq })
      : '';
    const snapshot: SnapshotEvent = {
      session: session.summary,
      stream: { outputType: stream.outputType, language: stream.language },
      segments,
      partial: stream.partial
        ? { segmentSeq: stream.partial.segmentSeq, text: stream.partial.text }
        : { segmentSeq: stream.currentSegmentSeq, text: '' },
      gaps: stream.gaps.filter((g) => g.afterSeq >= (stream.rows[0]?.seq ?? 0) - 1),
      storage: session.storage,
    };
    return { id, snapshot };
  }

  private writeSnapshot(sub: Subscriber, session: HubSession, stream: HubStream) {
    const { id, snapshot } = this.buildSnapshot(session, stream);
    sub.write(sseFrame('snapshot', snapshot, id));
    this.writeStateAndPartial(sub, session, stream);
  }

  private writeStateAndPartial(sub: Subscriber, session: HubSession, stream: HubStream) {
    const state: StateEvent = {
      state: session.summary.state,
      cause: session.summary.cause,
      completeness: session.summary.completeness,
      storage: session.storage,
    };
    sub.write(sseFrame('state', state));
    const partial: PartialEvent = stream.partial ?? {
      segmentSeq: stream.currentSegmentSeq,
      text: '',
      receivedAt: this.now(),
      publishedAt: this.now(),
    };
    sub.clearSkippedPartial();
    sub.write(sseFrame('partial', partial));
  }

  private trim(stream: HubStream) {
    const limit = this.opts.publicWindowSegments;
    const seen: number[] = [];
    for (let i = stream.rows.length - 1; i >= 0; i--) {
      const seg = (stream.rows[i] as RingRow).segmentSeq;
      if (seen[seen.length - 1] !== seg) seen.push(seg);
      if (seen.length > limit) {
        stream.rows.splice(0, i + 1);
        break;
      }
    }
    const oldest = stream.rows[0]?.seq ?? 0;
    stream.gaps = stream.gaps.filter((g) => g.afterSeq >= oldest - 1);
  }

  private ping() {
    for (const entry of this.rooms.values()) for (const sub of entry.subscribers) sub.write(': ping\n\n');
  }
}
