import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { endToken, finalToken, partialToken } from '../test/fakes.js';
import { TokenState } from './tokenState.js';

function en(segmentMaxChars = 400) {
  return new TokenState({ segmentMaxChars, outputs: ['original', 'translation'] });
}

describe('TokenState', () => {
  it('replaces the partial per stream on every response and keeps finals once', () => {
    const state = en();
    const a = state.accept({ tokens: [finalToken('Hello'), partialToken(' wor'), partialToken('ld')] });
    expect(a.streams.get('original')?.finals).toEqual([{ segmentSeq: 1, text: 'Hello', tokens: expect.any(Array) }]);
    expect(a.streams.get('original')?.partial).toEqual({ segmentSeq: 1, text: ' world' });
    expect(a.streams.get('translation')?.partial.text).toBe('');
    const b = state.accept({ tokens: [finalToken(' world'), partialToken('Hola', true)] });
    expect(b.streams.get('original')?.finals).toEqual([{ segmentSeq: 1, text: ' world', tokens: expect.any(Array) }]);
    expect(b.streams.get('original')?.partial).toEqual({ segmentSeq: 1, text: '' });
    expect(b.streams.get('original')?.partialCleared).toBe(true);
    expect(b.streams.get('translation')?.partial).toEqual({ segmentSeq: 1, text: 'Hola' });
    const c = state.accept({ tokens: [] });
    expect(c.streams.get('translation')?.partialCleared).toBe(true);
    expect(c.streams.get('translation')?.partial.text).toBe('');
  });

  it('opens a new segment lazily after <end>, alone or shared with finals, without empty segments', () => {
    const state = en();
    state.accept({ tokens: [finalToken('One.')] });
    const shared = state.accept({ tokens: [finalToken(' Two.'), endToken] });
    expect(shared.streams.get('original')?.finals.map((f) => f.segmentSeq)).toEqual([1]);
    expect(shared.stats.endTokens).toBe(1);
    // Partial after a pending flag reports the next segment.
    const partial = state.accept({ tokens: [partialToken('Thr')] });
    expect(partial.streams.get('original')?.partial).toEqual({ segmentSeq: 2, text: 'Thr' });
    // Consecutive flags do not create empty segments.
    state.accept({ tokens: [endToken] });
    state.accept({ tokens: [endToken] });
    const next = state.accept({ tokens: [finalToken('Three.'), finalToken('Tres.', { translation: true })] });
    expect(next.streams.get('original')?.finals).toEqual([{ segmentSeq: 2, text: 'Three.', tokens: expect.any(Array) }]);
    expect(next.streams.get('translation')?.finals).toEqual([{ segmentSeq: 1, text: 'Tres.', tokens: expect.any(Array) }]);
    expect(state.currentSegmentSeq('original')).toBe(2);
  });

  it('splits a response into two parts at a whitespace-initial token once max chars is reached', () => {
    const state = en(10);
    const r = state.accept({ tokens: [finalToken('abcdefghij'), finalToken('klm'), finalToken(' nop'), finalToken('q')] });
    const finals = r.streams.get('original')?.finals ?? [];
    expect(finals.map((f) => [f.segmentSeq, f.text])).toEqual([
      [1, 'abcdefghijklm'],
      [2, ' nopq'],
    ]);
  });

  it('applies the hard cap at twice max chars even without whitespace', () => {
    const state = en(4);
    const r = state.accept({ tokens: [finalToken('abcd'), finalToken('efgh'), finalToken('ij')] });
    expect(r.streams.get('original')?.finals.map((f) => [f.segmentSeq, f.text])).toEqual([
      [1, 'abcdefgh'],
      [2, 'ij'],
    ]);
  });

  it('appends finals of a finished response and drops its non-finals', () => {
    const state = en();
    state.accept({ tokens: [partialToken('pending')] });
    const r = state.accept({ tokens: [finalToken('done'), partialToken('never')], finished: true });
    expect(r.streams.get('original')?.finals.map((f) => f.text)).toEqual(['done']);
    expect(r.streams.get('original')?.partial.text).toBe('');
    expect(r.stats.nonFinalTokens).toBe(0);
  });

  it('strips control tokens from text and counts none tokens', () => {
    const state = en();
    const r = state.accept({ tokens: [{ text: '<fin>', is_final: true, translation_status: 'none' }, { text: 'x', is_final: true, translation_status: 'none' }, finalToken('y')] });
    expect(r.streams.get('original')?.finals.map((f) => f.text)).toEqual(['xy']);
    expect(r.stats.controlTokens).toBe(1);
    expect(r.stats.noneTokens).toBe(1);
  });

  it('routes translation tokens for a session with only an original stream as unroutable', () => {
    const state = new TokenState({ segmentMaxChars: 400, outputs: ['original'] });
    const r = state.accept({ tokens: [finalToken('hola'), finalToken('hi', { translation: true })] });
    expect(r.stats.droppedUnroutable).toBe(1);
    expect(r.streams.get('original')?.finals.map((f) => f.text)).toEqual(['hola']);
  });

  it('routes Spanish originals and English translations by translation_status alone; language is metadata', () => {
    const state = en();
    const r = state.accept({
      tokens: [
        { ...finalToken('Hola'), language: 'es' },
        { ...finalToken('Hello', { translation: true }), language: 'en' },
        // A detected English word inside the Spanish talk stays in the original stream.
        { ...finalToken(' sysadmin'), language: 'en' },
        { ...partialToken(' mundo'), language: 'es' },
        { ...partialToken(' world', true), language: 'en' },
      ],
    });
    expect(r.streams.get('original')?.finals.map((f) => f.text)).toEqual(['Hola sysadmin']);
    expect(r.streams.get('translation')?.finals.map((f) => f.text)).toEqual(['Hello']);
    expect(r.streams.get('original')?.partial.text).toBe(' mundo');
    expect(r.streams.get('translation')?.partial.text).toBe(' world');
    expect(r.stats.droppedUnroutable).toBe(0);
  });

  it('keeps a translation final that arrives after <end>, in the next segment of its stream', () => {
    const state = en();
    state.accept({ tokens: [{ ...finalToken('Hola.'), language: 'es' }, { ...finalToken('Hello.', { translation: true }), language: 'en' }] });
    const end = state.accept({ tokens: [endToken] });
    // The <end> marker is a control token: neither a none token nor text.
    expect(end.stats).toMatchObject({ endTokens: 1, controlTokens: 1, noneTokens: 0, finalTokens: 0 });
    const late = state.accept({ tokens: [{ ...finalToken(' Mundo.', { translation: true }), language: 'en' }] });
    expect(late.streams.get('translation')?.finals).toEqual([{ segmentSeq: 2, text: ' Mundo.', tokens: expect.any(Array) }]);
    expect(state.currentSegmentSeq('translation')).toBe(2);
    // The original stream has not received a final since <end>; its next final will open segment 2.
    expect(state.currentSegmentSeq('original')).toBe(1);
    expect(late.streams.get('original')?.partial.segmentSeq).toBe(2);
  });

  // Local provider recordings are not distributed with the repository; without them this case is reported as skipped.
  const runsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/soniox-smoke/runs');
  it.skipIf(!existsSync(runsDir))('replays local provider recordings: every final appears once, text matches the naive join', () => {
    const files = readdirSync(runsDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const lines = readFileSync(path.join(runsDir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; message?: { tokens?: Array<Record<string, unknown>>; finished?: boolean } });
      const responses = lines.filter((l) => l.kind === 'response' && l.message).map((l) => l.message as { tokens?: Array<Record<string, unknown>>; finished?: boolean });
      const state = en();
      const text = { original: '', translation: '' };
      let finalTokens = 0;
      for (const response of responses) {
        const r = state.accept(response as never);
        for (const [output, s] of r.streams) for (const part of s.finals) text[output] += part.text;
        finalTokens += r.stats.finalTokens;
      }
      const expected = { original: '', translation: '' };
      let expectedCount = 0;
      for (const response of responses) {
        for (const t of response.tokens ?? []) {
          if (t.is_final !== true || /^<[^>]+>$/.test(String(t.text))) continue;
          expectedCount++;
          expected[t.translation_status === 'translation' ? 'translation' : 'original'] += String(t.text);
        }
      }
      expect(text, file).toEqual(expected);
      expect(finalTokens, file).toBe(expectedCount);
    }
  });
});
