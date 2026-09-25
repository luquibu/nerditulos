import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { encodeCursor, type GapMarker, type OutputType } from '@nerditulos/shared';
import { silentLogger } from '../log.js';
import { createHubStream, StreamHub, type HubSession } from './streamHub.js';

class FakeRes extends EventEmitter {
  chunks: string[] = [];
  writableLength = 0;
  destroyed = false;
  writeReturns = true;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.writeReturns;
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
  events(): Array<{ event: string; id?: string; data: unknown }> {
    return this.chunks
      .join('')
      .split('\n\n')
      .filter((f) => f && !f.startsWith(':'))
      .map((frame) => {
        const out: { event: string; id?: string; data: unknown } = { event: '', data: null };
        for (const line of frame.split('\n')) {
          if (line.startsWith('id: ')) out.id = line.slice(4);
          else if (line.startsWith('id:')) out.id = '';
          else if (line.startsWith('event: ')) out.event = line.slice(7);
          else if (line.startsWith('data: ')) out.data = JSON.parse(line.slice(6));
        }
        return out;
      });
  }
}

const SESSION = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

interface Spec {
  outputType: OutputType;
  language: string;
}
const EN_STREAMS: Spec[] = [
  { outputType: 'original', language: 'en' },
  { outputType: 'translation', language: 'es' },
];
const ES_STREAMS: Spec[] = [
  { outputType: 'original', language: 'es' },
  { outputType: 'translation', language: 'en' },
];
/** A Spanish session prepared before English translation existed. */
const ES_ONLY: Spec[] = [{ outputType: 'original', language: 'es' }];

/** A hub session with explicit streams; labels are irrelevant to the hub, so they are not the production ones. */
function session(id = SESSION, streams: Spec[] = EN_STREAMS): HubSession {
  const sourceLanguage = (streams.find((s) => s.outputType === 'original')?.language ?? 'es') as 'es' | 'en';
  return {
    summary: {
      sessionId: id,
      title: 'T',
      sourceLanguage,
      state: 'live',
      cause: null,
      completeness: null,
      availableLanguages: streams.map((s) => ({ lang: s.language, outputType: s.outputType, label: `${s.language} (${s.outputType})` })),
    },
    storage: 'ok',
    streams: new Map(streams.map((s) => [s.language, createHubStream(s.outputType, s.language)] as const)),
  };
}

function hubWith(segments = 20, opts: Partial<ConstructorParameters<typeof StreamHub>[0]> = {}) {
  const hub = new StreamHub({ publicWindowSegments: segments, log: silentLogger, pingIntervalMs: 1e9, ...opts });
  hub.setRoom({ slug: 'sala-1', name: 'Sala 1', index: 1 });
  return hub;
}

function res() {
  return new FakeRes() as unknown as ServerResponse & FakeRes;
}

const row = (seq: number, segmentSeq: number, text = `t${seq}`) => ({ seq, segmentSeq, text, receivedAt: 0, publishedAt: 0 });
const partial = (segmentSeq: number, text: string) => ({ segmentSeq, text, receivedAt: 0, publishedAt: 0 });
const c = (sessionId: string, outputType: OutputType, language: string, seq: number) => encodeCursor({ sessionId, outputType, language, seq });
const names = (r: FakeRes) => r.events().map((e) => e.event);
const texts = (r: FakeRes, event: string) => r.events().filter((e) => e.event === event).map((e) => (e.data as { text: string }).text);
const SNAPSHOT_ONLY = ['session', 'snapshot', 'state', 'partial'];
const LIVE = { state: 'live' as const, cause: null, completeness: null, storage: 'ok' as const };

