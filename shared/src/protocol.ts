// Wire contracts shared by the Node service and the browser.
// Keep this file free of runtime dependencies.

export type SourceLanguage = 'es' | 'en';
export type OutputType = 'original' | 'translation';
export type SessionState = 'prepared' | 'starting' | 'live' | 'interrupted' | 'finishing' | 'finished';
export type InterruptionCause =
  | 'sender_lost'
  | 'provider_error'
  | 'provider_unavailable'
  | 'storage_unavailable'
  | 'interrupted_on_restart';
export type Completeness = 'complete' | 'incomplete';
export type StorageStatus = 'ok' | 'failing';

export const AUDIO_SAMPLE_RATE = 16000;
export const CHUNK_SAMPLES = 1600;

export interface AudioFormat {
  encoding: 'pcm_s16le';
  sampleRate: 16000;
  channels: 1;
  chunkSamples: 1600;
}

/** The only format the sender socket accepts. */
export const AUDIO_FORMAT: AudioFormat = { encoding: 'pcm_s16le', sampleRate: AUDIO_SAMPLE_RATE, channels: 1, chunkSamples: CHUNK_SAMPLES };

export interface AvailableLanguage {
  /** Unique within the session; identifies the stream a reader subscribes to with `?lang=`. */
  lang: string;
  outputType: OutputType;
  label: string;
}

/** Default reader language: Spanish whenever it is offered. */
export function defaultLanguage(languages: AvailableLanguage[]): string | null {
  const es = languages.find((l) => l.lang === 'es');
  return es?.lang ?? languages[0]?.lang ?? null;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  sourceLanguage: SourceLanguage;
  state: SessionState;
  cause: InterruptionCause | null;
  completeness: Completeness | null;
  /** One entry per persisted stream of the session, originals first; never derived from the source language. */
  availableLanguages: AvailableLanguage[];
}

export interface RoomSummary {
  slug: string;
  name: string;
  index: number;
}

export interface PublicRoom {
  room: RoomSummary;
  session: SessionSummary | null;
}

export interface RuntimeConfig {
  clerkPublishableKey: string;
  eventName: string;
  adminConfigured: boolean;
  /** Segments per stream in the public reading window; readers keep no more than this. */
  publicWindowSegments: number;
  /** Pending-output allowance when a session finishes, shown in the finish dialog. */
  drainTimeoutMs: number;
}

// ---- Server-Sent Events (attendee delivery) ----

export interface SnapshotRow {
  seq: number;
  text: string;
}

export interface SnapshotSegment {
  segmentSeq: number;
  rows: SnapshotRow[];
}

export interface GapMarker {
  afterSeq: number;
  extent: number | 'unknown';
}

export interface SnapshotEvent {
  session: SessionSummary;
  stream: { outputType: OutputType; language: string };
  segments: SnapshotSegment[];
  partial: { segmentSeq: number; text: string };
  gaps: GapMarker[];
  storage: StorageStatus;
}

export interface FinalEvent {
  seq: number;
  segmentSeq: number;
  text: string;
  receivedAt: number;
  publishedAt: number;
}

export interface PartialEvent {
  segmentSeq: number;
  text: string;
  receivedAt: number;
  publishedAt: number;
}

export interface StateEvent {
  state: SessionState;
  cause: InterruptionCause | null;
  completeness: Completeness | null;
  storage: StorageStatus;
  gap?: GapMarker;
}

// ---- Sender WebSocket (administrator audio uplink) ----

export type EndReason = 'finish' | 'file_end';
export type DetachReason = 'device_lost';

/**
 * Source test: the console checks a room's audio source against the recognition provider without a
 * session. Nothing is persisted or published; the socket only echoes the recognized original text.
 */
export interface SourceTestTarget {
  room: string;
  sourceLanguage: SourceLanguage;
}

export type SourceTestEndReason = 'stopped' | 'provider_error' | 'provider_closed' | 'time_limit' | 'session_started';

export type SenderClientMessage =
  /** `sessionId` and `test` are exclusive: a session sender or a source test, never both. */
  | { type: 'auth'; token: string; sessionId?: string; test?: SourceTestTarget; format?: AudioFormat }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'end'; reason: EndReason }
  | { type: 'detach'; reason: DetachReason };

export type DiscontinuityKind = 'client_gap' | 'server_drop' | 'provider_unprocessed' | 'new_epoch' | 'restart';

export interface DiscontinuityDetail {
  epoch: number | null;
  kind: DiscontinuityKind;
  fromPosition?: number;
  toPosition?: number;
  extentSamples: number | 'unknown';
  /** When not exact, the range's start lies between `start` and `startMax`. */
  sourceRange?: { exact: boolean; start: number; startMax?: number; end: number };
  generation?: number;
  droppedSamples?: number;
  unprocessedSamples?: number;
  lastPersistedSeq?: Record<string, number>;
}

export type SenderServerMessage =
  | { type: 'ready'; epoch: number; expectedPosition: number }
  | { type: 'rejected'; reason: string; lastHeardAt?: number }
  | { type: 'ack'; seq: number; samplePosition: number; receivedAt: number }
  | { type: 'renew' }
  | { type: 'finishing' }
  | {
      type: 'state';
      state: SessionState;
      cause: InterruptionCause | null;
      completeness: Completeness | null;
      storage: StorageStatus;
    }
  | { type: 'discontinuity'; detail: DiscontinuityDetail }
  | { type: 'test'; state: 'listening' }
  /** `code` is the provider's error code or its close code, when there is one. */
  | { type: 'test'; state: 'ended'; reason: SourceTestEndReason; code?: number }
  /** `final` is the text finalized by this response (may be empty, keeps its leading space); `partial` replaces the previous hypothesis. */
  | { type: 'preview'; final: string; partial: string };

/**
 * Close reasons by code. The server sends the typed message (`rejected`, or `test ended` for a
 * source test) before closing.
 * 4404: session-not-joinable, missing-target, ambiguous-target, invalid-test, invalid-language, room-not-found, finished.
 * 4409: sender-active, generation-draining, storage-unavailable, room-busy, test-active.
 * 4410: detached, provider-error, provider-unavailable, storage-unavailable, provider-closed, time-limit, session-started.
 * 1000: stopped (source test ended by its sender).
 */
export const SENDER_CLOSE = {
  UNAUTHENTICATED: 4401,
  FORBIDDEN: 4403,
  NOT_JOINABLE: 4404,
  SENDER_ACTIVE: 4409,
  DETACHED: 4410,
  UNSUPPORTED_FORMAT: 4415,
  OVERSIZED: 1009,
} as const;

/** Close codes after which the sender must not retry automatically. */
export const SENDER_CLOSE_NO_RETRY: ReadonlySet<number> = new Set<number>([
  SENDER_CLOSE.FORBIDDEN,
  SENDER_CLOSE.NOT_JOINABLE,
  SENDER_CLOSE.UNSUPPORTED_FORMAT,
]);

// ---- Admin HTTP ----

/** Administrative view of a session. Offered languages are a public-stream concern and are not listed here. */
export interface SessionRecord extends Omit<SessionSummary, 'availableLanguages'> {
  roomSlug: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface AdminRoom extends RoomSummary {
  visibleSessionId: string | null;
  sessions: SessionRecord[];
}
