import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@nerditulos/shared';
import { initialCaptionState, languageOfferedBy, reduceCaption, streamLanguageFor } from './useCaptionStream.js';

const SPANISH_ONLY = [{ lang: 'es', outputType: 'original' as const, label: 'Español (original)' }];
const SPANISH_WITH_ENGLISH = [
  { lang: 'es', outputType: 'original' as const, label: 'Español (original)' },
  { lang: 'en', outputType: 'translation' as const, label: 'English (translation)' },
];

const session: SessionSummary = {
  sessionId: 's1',
  title: 'Charla',
  sourceLanguage: 'es',
  state: 'live',
  cause: null,
  completeness: null,
  availableLanguages: SPANISH_WITH_ENGLISH,
};

function final(seq: number, segmentSeq: number, windowSegments = 2) {
  return { type: 'final' as const, event: { seq, segmentSeq, text: 't' + seq, receivedAt: 0, publishedAt: 0 }, windowSegments };
}

function snapshotOf(s: SessionSummary, stream: { outputType: 'original' | 'translation'; language: string }, segments: Array<{ segmentSeq: number; rows: Array<{ seq: number; text: string }> }>, extra: Partial<{ partial: { segmentSeq: number; text: string }; gaps: Array<{ afterSeq: number; extent: number | 'unknown' }> }> = {}) {
  return { type: 'snapshot' as const, snapshot: { session: s, stream, segments, partial: extra.partial ?? { segmentSeq: 0, text: '' }, gaps: extra.gaps ?? [], storage: 'ok' as const } };
}

describe('caption window', () => {
  it('keeps only the last window segments as finals arrive, dropping gaps that belonged to removed text', () => {
    let state = reduceCaption(
      initialCaptionState,
      snapshotOf(
        session,
        { outputType: 'original', language: 'es' },
        [
          { segmentSeq: 1, rows: [{ seq: 1, text: 't1' }] },
          { segmentSeq: 2, rows: [{ seq: 2, text: 't2' }] },
        ],
        { partial: { segmentSeq: 2, text: '' }, gaps: [{ afterSeq: 1, extent: 1600 }] },
      ),
    );
    state = reduceCaption(state, final(3, 2));
    expect(state.segments.map((s) => s.segmentSeq)).toEqual([1, 2]);
    state = reduceCaption(state, final(4, 3));
    expect(state.segments.map((s) => s.segmentSeq)).toEqual([2, 3]);
    expect(state.gaps).toEqual([]);
    expect(state.segments.some((s) => s.gapAfter)).toBe(false);
    // A replayed final is ignored.
    expect(reduceCaption(state, final(4, 3))).toBe(state);
  });

  it('keeps the window on a session event with the same id and resets it when the session changes', () => {
    let state = reduceCaption(
      initialCaptionState,
      snapshotOf(session, { outputType: 'original', language: 'es' }, [{ segmentSeq: 1, rows: [{ seq: 1, text: 't1' }] }, { segmentSeq: 2, rows: [{ seq: 2, text: 't2' }] }], {
        partial: { segmentSeq: 2, text: 'p' },
        gaps: [{ afterSeq: 1, extent: 1600 }],
      }),
    );
    state = reduceCaption(state, { type: 'session', session: { ...session, state: 'interrupted', cause: 'sender_lost' }, offered: true });
    expect(state.session?.state).toBe('interrupted');
    expect(state.segments).toHaveLength(2);
    expect(state.lastSeq).toBe(2);
    expect(state.stream).toEqual({ outputType: 'original', language: 'es' });
    expect(state.partial).toEqual({ segmentSeq: 2, text: 'p' });
    expect(state.gaps).toHaveLength(1);

    const next: SessionSummary = { ...session, sessionId: 's2', title: 'Siguiente' };
    state = reduceCaption(state, { type: 'session', session: next, offered: true });
    expect(state).toMatchObject({ session: next, sessionKnown: true, segments: [], lastSeq: 0, stream: null, partial: { segmentSeq: 0, text: '' }, gaps: [], languageOffered: true });

    // The new session's English translation window starts empty and its first final is applied from seq 1.
    state = reduceCaption(state, snapshotOf(next, { outputType: 'translation', language: 'en' }, []));
    state = reduceCaption(state, final(1, 1));
    expect(state.stream).toEqual({ outputType: 'translation', language: 'en' });
    expect(state.segments).toEqual([{ segmentSeq: 1, rows: [{ seq: 1, text: 't1' }] }]);
    expect(state.lastSeq).toBe(1);
  });

  it('marks the language as not offered when the session has no stream for it', () => {
    const spanishOnly: SessionSummary = { ...session, sessionId: 's3', availableLanguages: SPANISH_ONLY };
    expect(languageOfferedBy(spanishOnly, 'en')).toBe(false);
    expect(languageOfferedBy(spanishOnly, 'es')).toBe(true);
    expect(languageOfferedBy(session, 'en')).toBe(true);
    expect(languageOfferedBy(null, 'en')).toBe(true);
    const state = reduceCaption(initialCaptionState, { type: 'session', session: spanishOnly, offered: languageOfferedBy(spanishOnly, 'en') });
    expect(state.languageOffered).toBe(false);
    expect(state.sessionKnown).toBe(true);
  });
});

describe('streamLanguageFor', () => {
  it('keeps the reader language before a session is known and when the session offers it', () => {
    expect(streamLanguageFor('en', null)).toBe('en');
    expect(streamLanguageFor('en', session)).toBe('en');
    expect(streamLanguageFor('es', session)).toBe('es');
  });

  it('falls back to Spanish for a historical Spanish-only session', () => {
    expect(streamLanguageFor('en', { ...session, availableLanguages: SPANISH_ONLY })).toBe('es');
  });

  it('falls back to the first stream when Spanish is not offered either', () => {
    const englishOnly: SessionSummary = { ...session, sourceLanguage: 'en', availableLanguages: [{ lang: 'en', outputType: 'original', label: 'English (original)' }] };
    expect(streamLanguageFor('es', englishOnly)).toBe('en');
  });

  it('keeps the reader language for a session without streams', () => {
    expect(streamLanguageFor('en', { ...session, availableLanguages: [] })).toBe('en');
  });
});