describe('StreamHub cursors', () => {
  /** An English session whose `lang` stream holds five finals in two segments and a partial. */
  function seeded(streams: Spec[] = EN_STREAMS, lang = 'es') {
    const hub = hubWith();
    hub.installSession('sala-1', session(SESSION, streams));
    for (let seq = 1; seq <= 5; seq++) hub.publishFinal('sala-1', SESSION, lang, row(seq, seq <= 2 ? 1 : 2));
    hub.publishPartial('sala-1', SESSION, lang, partial(2, 'p'));
    return hub;
  }

  it('valid cursor yields a delta, then state and partial', () => {
    const hub = seeded();
    const r = res();
    hub.subscribe('sala-1', 'es', c(SESSION, 'translation', 'es', 3), r);
    const events = r.events();
    expect(events.map((e) => e.event)).toEqual(['session', 'final', 'final', 'state', 'partial']);
    expect(events.filter((e) => e.event === 'final').map((e) => (e.data as { seq: number }).seq)).toEqual([4, 5]);
    expect(events[1]?.id).toBe(c(SESSION, 'translation', 'es', 4));
    expect((events[4]?.data as { text: string }).text).toBe('p');
  });

  it('oldest-1 and latest are valid; latest+1, oldest-2, other session, other output type, garbage get a snapshot', () => {
    const hub = seeded();
    const check = (cursor: string | null) => {
      const r = res();
      hub.subscribe('sala-1', 'es', cursor, r);
      return names(r);
    };
    expect(check(c(SESSION, 'translation', 'es', 0))).toEqual(['session', 'final', 'final', 'final', 'final', 'final', 'state', 'partial']);
    expect(check(c(SESSION, 'translation', 'es', 5))).toEqual(['session', 'state', 'partial']);
    expect(check(c(SESSION, 'translation', 'es', 6))).toEqual(SNAPSHOT_ONLY);
    expect(check(c(S2, 'translation', 'es', 1))).toEqual(SNAPSHOT_ONLY);
    expect(check(c(SESSION, 'original', 'es', 3))).toEqual(SNAPSHOT_ONLY);
    expect(check('garbage')).toEqual(SNAPSHOT_ONLY);
    expect(check(null)).toEqual(SNAPSHOT_ONLY);
  });

  it('cursors on a Spanish session with both streams populated: the en delta needs translation:en with this session id', () => {
    const hub = hubWith();
    hub.installSession('sala-1', session(S2, ES_STREAMS));
    // Overlapping seqs on both streams: a cursor must be matched by stream, not by number.
    for (let seq = 1; seq <= 5; seq++) {
      hub.publishFinal('sala-1', S2, 'es', row(seq, seq <= 2 ? 1 : 2, `es${seq}`));
      hub.publishFinal('sala-1', S2, 'en', row(seq, seq <= 2 ? 1 : 2, `en${seq}`));
    }
    const check = (cursor: string | null) => {
      const r = res();
      hub.subscribe('sala-1', 'en', cursor, r);
      return r;
    };
    const delta = check(c(S2, 'translation', 'en', 3));
    expect(names(delta)).toEqual(['session', 'final', 'final', 'state', 'partial']);
    expect(texts(delta, 'final')).toEqual(['en4', 'en5']);
    expect(delta.events()[1]?.id).toBe(c(S2, 'translation', 'en', 4));
    expect(names(check(c(S2, 'translation', 'en', 0)))).toEqual(['session', 'final', 'final', 'final', 'final', 'final', 'state', 'partial']);
    expect(names(check(c(S2, 'translation', 'en', 5)))).toEqual(['session', 'state', 'partial']);
    expect(names(check(c(S2, 'translation', 'en', 6)))).toEqual(SNAPSHOT_ONLY);
    expect(names(check(c(S2, 'original', 'en', 3)))).toEqual(SNAPSHOT_ONLY);
    expect(names(check(c(S2, 'translation', 'es', 3)))).toEqual(SNAPSHOT_ONLY);
    expect(names(check(c(S2, 'original', 'es', 3)))).toEqual(SNAPSHOT_ONLY);
    expect(names(check(c(SESSION, 'translation', 'en', 3)))).toEqual(SNAPSHOT_ONLY);
    const snapshot = check(null).events()[1]?.data as { stream: Spec; segments: Array<{ rows: Array<{ text: string }> }> };
    expect(snapshot.stream).toEqual({ outputType: 'translation', language: 'en' });
    expect(snapshot.segments.flatMap((s) => s.rows.map((r) => r.text))).toEqual(['en1', 'en2', 'en3', 'en4', 'en5']);
  });

  it('oldest-2 after trimming gets a snapshot', () => {
    const hub = hubWith(2);
    hub.installSession('sala-1', session());
    for (let seq = 1; seq <= 6; seq++) hub.publishFinal('sala-1', SESSION, 'es', row(seq, seq));
    const r = res();
    hub.subscribe('sala-1', 'es', c(SESSION, 'translation', 'es', 3), r);
    expect(names(r)).toEqual(SNAPSHOT_ONLY);
    const snap = r.events()[1]?.data as { segments: Array<{ segmentSeq: number }> };
    expect(snap.segments.map((s) => s.segmentSeq)).toEqual([5, 6]);
    const ok = res();
    hub.subscribe('sala-1', 'es', c(SESSION, 'translation', 'es', 4), ok);
    expect(names(ok)).toEqual(['session', 'final', 'final', 'state', 'partial']);
  });

  it('snapshot id is the latest cursor or empty when the window is empty', () => {
    const hub = seeded();
    const r = res();
    hub.subscribe('sala-1', 'es', null, r);
    expect(r.events()[1]?.id).toBe(c(SESSION, 'translation', 'es', 5));
    const empty = hubWith();
    empty.installSession('sala-1', session());
    const e = res();
    empty.subscribe('sala-1', 'en', null, e);
    expect(e.events()[1]?.id).toBe('');
  });
});

