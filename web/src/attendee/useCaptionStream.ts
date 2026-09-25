import { useEffect, useReducer, useRef } from 'react';
import { defaultLanguage, encodeCursor, type FinalEvent, type GapMarker, type PartialEvent, type SessionSummary, type SnapshotEvent, type StateEvent, type StorageStatus } from '@nerditulos/shared';

export interface CaptionRow {
  seq: number;
  text: string;
}

export interface CaptionSegment {
  segmentSeq: number;
  rows: CaptionRow[];
  gapAfter?: GapMarker;
}

export interface CaptionState {
  session: SessionSummary | null;
  sessionKnown: boolean;
  stream: { outputType: 'original' | 'translation'; language: string } | null;
  segments: CaptionSegment[];
  partial: { segmentSeq: number; text: string };
  gaps: GapMarker[];
  storage: StorageStatus;
  connection: 'connecting' | 'open' | 'reconnecting';
  lastSeq: number;
  /** Increments on every content change; effects use it to schedule display timing. */
  version: number;
  languageOffered: boolean;
}

export type CaptionAction =
  | { type: 'session'; session: SessionSummary | null; offered: boolean }
  | { type: 'snapshot'; snapshot: SnapshotEvent }
  | { type: 'final'; event: FinalEvent; windowSegments: number }
  | { type: 'partial'; event: PartialEvent }
  | { type: 'state'; event: StateEvent }
  | { type: 'connection'; connection: CaptionState['connection'] };

export const initialCaptionState: CaptionState = {
  session: null,
  sessionKnown: false,
  stream: null,
  segments: [],
  partial: { segmentSeq: 0, text: '' },
  gaps: [],
  storage: 'ok',
  connection: 'connecting',
  lastSeq: 0,
  version: 0,
  languageOffered: true,
};

export function reduceCaption(state: CaptionState, action: CaptionAction): CaptionState {
  switch (action.type) {
    case 'session': {
      const switching = state.session?.sessionId !== action.session?.sessionId;
      return {
        ...state,
        session: action.session,
        sessionKnown: true,
        languageOffered: action.offered,
        ...(switching ? { segments: [], partial: { segmentSeq: 0, text: '' }, gaps: [], lastSeq: 0, stream: null } : {}),
        version: state.version + 1,
      };
    }
    case 'snapshot': {
      const s = action.snapshot;
      const segments = s.segments.map((seg) => ({ segmentSeq: seg.segmentSeq, rows: seg.rows.map((r) => ({ seq: r.seq, text: r.text })) }));
      const last = segments[segments.length - 1];
      const lastSeq = last ? (last.rows[last.rows.length - 1]?.seq ?? 0) : 0;
      return {
        ...state,
        session: s.session,
        sessionKnown: true,
        stream: s.stream,
        segments: applyGaps(segments, s.gaps),
        partial: s.partial,
        gaps: s.gaps,
        storage: s.storage,
        lastSeq,
        version: state.version + 1,
      };
    }
    case 'final': {
      const e = action.event;
      if (e.seq <= state.lastSeq) return state;
      const segments = state.segments.map((seg) => ({ ...seg, rows: [...seg.rows] }));
      const last = segments[segments.length - 1];
      if (last && last.segmentSeq === e.segmentSeq) last.rows.push({ seq: e.seq, text: e.text });
      else segments.push({ segmentSeq: e.segmentSeq, rows: [{ seq: e.seq, text: e.text }] });
      // Same window as the server's: the oldest segments leave; there is no history to scroll back to.
      if (segments.length > action.windowSegments) segments.splice(0, segments.length - action.windowSegments);
      const firstSeq = segments[0]?.rows[0]?.seq ?? e.seq;
      const gaps = state.gaps.filter((g) => g.afterSeq >= firstSeq);
      // Partial belonging to this segment is superseded only when the server sends the next partial.
      return { ...state, segments: applyGaps(segments, gaps), gaps, lastSeq: e.seq, version: state.version + 1 };
    }
    case 'partial':
      return { ...state, partial: { segmentSeq: action.event.segmentSeq, text: action.event.text }, version: state.version + 1 };
    case 'state': {
      const e = action.event;
      const session = state.session ? { ...state.session, state: e.state, cause: e.cause, completeness: e.completeness } : state.session;
      let segments = state.segments;
      let gaps = state.gaps;
      if (e.gap) {
        gaps = [...gaps, e.gap];
        segments = applyGaps(segments.map((s) => ({ ...s })), gaps);
      }
      return { ...state, session, storage: e.storage, segments, gaps, version: state.version + 1 };
    }
    case 'connection':
      return state.connection === action.connection ? state : { ...state, connection: action.connection };
    default:
      return state;
  }
}

