import type { AvailableLanguage, SessionSummary, SourceLanguage } from '@nerditulos/shared';
import type { Logger } from '../log.js';
import { createHubStream, type HubSession, type HubStream } from '../public/streamHub.js';
import type { SessionRow, SessionStore, StreamRow, StreamSpec } from './SessionStore.js';

type SummarySource = Pick<SessionRow, 'id' | 'title' | 'sourceLanguage' | 'state' | 'cause' | 'completeness'>;

const STREAM_LABELS: Record<string, string> = {
  'original:es': 'Español (original)',
  'original:en': 'English (original)',
  'translation:es': 'Español (traducción)',
  'translation:en': 'English (translation)',
};

/** One reader-facing entry per persisted stream, originals first. */
function offeredLanguages(streams: ReadonlyArray<StreamSpec>): AvailableLanguage[] {
  const ordered = [...streams.filter((s) => s.outputType === 'original'), ...streams.filter((s) => s.outputType !== 'original')];
  return ordered.map((s) => ({
    lang: s.language,
    outputType: s.outputType,
    label: STREAM_LABELS[`${s.outputType}:${s.language}`] ?? `${s.language} (${s.outputType})`,
  }));
}

/** The only constructor of `SessionSummary`: the languages offered to readers are the session's persisted streams. */
export function summaryOf(session: SummarySource, streams: ReadonlyArray<StreamSpec>): SessionSummary {
  return {
    sessionId: session.id,
    title: session.title,
    sourceLanguage: session.sourceLanguage,
    state: session.state,
    cause: session.cause,
    completeness: session.completeness,
    availableLanguages: offeredLanguages(streams),
  };
}

/**
 * Language the provider must translate into: that of the session's translation stream, or null when
 * the session has none. A translation stream in a language outside the provider contract is
 * reported and not requested: the provider would answer 400, which the runtime retries for the
 * whole failure window under a misleading cause.
 */
export function translationTargetOf(streams: ReadonlyArray<StreamSpec>, log: Logger): SourceLanguage | null {
  const translation = streams.find((s) => s.outputType === 'translation');
  if (!translation) return null;
  if (translation.language === 'es' || translation.language === 'en') return translation.language;
  log.error('translation stream language is not a supported target; no translation requested', { language: translation.language });
  return null;
}

/**
 * Builds the hub view of a session from storage: the last `windowSegments` segments per stream,
 * bounded by `published_seq` when the session is finished. Used at boot and after recovery.
 */
export async function warmHubSession(
  store: SessionStore,
  session: SessionRow,
  streams: StreamRow[],
  windowSegments: number,
): Promise<HubSession> {
  const hubStreams = new Map<string, HubStream>();
  for (const stream of streams) {
    const hubStream = createHubStream(stream.outputType, stream.language);
    // A finished stream without a watermark published nothing.
    const bound = session.state === 'finished' ? (stream.publishedSeq ?? 0) : null;
    const rows = await store.loadWindow(stream.id, windowSegments, bound);
    for (const row of rows) {
      hubStream.rows.push({
        seq: row.seq,
        segmentSeq: row.segmentSeq,
        text: row.text,
        receivedAt: row.receivedAt.getTime(),
        publishedAt: row.persistedAt.getTime(),
      });
    }
    const counters = await store.streamCounters(stream.id);
    hubStream.latestSeq = bound !== null ? Math.min(counters.maxSeq, bound) : counters.maxSeq;
    hubStream.currentSegmentSeq = rows.length > 0 ? (rows[rows.length - 1] as { segmentSeq: number }).segmentSeq : counters.maxSegmentSeq;
    hubStreams.set(stream.language, hubStream);
  }
  return { summary: summaryOf(session, streams), storage: 'ok', streams: hubStreams };
}

/**
 * Recovers a session found in `finishing` at boot: the finish transaction never committed, so
 * the window is fenced at `finishing_at + drainTimeoutMs` (both DB clock) and rows persisted
 * after that bound are recorded as never published. Rows whose statement began before the bound
 * but committed after it were included although no reader saw them; both cases are reported.
 */
export async function recoverFinishingSession(
  store: SessionStore,
  session: SessionRow,
  streams: StreamRow[],
  defaultDrainTimeoutMs: number,
  statementTimeoutMs: number,
  log: Logger,
): Promise<{ excluded: Record<string, number[]>; publishedSeqs: Array<{ streamId: number; publishedSeq: number | null }> }> {
  const configured = session.effectiveConfig?.drainTimeoutMs;
  const drainTimeoutMs = typeof configured === 'number' && configured > 0 ? configured : defaultDrainTimeoutMs;
  const finishingAt = session.finishingAt ?? session.startedAt ?? session.createdAt;
  const bound = new Date(finishingAt.getTime() + drainTimeoutMs);
  const publishedSeqs: Array<{ streamId: number; publishedSeq: number | null }> = [];
  const excluded: Record<string, number[]> = {};
  for (const stream of streams) {
    const around = await store.seqsAroundBound(stream.id, bound);
    // No row within the bound: nothing of this stream was published.
    publishedSeqs.push({ streamId: stream.id, publishedSeq: around.maxSeqWithin ?? 0 });
    if (around.seqsAfter.length > 0) excluded[`${stream.outputType}:${stream.language}`] = around.seqsAfter;
  }
  await store.markFinished(session.id, 'incomplete', publishedSeqs);
  const eventSeq = (await store.eventCounter(session.id)) + 1;
  await store.insertEvent({
    sessionId: session.id,
    seq: eventSeq,
    kind: 'drain_timeout',
    detail: {
      recovered: true,
      drainTimeoutMs,
      boundAt: bound.toISOString(),
      persistedUnpublished: excluded,
      ambiguousWindowMs: statementTimeoutMs,
    },
    at: new Date(),
  });
  log.warn('finishing session recovered as finished/incomplete', { sessionId: session.id, excluded });
  return { excluded, publishedSeqs };
}