describe('StreamHub session switch and readers', () => {
  it('sends session to every reader and a snapshot only to offered languages (a Spanish session with one stream)', () => {
    const hub = hubWith();
    hub.installSession('sala-1', session(SESSION, EN_STREAMS));
    const es = res();
    const en = res();
    hub.subscribe('sala-1', 'es', null, es);
    hub.subscribe('sala-1', 'en', null, en);
    es.chunks.length = 0;
    en.chunks.length = 0;
    hub.switchSession('sala-1', session(S3, ES_ONLY));
    expect(names(es)).toEqual(SNAPSHOT_ONLY);
    expect(names(en)).toEqual(['session']);
    expect((es.events()[1]?.data as { segments: unknown[] }).segments).toEqual([]);
  });

  it('switching to a Spanish session with translation: the en reader gets an empty translation snapshot with an empty id, the es reader the original', () => {
    const hub = hubWith();
    hub.installSession('sala-1', session(SESSION, EN_STREAMS));
    const en = res();
    const es = res();
    hub.subscribe('sala-1', 'en', null, en);
    hub.subscribe('sala-1', 'es', null, es);
    hub.publishFinal('sala-1', SESSION, 'en', row(1, 1, 'a'));
    hub.publishFinal('sala-1', SESSION, 'es', row(1, 1, 'a-es'));
    en.chunks.length = 0;
    es.chunks.length = 0;
    hub.switchSession('sala-1', session(S2, ES_STREAMS));
    const ev = en.events();
    expect(ev.map((e) => e.event)).toEqual(SNAPSHOT_ONLY);
    expect((ev[0]?.data as { sessionId: string }).sessionId).toBe(S2);
    // An empty id resets the browser's Last-Event-ID, so a reconnect cannot carry the previous session's cursor.
    expect(ev[1]?.id).toBe('');
    expect(ev[1]?.data).toMatchObject({ stream: { outputType: 'translation', language: 'en' }, segments: [], gaps: [], partial: { segmentSeq: 0, text: '' } });
    expect(es.events()[1]?.data).toMatchObject({ stream: { outputType: 'original', language: 'es' }, segments: [] });
  });

  it('after a switch the previous session cannot publish, and the same lang maps to the new session\'s stream', () => {
    const hub = hubWith();
    hub.installSession('sala-1', session(SESSION, EN_STREAMS));
    const en = res();
    hub.subscribe('sala-1', 'en', null, en);
    hub.publishFinal('sala-1', SESSION, 'en', row(1, 1, 'old'));
    hub.switchSession('sala-1', session(S2, ES_STREAMS));
    en.chunks.length = 0;
    expect(hub.publishFinal('sala-1', SESSION, 'en', row(2, 1, 'late'))).toBe(false);
    expect(hub.publishPartial('sala-1', SESSION, 'en', partial(1, 'late'))).toBe(false);
    expect(hub.publishState('sala-1', SESSION, { ...LIVE, state: 'finished', completeness: 'complete' })).toBe(false);
    expect(en.events()).toEqual([]);
    expect(hub.getSession('sala-1')?.streams.get('en')).toMatchObject({ outputType: 'translation', rows: [], latestSeq: 0 });
    expect(hub.publishFinal('sala-1', S2, 'en', row(1, 1, 'new'))).toBe(true);
    expect(names(en)).toEqual(['final']);
    expect(en.events()[0]?.id).toBe(c(S2, 'translation', 'en', 1));
    expect(texts(en, 'final')).toEqual(['new']);
  });

  it('switching from a Spanish session with translation to one without: en gets session only, es a snapshot, and en cannot be published', () => {
    const hub = hubWith();
    hub.installSession('sala-1', session(S2, ES_STREAMS));
    const en = res();
    const es = res();
    hub.subscribe('sala-1', 'en', null, en);
    hub.subscribe('sala-1', 'es', null, es);
    en.chunks.length = 0;
    es.chunks.length = 0;
    hub.switchSession('sala-1', session(S3, ES_ONLY));
    expect(names(en)).toEqual(['session']);
    expect((en.events()[0]?.data as { availableLanguages: Array<{ lang: string }> }).availableLanguages.map((l) => l.lang)).toEqual(['es']);
    expect(names(es)).toEqual(SNAPSHOT_ONLY);
    expect(es.events()[1]?.data).toMatchObject({ stream: { outputType: 'original', language: 'es' } });
    expect(hub.publishFinal('sala-1', S3, 'en', row(1, 1, 'x'))).toBe(false);
    expect(en.events()).toHaveLength(1);
  });

  it('records a gap after each stream\'s own latest seq and trims each stream independently', () => {
    const hub = hubWith(2);
    hub.installSession('sala-1', session(S2, ES_STREAMS));
    const en = res();
    const es = res();
    hub.subscribe('sala-1', 'en', null, en);
    hub.subscribe('sala-1', 'es', null, es);
    for (let seq = 1; seq <= 5; seq++) hub.publishFinal('sala-1', S2, 'es', row(seq, seq, `es${seq}`));
    for (let seq = 1; seq <= 2; seq++) hub.publishFinal('sala-1', S2, 'en', row(seq, 1, `en${seq}`));
    expect(hub.publishGap('sala-1', S2, 1600, LIVE)).toBe(true);
    const gapsOf = (r: FakeRes) => r.events().filter((e) => e.event === 'state').map((e) => (e.data as { gap?: GapMarker }).gap).filter(Boolean);
    expect(gapsOf(es)).toEqual([{ afterSeq: 5, extent: 1600 }]);
    expect(gapsOf(en)).toEqual([{ afterSeq: 2, extent: 1600 }]);
    const s = hub.getSession('sala-1')!;
    expect(s.streams.get('es')?.rows.map((r) => r.seq)).toEqual([4, 5]);
    expect(s.streams.get('en')?.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(s.streams.get('es')?.gaps).toEqual([{ afterSeq: 5, extent: 1600 }]);
    expect(s.streams.get('en')?.gaps).toEqual([{ afterSeq: 2, extent: 1600 }]);
  });

  it('unoffered language on connect gets session only; no session gets session null', () => {
    const hub = hubWith();
    const none = res();
    hub.subscribe('sala-1', 'es', null, none);
    expect(none.events()).toEqual([{ event: 'session', data: null }]);
    hub.installSession('sala-1', session(SESSION, ES_ONLY));
    const en = res();
    hub.subscribe('sala-1', 'en', null, en);
    expect(names(en)).toEqual(['session']);
  });

  it('snapshot, registration, and first write happen in one tick: a final published right after is delivered once', () => {
    const hub = hubWith();
    hub.installSession('sala-1', session());
    hub.publishFinal('sala-1', SESSION, 'es', row(1, 1, 'a'));
    const r = res();
    hub.subscribe('sala-1', 'es', null, r);
    hub.publishFinal('sala-1', SESSION, 'es', row(2, 1, 'b'));
    const events = r.events();
    expect(events.map((e) => e.event)).toEqual(['session', 'snapshot', 'state', 'partial', 'final']);
    expect((events[1]?.data as { segments: Array<{ rows: unknown[] }> }).segments[0]?.rows).toHaveLength(1);
    expect((events[4]?.data as { seq: number }).seq).toBe(2);
  });

  it('destroys a stalled reader without blocking others and resends the skipped partial on drain', async () => {
    const hub = hubWith(20, { stallTimeoutMs: 20 });
    hub.installSession('sala-1', session());
    const slow = res();
    const fast = res();
    hub.subscribe('sala-1', 'es', null, slow);
    hub.subscribe('sala-1', 'es', null, fast);
    slow.writeReturns = false;
    hub.publishFinal('sala-1', SESSION, 'es', row(1, 1, 'a'));
    hub.publishPartial('sala-1', SESSION, 'es', partial(1, 'skipped'));
    expect(texts(slow, 'partial')).not.toContain('skipped');
    expect(texts(fast, 'partial')).toContain('skipped');
    slow.writeReturns = true;
    slow.emit('drain');
    expect(texts(slow, 'partial')).toContain('skipped');
    slow.writeReturns = false;
    hub.publishFinal('sala-1', SESSION, 'es', row(2, 1, 'b'));
    await new Promise((r) => setTimeout(r, 40));
    expect(slow.destroyed).toBe(true);
    expect(fast.destroyed).toBe(false);
    hub.publishFinal('sala-1', SESSION, 'es', row(3, 1, 'c'));
    expect(fast.events().filter((e) => e.event === 'final')).toHaveLength(3);
    expect(hub.subscriberCount('sala-1')).toBe(1);
    hub.close();
  });

  it('a partial skipped under backpressure is not resent after a session switch', () => {
    const hub = hubWith(20, { stallTimeoutMs: 1e9 });
    hub.installSession('sala-1', session(SESSION, EN_STREAMS));
    const slow = res();
    hub.subscribe('sala-1', 'es', null, slow);
    slow.writeReturns = false;
    hub.publishFinal('sala-1', SESSION, 'es', row(1, 1, 'a'));
    hub.publishPartial('sala-1', SESSION, 'es', partial(1, 'stale'));
    expect(texts(slow, 'partial')).not.toContain('stale');
    hub.switchSession('sala-1', session(S2, ES_STREAMS));
    slow.writeReturns = true;
    slow.emit('drain');
    // The subscription's empty partial and the new session's empty snapshot partial; never the previous session's hypothesis.
    expect(texts(slow, 'partial')).toEqual(['', '']);
    expect(names(slow).slice(-4)).toEqual(SNAPSHOT_ONLY);
    hub.close();
  });

  it('destroys a reader whose pending buffer exceeds the limit', () => {
    const hub = hubWith(20, { maxWritableLength: 10 });
    hub.installSession('sala-1', session());
    const r = res();
    hub.subscribe('sala-1', 'es', null, r);
    r.writableLength = 11;
    hub.publishFinal('sala-1', SESSION, 'es', row(1, 1, 'a'));
    expect(r.destroyed).toBe(true);
    hub.close();
  });
});