function applyGaps(segments: CaptionSegment[], gaps: GapMarker[]): CaptionSegment[] {
  for (const seg of segments) delete seg.gapAfter;
  for (const gap of gaps) {
    const seg = [...segments].reverse().find((s) => (s.rows[s.rows.length - 1]?.seq ?? -1) <= gap.afterSeq);
    if (seg) seg.gapAfter = gap;
  }
  return segments;
}

/** Whether `lang` is one of the session's streams. With no session yet, any language is provisionally offered. */
export function languageOfferedBy(session: SessionSummary | null, lang: string): boolean {
  return !session || session.availableLanguages.some((l) => l.lang === lang);
}

/**
 * The stream a reader whose language is `reader` subscribes to: that language while no session is known or
 * when the session offers it, otherwise the session's default stream. A session without streams keeps the
 * reader's language so the subscription stays open for the next session.
 */
export function streamLanguageFor(reader: string, session: SessionSummary | null): string {
  if (!session || languageOfferedBy(session, reader)) return reader;
  return defaultLanguage(session.availableLanguages) ?? reader;
}

export interface CaptionDebugLine {
  outputType: string;
  language: string;
  state: 'partial' | 'final';
  seq: number | null;
  segmentSeq: number;
  receiveAt: number;
  receivedAt?: number;
  publishedAt?: number;
  text: string;
}

/** Subscribes to a room's caption stream for one language and keeps the last `windowSegments` segments. */
export function useCaptionStream(slug: string, lang: string | null, windowSegments: number, onDebug?: (line: CaptionDebugLine) => void): CaptionState {
  const [state, dispatch] = useReducer(reduceCaption, initialCaptionState);
  const windowRef = useRef<{ sessionId: string | null; stream: CaptionState['stream']; lastSeq: number }>({ sessionId: null, stream: null, lastSeq: 0 });
  windowRef.current = { sessionId: state.session?.sessionId ?? null, stream: state.stream, lastSeq: state.lastSeq };

  useEffect(() => {
    if (!lang) return;
    let source: EventSource | null = null;
    let closed = false;
    let backoff = 2000;
    let retryTimer: number | null = null;

    const open = (withCursor: boolean) => {
      if (closed) return;
      const w = windowRef.current;
      const params = new URLSearchParams({ lang });
      if (withCursor && w.sessionId && w.stream && w.lastSeq > 0) {
        params.set('after', encodeCursor({ sessionId: w.sessionId, outputType: w.stream.outputType, language: w.stream.language, seq: w.lastSeq }));
      }
      const es = new EventSource(`/api/rooms/${encodeURIComponent(slug)}/stream?${params.toString()}`);
      source = es;
      es.onopen = () => {
        backoff = 2000;
        dispatch({ type: 'connection', connection: 'open' });
        dispatch({ type: 'partial', event: { segmentSeq: windowRef.current.lastSeq, text: '', receivedAt: 0, publishedAt: 0 } });
      };
      es.addEventListener('session', (ev) => {
        const session = JSON.parse((ev as MessageEvent).data) as SessionSummary | null;
        dispatch({ type: 'session', session, offered: languageOfferedBy(session, lang) });
      });
      es.addEventListener('snapshot', (ev) => {
        const snapshot = JSON.parse((ev as MessageEvent).data) as SnapshotEvent;
        dispatch({ type: 'snapshot', snapshot });
      });
      es.addEventListener('final', (ev) => {
        const event = JSON.parse((ev as MessageEvent).data) as FinalEvent;
        dispatch({ type: 'final', event, windowSegments });
        onDebug?.({ outputType: windowRef.current.stream?.outputType ?? '', language: lang, state: 'final', seq: event.seq, segmentSeq: event.segmentSeq, receiveAt: Date.now(), receivedAt: event.receivedAt, publishedAt: event.publishedAt, text: event.text });
      });
      es.addEventListener('partial', (ev) => {
        const event = JSON.parse((ev as MessageEvent).data) as PartialEvent;
        dispatch({ type: 'partial', event });
        onDebug?.({ outputType: windowRef.current.stream?.outputType ?? '', language: lang, state: 'partial', seq: null, segmentSeq: event.segmentSeq, receiveAt: Date.now(), receivedAt: event.receivedAt, publishedAt: event.publishedAt, text: event.text });
      });
      es.addEventListener('state', (ev) => {
        dispatch({ type: 'state', event: JSON.parse((ev as MessageEvent).data) as StateEvent });
      });
      es.onerror = () => {
        if (closed) return;
        dispatch({ type: 'connection', connection: 'reconnecting' });
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          retryTimer = window.setTimeout(() => open(true), backoff);
          backoff = Math.min(backoff * 2, 10000);
        }
      };
    };

    dispatch({ type: 'connection', connection: 'connecting' });
    open(false);
    return () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      source?.close();
    };
    // onDebug is intentionally excluded: it is a stable ref-backed callback in callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, lang, windowSegments]);

  return state;
}
