import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SenderServerMessage } from '@nerditulos/shared';
import { silentLogger } from '../log.js';
import { StreamHub } from '../public/streamHub.js';
import { endToken, FakeStore, fakeProviderFactory, finalToken, flush, frameOf, partialToken } from '../test/fakes.js';
import { recoverFinishingSession, warmHubSession } from './recovery.js';
import { SessionRuntime, type RuntimeConfig, type SenderLink } from './SessionRuntime.js';
import type { StreamSpec } from './SessionStore.js';

const EN_STREAMS: StreamSpec[] = [
  { outputType: 'original', language: 'en' },
  { outputType: 'translation', language: 'es' },
];
const ES_STREAMS: StreamSpec[] = [
  { outputType: 'original', language: 'es' },
  { outputType: 'translation', language: 'en' },
];
/** A Spanish session prepared before English translation existed. */
const ES_ONLY: StreamSpec[] = [{ outputType: 'original', language: 'es' }];

/** Spanish original and English translation tokens, with the metadata the provider attaches in that direction. */
const esFinal = (text: string) => ({ ...finalToken(text), language: 'es' });
const enTranslation = (text: string) => ({ ...finalToken(text, { translation: true }), language: 'en' });

function makeLink(id = 1) {
  const link = {
    id,
    sent: [] as SenderServerMessage[],
    closed: null as { code: number; reason: string } | null,
    send(m: SenderServerMessage) {
      this.sent.push(m);
    },
    close(code: number, reason: string) {
      this.closed = { code, reason };
    },
  };
  return link as SenderLink & typeof link;
}

async function setup(opts: { sourceLanguage?: 'en' | 'es'; streams?: StreamSpec[]; config?: Partial<RuntimeConfig>; store?: FakeStore } = {}) {
  const store = opts.store ?? new FakeStore();
  const room = await store.upsertRoom('sala-1', 'Sala 1');
  const sourceLanguage = opts.sourceLanguage ?? 'en';
  const { session, streams } = await store.createSession({ roomId: room.id, title: 'Talk', sourceLanguage, streams: opts.streams ?? (sourceLanguage === 'en' ? EN_STREAMS : ES_STREAMS) });
  const started = (await store.startSession(session.id, {}))!;
  const hub = new StreamHub({ publicWindowSegments: 20, log: silentLogger, pingIntervalMs: 1e9 });
  hub.setRoom({ slug: 'sala-1', name: 'Sala 1', index: 1 });
  const factory = fakeProviderFactory();
  const finished: string[] = [];
  const config: RuntimeConfig = {
    drainTimeoutMs: 15000,
    segmentMaxChars: 400,
    sonioxModel: 'stt-rt-v5',
    publicWindowSegments: 20,
    retryIntervalMs: 5,
    retryBudgetMs: 60,
    reconnectBackoffMs: [5, 10, 20],
    providerFailureWindowMs: 60000,
    keepaliveIntervalMs: 1e9,
    ...opts.config,
  };
  const runtime = new SessionRuntime(
    { store, hub, providerFactory: factory, log: silentLogger, config, onFinished: (r) => finished.push(r.id) },
    started,
    room,
    streams,
    { counters: new Map(), eventSeq: 0, visible: false, hubSession: null },
  );
  const streamOf = (output: 'original' | 'translation') => streams.find((s) => s.outputType === output)!;
  return { store, room, session: started, streams, streamOf, hub, factory, runtime, finished, config };
}

async function goLive(t: Awaited<ReturnType<typeof setup>>, link = makeLink()) {
  const result = t.runtime.attachSender(link);
  expect(result.ok).toBe(true);
  await flush();
  expect(t.runtime.state).toBe('live');
  return { link, provider: t.factory.all[t.factory.all.length - 1]! };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionRuntime happy path', () => {
  it('goes live on provider open, switches visibility once, persists before publishing, and keeps seqs contiguous', async () => {
    const t = await setup();
    const { provider } = await goLive(t);
    expect(t.store.rooms[0]?.visibleSessionId).toBe(t.session.id);
    expect(t.hub.getPublicRoom('sala-1')?.session?.state).toBe('live');
    expect(provider.input.clientReferenceId).toBe(`${t.session.id}/1`);
    expect(provider.input.translationTarget).toBe('es');
    // Random store latency: publication order must still follow receipt order with contiguous seqs.
    t.store.latency = () => Math.floor(Math.random() * 4);
    const published: number[] = [];
    const original = t.streamOf('original');
    const originalPublish = t.hub.publishFinal.bind(t.hub);
    t.hub.publishFinal = (slug, sessionId, lang, row) => {
      // Never before commit: the row must already be in the store when it is published.
      expect(t.store.chunks.some((c) => c.streamId === (lang === 'en' ? original.id : t.streamOf('translation').id) && c.seq === row.seq)).toBe(true);
      if (lang === 'en') published.push(row.seq);
      return originalPublish(slug, sessionId, lang, row);
    };
    for (let i = 0; i < 20; i++) provider.respond({ tokens: [finalToken(`w${i} `), partialToken('p'), finalToken(`t${i} `, { translation: true })], final_audio_proc_ms: i * 100 });
    await t.runtime.idle();
    expect(published).toEqual([...Array(20).keys()].map((i) => i + 1));
    expect(t.store.chunksOf(original.id).map((c) => c.seq)).toEqual([...Array(20).keys()].map((i) => i + 1));
    expect(t.store.chunksOf(t.streamOf('translation').id).map((c) => c.seq)).toEqual([...Array(20).keys()].map((i) => i + 1));
    const hubSession = t.hub.getSession('sala-1')!;
    expect(hubSession.streams.get('en')?.rows).toHaveLength(20);
    expect(hubSession.streams.get('en')?.partial?.text).toBe('p');
    expect(hubSession.streams.get('es')?.partial?.text).toBe('');
  });

  it('records persist_failure on a RETURNING mismatch and never publishes that row', async () => {
    const t = await setup();
    const { provider } = await goLive(t);
    const original = t.streamOf('original');
    // A foreign row already occupies seq 1 with different text.
    t.store.chunks.push({ streamId: original.id, seq: 1, segmentSeq: 1, text: 'other', tokens: [], providerGeneration: 1, receivedAt: new Date(), persistedAt: new Date() });
    provider.respond({ tokens: [finalToken('mine')] });
    await t.runtime.idle();
    await flush();
    expect(t.store.events.map((e) => e.kind)).toContain('persist_failure');
    expect(t.hub.getSession('sala-1')?.streams.get('en')?.rows).toHaveLength(0);
    expect(t.runtime.counters.persistFailures).toBe(1);
    // The same text already persisted counts as persisted and publishes once.
    t.store.chunks.push({ streamId: original.id, seq: 2, segmentSeq: 1, text: 'same', tokens: [], providerGeneration: 1, receivedAt: new Date(), persistedAt: new Date() });
    provider.respond({ tokens: [finalToken('same')] });
    await t.runtime.idle();
    expect(t.hub.getSession('sala-1')?.streams.get('en')?.rows.map((r) => r.seq)).toEqual([2]);
  });

  it('discards and counts responses from a closed generation', async () => {
    const t = await setup();
    const { provider } = await goLive(t);
    provider.closeFromServer();
    provider.respond({ tokens: [finalToken('late')] });
    await flush();
    expect(t.runtime.counters.responsesFromClosedGeneration).toBe(1);
    expect(t.store.chunks).toHaveLength(0);
  });
});

describe('SessionRuntime audio positions and discontinuities', () => {
  it('reports an uncertain source range when a server drop happened inside the generation', async () => {
    const t = await setup();
    const { link, provider } = await goLive(t);
    t.runtime.onFrame(link, frameOf(0), 1);
    provider.bufferedAmount = 200000;
    t.runtime.onFrame(link, frameOf(1600), 2);
    provider.bufferedAmount = 0;
    t.runtime.onFrame(link, frameOf(3200), 3);
    expect(provider.deliveredSamples()).toBe(3200);
    expect(t.runtime.counters.framesDroppedBackpressure).toBe(1);
    provider.respond({ tokens: [], final_audio_proc_ms: 150 });
    await t.runtime.idle();
    provider.closeFromServer();
    await new Promise((r) => setTimeout(r, 15));
    await flush();
    const next = t.factory.all[1]!;
    expect(next.input.clientReferenceId).toBe(`${t.session.id}/2`);
    const disc = link.sent.filter((m) => m.type === 'discontinuity').map((m) => (m as { detail: Record<string, unknown> }).detail);
    const unprocessed = disc.find((d) => d.kind === 'provider_unprocessed')!;
    expect(unprocessed.unprocessedSamples).toBe(800);
    expect(unprocessed.sourceRange).toEqual({ exact: false, start: 2400, startMax: 4000, end: 4800 });
    expect(disc.find((d) => d.kind === 'server_drop')?.extentSamples).toBe(1600);
  });

  it('reports an exact source range when the generation had no gap', async () => {
    const t = await setup();
    const { link, provider } = await goLive(t);
    t.runtime.onFrame(link, frameOf(0), 1);
    t.runtime.onFrame(link, frameOf(1600), 2);
    t.runtime.onFrame(link, frameOf(3200), 3);
    provider.respond({ tokens: [], final_audio_proc_ms: 250 });
    await t.runtime.idle();
    provider.closeFromServer();
    await new Promise((r) => setTimeout(r, 15));
    await flush();
    const disc = link.sent.filter((m) => m.type === 'discontinuity').map((m) => (m as { detail: Record<string, unknown> }).detail);
    expect(disc.find((d) => d.kind === 'provider_unprocessed')?.sourceRange).toEqual({ exact: true, start: 4000, end: 4800 });
  });

  it('classifies client gaps and adds them to the generation; frames while reconnecting are dropped and counted', async () => {
    const t = await setup();
    const { link, provider } = await goLive(t);
    t.runtime.onFrame(link, frameOf(0), 1);
    t.runtime.onFrame(link, frameOf(1600), 2);
    t.runtime.onFrame(link, frameOf(4800), 3);
    const gap = link.sent.find((m) => m.type === 'discontinuity') as { detail: Record<string, unknown> };
    expect(gap.detail).toMatchObject({ kind: 'client_gap', fromPosition: 3200, toPosition: 4800, extentSamples: 1600 });
    provider.closeFromServer();
    t.runtime.onFrame(link, frameOf(6400), 4);
    expect(t.runtime.counters.framesDroppedReconnecting).toBe(1);
    await new Promise((r) => setTimeout(r, 15));
    await flush();
    const next = t.factory.all[1]!;
    expect(next.opened).toBe(true);
    const unprocessed = link.sent.map((m) => (m.type === 'discontinuity' ? m.detail : null)).find((d) => d?.kind === 'provider_unprocessed');
    expect(unprocessed?.droppedSamples).toBe(1600);
  });

  it('interrupts with provider_unavailable after 60 s of failures and closes the sender with 4410', async () => {
    vi.useFakeTimers();
    const t = await setup({ config: { reconnectBackoffMs: [1000, 2000, 5000, 10000] } });
    const link = makeLink();
    t.factory.all.length = 0;
    const result = t.runtime.attachSender(link);
    expect(result.ok).toBe(true);
    await vi.runOnlyPendingTimersAsync();
    expect(t.runtime.state).toBe('live');
    t.factory.openBehavior = 'reject';
    const first = t.factory.all[0]!;
    first.closeFromServer();
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(10000);
    expect(t.runtime.state).toBe('interrupted');
    expect(t.runtime.cause).toBe('provider_unavailable');
    expect(link.closed).toEqual({ code: 4410, reason: 'provider-unavailable' });
    expect(t.store.sessions.get(t.session.id)?.state).toBe('interrupted');
  });
});

describe('SessionRuntime sender loss and identity', () => {
  it('keeps identity across device loss: interrupted, drained finals published, resume with new epoch, then finish', async () => {
    const t = await setup();
    const { link, provider } = await goLive(t);
    t.runtime.onFrame(link, frameOf(0), 1);
    t.runtime.onDetach(link, 'device_lost');
    expect(t.runtime.state).toBe('interrupted');
    expect(t.runtime.cause).toBe('sender_lost');
    expect(link.closed).toEqual({ code: 4410, reason: 'detached' });
    expect(provider.ended).toBe(true);
    await flush();
    expect(t.store.events.find((e) => e.kind === 'sender_lost')?.detail.reason).toBe('device_lost');
    // A second sender must wait for the draining generation.
    const early = makeLink(2);
    expect(t.runtime.attachSender(early)).toMatchObject({ ok: false, code: 4409, reason: 'generation-draining' });
    provider.respond({ tokens: [finalToken('pending')] });
    provider.respond({ tokens: [], finished: true });
    await t.runtime.idle();
    expect(t.hub.getSession('sala-1')?.streams.get('en')?.rows.map((r) => r.text)).toEqual(['pending']);
    const link2 = makeLink(3);
    const again = t.runtime.attachSender(link2);
    expect(again).toMatchObject({ ok: true, epoch: 2, expectedPosition: 0 });
    await flush();
    expect(t.runtime.state).toBe('live');
    expect(t.runtime.generationNumber).toBe(2);
    expect(t.runtime.id).toBe(t.session.id);
    expect(t.store.events.some((e) => e.kind === 'discontinuity' && e.detail.kind === 'new_epoch')).toBe(true);
    const provider2 = t.factory.all[1]!;
    // New generation opens a new segment.
    provider2.respond({ tokens: [finalToken('second')] });
    await t.runtime.idle();
    expect(t.store.chunksOf(t.streamOf('original').id).map((c) => c.segmentSeq)).toEqual([1, 2]);
    // Finish with reason finish.
    t.runtime.onEnd(link2, 'finish');
    await flush();
    expect(t.runtime.state).toBe('finishing');
    expect(link2.sent.some((m) => m.type === 'finishing')).toBe(true);
    provider2.respond({ tokens: [], finished: true });
    await t.runtime.idle();
    await flush();
    expect(t.runtime.state).toBe('finished');
    expect(t.runtime.completeness).toBe('complete');
    expect(link2.closed).toEqual({ code: 4404, reason: 'finished' });
    expect(t.runtime.attachSender(makeLink(4))).toMatchObject({ ok: false, code: 4404 });
    expect(t.finished).toEqual([t.session.id]);
    expect(t.store.streams.find((s) => s.id === t.streamOf('original').id)?.publishedSeq).toBe(2);
  });

  it('file_end behaves like finish', async () => {
    const t = await setup();
    const { link, provider } = await goLive(t);
    t.runtime.onEnd(link, 'file_end');
    await flush();
    expect(t.runtime.state).toBe('finishing');
    expect(provider.ended).toBe(true);
    provider.respond({ tokens: [finalToken('tail')], finished: true });
    await t.runtime.idle();
    await flush();
    expect(t.runtime.state).toBe('finished');
    expect(t.store.chunks.map((c) => c.text)).toEqual(['tail']);
  });

  it('rejects a second sender while one is active with lastHeardAt', async () => {
    const t = await setup();
    const { link } = await goLive(t);
    t.runtime.onFrame(link, frameOf(0), 1234);
    expect(t.runtime.attachSender(makeLink(2))).toMatchObject({ ok: false, code: 4409, reason: 'sender-active', lastHeardAt: 1234 });
  });
});

describe('SessionRuntime finish matrix and finalization', () => {
  it('starting -> finished with null completeness; repeated finish returns the current state', async () => {
    const t = await setup();
    const link = makeLink();
    t.factory.all.length = 0;
    const attached = t.runtime.attachSender(link);
    expect(attached.ok).toBe(true);
    // Provider has not opened yet (microtask pending): finish from starting.
    const result = await t.runtime.finish('http');
    expect(result).toEqual({ state: 'finished', completeness: null });
    expect(link.closed?.code).toBe(4404);
    expect(t.store.sessions.get(t.session.id)?.state).toBe('finished');
    expect(await t.runtime.finish('http')).toEqual({ state: 'finished', completeness: null });
  });

  it('interrupted -> finishing -> finished immediately when no generation is open', async () => {
    const t = await setup();
    const { link, provider } = await goLive(t);
    t.runtime.senderLost(link, 'socket_closed');
    provider.respond({ tokens: [], finished: true });
    await t.runtime.idle();
    expect(t.runtime.state).toBe('interrupted');
    const r = await t.runtime.finish('http');
    expect(r.state).toBe('finishing');
    await t.runtime.idle();
    await flush();
    expect(t.runtime.state).toBe('finished');
    expect(t.runtime.completeness).toBe('complete');
  });

  it('finalize runs after pending inserts complete', async () => {
    const t = await setup();
    const { provider } = await goLive(t);
    t.store.latency = () => 10;
    provider.respond({ tokens: [finalToken('a')] });
    provider.respond({ tokens: [finalToken('b')] });
    await t.runtime.finish('http');
    provider.respond({ tokens: [finalToken('c')], finished: true });
    expect(t.runtime.state).toBe('finishing');
    await t.runtime.idle();
    await flush();
    expect(t.runtime.state).toBe('finished');
    expect(t.store.chunks.map((c) => c.text)).toEqual(['a', 'b', 'c']);
    expect(t.store.streams.find((s) => s.outputType === 'original')?.publishedSeq).toBe(3);
  });

  it('deadline: finished/incomplete at the deadline, a late insert is stored but neither published nor in the window', async () => {
    const t = await setup({ config: { drainTimeoutMs: 30 } });
    const { provider } = await goLive(t);
    provider.respond({ tokens: [finalToken('early')] });
    await t.runtime.idle();
    t.store.beforeInsert = () => new Promise((r) => setTimeout(r, 90));
    provider.respond({ tokens: [finalToken('late')] });
    await flush();
    await t.runtime.finish('http');
    await new Promise((r) => setTimeout(r, 50));
    expect(t.runtime.state).toBe('finished');
    expect(t.runtime.completeness).toBe('incomplete');
    expect(t.hub.getSession('sala-1')?.streams.get('en')?.rows.map((r) => r.text)).toEqual(['early']);
    await new Promise((r) => setTimeout(r, 80));
    await t.runtime.idle();
    expect(t.store.chunks.map((c) => c.text)).toEqual(['early', 'late']);
    expect(t.hub.getSession('sala-1')?.streams.get('en')?.rows.map((r) => r.text)).toEqual(['early']);
    const original = t.store.streams.find((s) => s.outputType === 'original')!;
    expect(original.publishedSeq).toBe(1);
    const drain = t.store.events.find((e) => e.kind === 'drain_timeout');
    expect(drain?.detail.persistedUnpublished).toEqual({ 'original:en': [2] });
    const warmed = await warmHubSession(t.store, t.store.sessions.get(t.session.id)!, t.store.streams.filter((s) => s.sessionId === t.session.id), 20);
    expect(warmed.streams.get('en')?.rows.map((r) => r.text)).toEqual(['early']);
  });

  it('crash after the deadline: recovery excludes rows persisted after finishing_at + timeout and reports ambiguity', async () => {
    const store = new FakeStore();
    let clock = 1_000_000;
    store.clock = () => clock;
    const t = await setup({ store, config: { drainTimeoutMs: 30 } });
    const { provider } = await goLive(t);
    provider.respond({ tokens: [finalToken('early')] });
    await t.runtime.idle();
    // Insert is in flight when the deadline fires and commits with a persisted_at beyond the bound;
    // the process dies before the finish transaction.
    store.beforeInsert = async () => {
      await new Promise((r) => setTimeout(r, 60));
      clock += 100;
    };
    store.failures.set('markFinished', Infinity);
    provider.respond({ tokens: [finalToken('late')] });
    await flush();
    await t.runtime.finish('http');
    await new Promise((r) => setTimeout(r, 60));
    await t.runtime.idle();
    t.runtime.dispose();
    const row = store.sessions.get(t.session.id)!;
    expect(row.state).toBe('finishing');
    expect(store.chunks.map((c) => c.text)).toEqual(['early', 'late']);
    store.failures.delete('markFinished');
    const streams = store.streams.filter((s) => s.sessionId === t.session.id);
    const result = await recoverFinishingSession(store, { ...row }, streams, 30, 5000, silentLogger);
    expect(store.sessions.get(t.session.id)?.state).toBe('finished');
    expect(store.sessions.get(t.session.id)?.completeness).toBe('incomplete');
    expect(streams.find((s) => s.outputType === 'original')?.publishedSeq).toBe(1);
    expect(result.excluded).toEqual({ 'original:en': [2] });
    const event = store.events.find((e) => e.kind === 'drain_timeout' && e.detail.recovered === true);
    expect(event?.detail.ambiguousWindowMs).toBe(5000);
    const warmed = await warmHubSession(store, store.sessions.get(t.session.id)!, streams, 20);
    expect(warmed.streams.get('en')?.rows.map((r) => r.text)).toEqual(['early']);
  });

  it('crash variant: a commit before the bound is included although it was never fanned out', async () => {
    const store = new FakeStore();
    let clock = 2_000_000;
    store.clock = () => clock;
    const t = await setup({ store, config: { drainTimeoutMs: 30 } });
    const { provider } = await goLive(t);
    provider.respond({ tokens: [finalToken('early')] });
    await t.runtime.idle();
    store.beforeInsert = async () => {
      await new Promise((r) => setTimeout(r, 60));
      clock += 10;
    };
    store.failures.set('markFinished', Infinity);
    provider.respond({ tokens: [finalToken('ambiguous')] });
    await flush();
    await t.runtime.finish('http');
    await new Promise((r) => setTimeout(r, 60));
    await t.runtime.idle();
    t.runtime.dispose();
    store.failures.delete('markFinished');
    const row = store.sessions.get(t.session.id)!;
    const streams = store.streams.filter((s) => s.sessionId === t.session.id);
    const result = await recoverFinishingSession(store, { ...row }, streams, 30, 5000, silentLogger);
    expect(streams.find((s) => s.outputType === 'original')?.publishedSeq).toBe(2);
    expect(result.excluded).toEqual({});
  });
});

describe('SessionRuntime storage policy', () => {
  it('interrupts with storage_unavailable when the retry budget is exhausted and resumes after recovery', async () => {
    const t = await setup({ config: { retryBudgetMs: 30, retryIntervalMs: 5 } });
    const { link, provider } = await goLive(t);
    t.store.failures.set('insertFinals', Infinity);
    t.store.failures.set('markInterrupted', 3);
    provider.respond({ tokens: [finalToken('x')] });
    provider.respond({ tokens: [finalToken('y')] });
    await t.runtime.idle();
    await flush();
    expect(t.runtime.state).toBe('interrupted');
    expect(t.runtime.cause).toBe('storage_unavailable');
    expect(link.closed).toEqual({ code: 4410, reason: 'storage-unavailable' });
    expect(provider.terminated).toBe(true);
    expect(t.runtime.counters.responsesDiscardedStorage).toBeGreaterThanOrEqual(1);
    expect(t.runtime.attachSender(makeLink(2))).toMatchObject({ ok: false, reason: 'storage-unavailable' });
    t.store.failures.delete('insertFinals');
    await new Promise((r) => setTimeout(r, 40));
    expect(t.runtime.storage).toBe('ok');
    expect(t.store.events.some((e) => e.kind === 'persist_failure')).toBe(true);
    const again = t.runtime.attachSender(makeLink(3));
    expect(again.ok).toBe(true);
    await flush();
    expect(t.runtime.state).toBe('live');
  });

  it('bounds the chain: more than the max pending responses trips storage_unavailable', async () => {
    const t = await setup({ config: { chainMaxItems: 3 } });
    const { provider } = await goLive(t);
    let release: () => void = () => undefined;
    t.store.beforeInsert = () => new Promise((r) => (release = r));
    for (let i = 0; i < 6; i++) provider.respond({ tokens: [finalToken(`w${i}`)] });
    await flush();
    expect(t.runtime.state).toBe('interrupted');
    expect(t.runtime.cause).toBe('storage_unavailable');
    release();
    await t.runtime.idle();
  });
});

describe('SessionRuntime segments across generations', () => {
  it('<end> and a new generation open segments; partial reports the pending segment', async () => {
    const t = await setup({ sourceLanguage: 'es' });
    const { provider } = await goLive(t);
    provider.respond({ tokens: [finalToken('Hola.'), endToken, partialToken('Qué')] });
    await t.runtime.idle();
    const hub = t.hub.getSession('sala-1')!.streams.get('es')!;
    expect(hub.rows.map((r) => r.segmentSeq)).toEqual([1]);
    expect(hub.partial?.segmentSeq).toBe(2);
    provider.respond({ tokens: [finalToken('Qué tal.')] });
    await t.runtime.idle();
    expect(hub.rows.map((r) => r.segmentSeq)).toEqual([1, 2]);
  });
});

describe('SessionRuntime races around resume and finish', () => {
  function discontinuities(link: { sent: SenderServerMessage[] }) {
    return link.sent.filter((m) => m.type === 'discontinuity').map((m) => (m as { detail: Record<string, unknown> }).detail);
  }

  it('tells the sender it was interrupted before closing it', async () => {
    const t = await setup();
    const { link } = await goLive(t);
    t.runtime.senderLost(link, 'socket_closed');
    expect(link.sent.some((m) => m.type === 'state' && m.state === 'interrupted' && m.cause === 'sender_lost')).toBe(true);
    expect(link.closed).toEqual({ code: 4410, reason: 'detached' });
  });

  it('a sender lost while its resume generation is opening leaves the session interrupted and resumable', async () => {
    const t = await setup();
    const { link, provider } = await goLive(t);
    t.runtime.senderLost(link, 'socket_closed');
    provider.respond({ tokens: [], finished: true });
    await t.runtime.idle();
    await flush();
    t.factory.openBehavior = 'deferred';
    const resume = makeLink(2);
    expect(t.runtime.attachSender(resume).ok).toBe(true);
    t.runtime.senderLost(resume, 'socket_closed');
    const opening = t.factory.all[1]!;
    expect(opening.terminated).toBe(true);
    opening.resolveOpen();
    await flush();
    await t.runtime.idle();
    await flush();
    expect(t.runtime.state).toBe('interrupted');
    expect(t.store.sessions.get(t.session.id)?.state).toBe('interrupted');
    t.factory.openBehavior = 'resolve';
    expect(t.runtime.attachSender(makeLink(3)).ok).toBe(true);
    await flush();
    expect(t.runtime.state).toBe('live');
  });

  it('a sender lost while the live write runs keeps the session interrupted in memory and storage', async () => {
    const t = await setup();
    t.store.latency = (op) => (op === 'markLive' ? 20 : 0);
    const link = makeLink();
    expect(t.runtime.attachSender(link).ok).toBe(true);
    await flush();
    expect(t.store.calls).toContain('markLive');
    t.runtime.senderLost(link, 'socket_closed');
    await new Promise((r) => setTimeout(r, 40));
    await t.runtime.idle();
    await flush();
    expect(t.runtime.state).toBe('interrupted');
    expect(t.runtime.cause).toBe('sender_lost');
    expect(t.store.sessions.get(t.session.id)?.state).toBe('interrupted');
  });

  it('the deadline does not override a finish write that is already running', async () => {
    const t = await setup({ config: { drainTimeoutMs: 40, retryBudgetMs: 1000, retryIntervalMs: 30 } });
    const { provider } = await goLive(t);
    t.store.failures.set('markFinished', 2);
    const seen: string[] = [];
    const publish = t.hub.publishState.bind(t.hub);
    t.hub.publishState = (...args: Parameters<typeof publish>) => {
      seen.push(args[2].state + '/' + args[2].completeness);
      return publish(...args);
    };
    await t.runtime.finish('http');
    provider.respond({ tokens: [], finished: true });
    await new Promise((r) => setTimeout(r, 150));
    await t.runtime.idle();
    await flush();
    expect(seen.filter((s) => s.startsWith('finished'))).toEqual(['finished/complete']);
    expect(t.store.sessions.get(t.session.id)).toMatchObject({ state: 'finished', completeness: 'complete' });
  });

  it('a storage failure while finishing finishes incomplete and never writes interrupted', async () => {
    const t = await setup({ config: { retryBudgetMs: 20, retryIntervalMs: 5 } });
    const { provider } = await goLive(t);
    t.store.failures.set('insertFinals', Infinity);
    provider.respond({ tokens: [finalToken('lost')] });
    await t.runtime.finish('http');
    await new Promise((r) => setTimeout(r, 80));
    await t.runtime.idle();
    await flush();
    expect(t.runtime.state).toBe('finished');
    expect(t.runtime.completeness).toBe('incomplete');
    expect(t.store.sessions.get(t.session.id)).toMatchObject({ state: 'finished', completeness: 'incomplete' });
    expect(t.store.calls).not.toContain('markInterrupted');
    expect(t.store.events.some((e) => e.kind === 'persist_failure')).toBe(true);
  });

  it('frames dropped while the reconnecting generation opens are reported with their full extent', async () => {
    const t = await setup();
    const { link, provider } = await goLive(t);
    t.runtime.onFrame(link, frameOf(0), 1);
    t.factory.openBehavior = 'deferred';
    provider.closeFromServer();
    t.runtime.onFrame(link, frameOf(1600), 2);
    await new Promise((r) => setTimeout(r, 15));
    t.runtime.onFrame(link, frameOf(3200), 3);
    t.runtime.onFrame(link, frameOf(4800), 4);
    t.factory.all[1]!.resolveOpen();
    await flush();
    t.runtime.onFrame(link, frameOf(6400), 5);
    const unprocessed = discontinuities(link).filter((d) => d.kind === 'provider_unprocessed');
    expect(unprocessed).toHaveLength(1);
    expect(unprocessed[0]).toMatchObject({ extentSamples: 4800, droppedSamples: 4800, unprocessedSamples: 1600, sourceRange: { exact: true, start: 0, end: 1600 } });
    expect(discontinuities(link).some((d) => d.kind === 'client_gap')).toBe(false);
    expect(t.factory.all[1]!.deliveredSamples()).toBe(1600);
  });

  it('frames sent while a resume generation opens are counted as dropped, not as a client gap', async () => {
    const t = await setup();
    const { link, provider } = await goLive(t);
    t.runtime.senderLost(link, 'socket_closed');
    provider.respond({ tokens: [], finished: true });
    await t.runtime.idle();
    await flush();
    t.factory.openBehavior = 'deferred';
    const resume = makeLink(2);
    expect(t.runtime.attachSender(resume).ok).toBe(true);
    t.runtime.onFrame(resume, frameOf(0), 1);
    t.runtime.onFrame(resume, frameOf(1600), 2);
    t.factory.all[1]!.resolveOpen();
    await flush();
    await t.runtime.idle();
    await flush();
    expect(t.runtime.state).toBe('live');
    t.runtime.onFrame(resume, frameOf(3200), 3);
    expect(discontinuities(resume).some((d) => d.kind === 'client_gap')).toBe(false);
    expect(discontinuities(resume).find((d) => d.kind === 'provider_unprocessed')).toMatchObject({ droppedSamples: 3200 });
    expect(t.factory.all[1]!.deliveredSamples()).toBe(1600);
  });

  it('pause and resume keep positions contiguous: the flushed remainder and the next frame leave no gap', async () => {
    const t = await setup();
    const { link, provider } = await goLive(t);
    t.runtime.onFrame(link, frameOf(0), 1);
    t.runtime.onFrame(link, frameOf(1600), 2);
    t.runtime.onFrame(link, frameOf(3200, 800), 3);
    t.runtime.onPause(link);
    t.runtime.onResume(link);
    t.runtime.onFrame(link, frameOf(4000), 4);
    expect(discontinuities(link)).toEqual([]);
    expect(provider.deliveredSamples()).toBe(5600);
  });
});

describe('SessionRuntime Spanish source with English translation', () => {
  const streamIdsByLang = (t: Awaited<ReturnType<typeof setup>>) => new Map([['es', t.streamOf('original').id], ['en', t.streamOf('translation').id]]);

  it('requests en, routes originals to original:es and translations to translation:en, keeps partials per stream, and publishes only after persistence', async () => {
    const t = await setup({ sourceLanguage: 'es', streams: ES_STREAMS });
    const { provider } = await goLive(t);
    expect(provider.input).toMatchObject({ sourceLanguage: 'es', translationTarget: 'en', clientReferenceId: `${t.session.id}/1` });
    expect(t.hub.getPublicRoom('sala-1')?.session?.availableLanguages).toEqual([
      { lang: 'es', outputType: 'original', label: 'Español (original)' },
      { lang: 'en', outputType: 'translation', label: 'English (translation)' },
    ]);
    const ids = streamIdsByLang(t);
    t.store.latency = (op) => (op === 'insertFinals' ? 3 : 0);
    const publishedBeforeCommit: string[] = [];
    const originalPublish = t.hub.publishFinal.bind(t.hub);
    t.hub.publishFinal = (slug, sessionId, lang, row) => {
      if (!t.store.chunks.some((c) => c.streamId === ids.get(lang) && c.seq === row.seq)) publishedBeforeCommit.push(`${lang}:${row.seq}`);
      return originalPublish(slug, sessionId, lang, row);
    };
    // The observed shape: the original arrives first, its translation in a later response; translations are fewer than originals.
    for (let i = 1; i <= 5; i++) {
      provider.respond({ tokens: [esFinal(`hola${i} `), partialToken('qué')], final_audio_proc_ms: i * 1000 });
      if (i <= 3) provider.respond({ tokens: [enTranslation(`hello${i} `), partialToken('wh', true)] });
    }
    provider.respond({ tokens: [partialToken('qué tal'), partialToken('what', true)] });
    await t.runtime.idle();
    expect(publishedBeforeCommit).toEqual([]);
    expect(t.store.chunksOf(ids.get('es')!).map((c) => [c.seq, c.text])).toEqual([1, 2, 3, 4, 5].map((i) => [i, `hola${i} `]));
    expect(t.store.chunksOf(ids.get('en')!).map((c) => [c.seq, c.text])).toEqual([1, 2, 3].map((i) => [i, `hello${i} `]));
    const hub = t.hub.getSession('sala-1')!;
    expect(hub.streams.get('es')?.outputType).toBe('original');
    expect(hub.streams.get('en')?.outputType).toBe('translation');
    expect(hub.streams.get('es')?.rows.map((r) => r.text)).toEqual([1, 2, 3, 4, 5].map((i) => `hola${i} `));
    expect(hub.streams.get('en')?.rows.map((r) => r.text)).toEqual([1, 2, 3].map((i) => `hello${i} `));
    expect(hub.streams.get('es')?.partial?.text).toBe('qué tal');
    expect(hub.streams.get('en')?.partial?.text).toBe('what');
    provider.respond({ tokens: [endToken] });
    await t.runtime.idle();
    expect(hub.streams.get('es')?.partial).toMatchObject({ segmentSeq: 2, text: '' });
    expect(hub.streams.get('en')?.partial).toMatchObject({ segmentSeq: 2, text: '' });
  });

  it('reconnects after an unexpected close with the same target and opens a new segment in both streams', async () => {
    vi.useFakeTimers();
    const t = await setup({ sourceLanguage: 'es', streams: ES_STREAMS, config: { reconnectBackoffMs: [5] } });
    const link = makeLink();
    expect(t.runtime.attachSender(link).ok).toBe(true);
    await vi.runOnlyPendingTimersAsync();
    expect(t.runtime.state).toBe('live');
    const first = t.factory.all[0]!;
    first.respond({ tokens: [esFinal('Uno.')] });
    first.respond({ tokens: [enTranslation('One.')] });
    await t.runtime.idle();
    first.closeFromServer();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.runtime.state).toBe('live');
    const second = t.factory.all[1]!;
    expect(second.input).toMatchObject({ translationTarget: 'en', clientReferenceId: `${t.session.id}/2` });
    second.respond({ tokens: [esFinal('Dos.'), enTranslation('Two.')] });
    await t.runtime.idle();
    expect(t.store.chunksOf(t.streamOf('translation').id).map((c) => [c.seq, c.segmentSeq, c.providerGeneration])).toEqual([
      [1, 1, 1],
      [2, 2, 2],
    ]);
    expect(t.store.chunksOf(t.streamOf('original').id).map((c) => c.segmentSeq)).toEqual([1, 2]);
    expect(t.factory.all.map((p) => p.input.translationTarget)).toEqual(['en', 'en']);
  });

  it('keeps a translation that arrives while draining after sender loss, then resumes with the same target', async () => {
    const t = await setup({ sourceLanguage: 'es', streams: ES_STREAMS });
    const { link, provider } = await goLive(t);
    t.runtime.onFrame(link, frameOf(0), 1);
    provider.respond({ tokens: [esFinal('Hola.')] });
    await t.runtime.idle();
    t.runtime.onDetach(link, 'device_lost');
    expect(t.runtime.state).toBe('interrupted');
    expect(provider.ended).toBe(true);
    expect(t.runtime.attachSender(makeLink(2))).toMatchObject({ ok: false, code: 4409, reason: 'generation-draining' });
    provider.respond({ tokens: [enTranslation('Hello.')] });
    provider.respond({ tokens: [], finished: true });
    await t.runtime.idle();
    expect(t.hub.getSession('sala-1')?.streams.get('en')?.rows.map((r) => r.text)).toEqual(['Hello.']);
    expect(t.store.chunksOf(t.streamOf('translation').id).map((c) => c.seq)).toEqual([1]);
    expect(t.runtime.attachSender(makeLink(3))).toMatchObject({ ok: true, epoch: 2, expectedPosition: 0 });
    await flush();
    expect(t.runtime.state).toBe('live');
    expect(t.factory.all).toHaveLength(2);
    expect(t.factory.all[1]?.input.translationTarget).toBe('en');
  });

  it('requests the same target after finished-while-live and after a rejected open', async () => {
    vi.useFakeTimers();
    const t = await setup({ sourceLanguage: 'es', streams: ES_STREAMS, config: { reconnectBackoffMs: [5] } });
    const link = makeLink();
    expect(t.runtime.attachSender(link).ok).toBe(true);
    await vi.runOnlyPendingTimersAsync();
    expect(t.runtime.state).toBe('live');
    // The provider ends the stream on its own while live: the runtime reconnects.
    t.factory.all[0]!.respond({ tokens: [esFinal('Uno.'), enTranslation('One.')], finished: true });
    await t.runtime.idle();
    await vi.advanceTimersByTimeAsync(5);
    expect(t.factory.all).toHaveLength(2);
    expect(t.factory.all[1]?.opened).toBe(true);
    // That connection drops and the next open is rejected; the one after succeeds.
    t.factory.openBehavior = 'reject';
    t.factory.all[1]!.closeFromServer();
    await vi.advanceTimersByTimeAsync(5);
    expect(t.factory.all).toHaveLength(3);
    t.factory.openBehavior = 'resolve';
    await vi.advanceTimersByTimeAsync(5);
    expect(t.factory.all).toHaveLength(4);
    expect(t.factory.all[3]?.opened).toBe(true);
    expect(t.runtime.state).toBe('live');
    expect(t.factory.all.map((p) => p.input.translationTarget)).toEqual(['en', 'en', 'en', 'en']);
    expect(t.factory.all.map((p) => p.input.clientReferenceId)).toEqual([1, 2, 3, 4].map((n) => `${t.session.id}/${n}`));
    expect(t.store.chunksOf(t.streamOf('translation').id).map((c) => c.text)).toEqual(['One.']);
  });

  it('finishes complete after a translation that arrives during the drain, with a watermark per stream', async () => {
    for (const sameResponse of [false, true]) {
      const t = await setup({ sourceLanguage: 'es', streams: ES_STREAMS });
      const { link, provider } = await goLive(t);
      t.store.latency = (op) => (op === 'insertFinals' ? 10 : 0);
      provider.respond({ tokens: [esFinal('Uno.')] });
      provider.respond({ tokens: [esFinal(' Dos.'), enTranslation('One.')] });
      t.runtime.onEnd(link, 'finish');
      await flush();
      expect(t.runtime.state).toBe('finishing');
      expect(provider.ended).toBe(true);
      if (sameResponse) {
        provider.respond({ tokens: [enTranslation(' Two.')], finished: true });
      } else {
        provider.respond({ tokens: [enTranslation(' Two.')] });
        provider.respond({ tokens: [], finished: true });
      }
      await t.runtime.idle();
      await flush();
      expect(t.runtime.state).toBe('finished');
      expect(t.runtime.completeness).toBe('complete');
      expect(t.store.chunksOf(t.streamOf('original').id).map((c) => c.text)).toEqual(['Uno.', ' Dos.']);
      expect(t.store.chunksOf(t.streamOf('translation').id).map((c) => c.text)).toEqual(['One.', ' Two.']);
      expect(t.store.streams.find((s) => s.id === t.streamOf('original').id)?.publishedSeq).toBe(2);
      expect(t.store.streams.find((s) => s.id === t.streamOf('translation').id)?.publishedSeq).toBe(2);
      expect(t.hub.getSession('sala-1')?.streams.get('en')?.rows.map((r) => r.text)).toEqual(['One.', ' Two.']);
      expect(t.hub.getPublicRoom('sala-1')?.session).toMatchObject({ state: 'finished', completeness: 'complete' });
    }
  });

  it('deadline with a mixed insert in flight: both rows are recorded as persisted but unpublished and stay out of the window', async () => {
    const t = await setup({ sourceLanguage: 'es', streams: ES_STREAMS, config: { drainTimeoutMs: 20 } });
    const { provider } = await goLive(t);
    provider.respond({ tokens: [esFinal('Uno.'), enTranslation('One.')] });
    await t.runtime.idle();
    let release: () => void = () => undefined;
    t.store.beforeInsert = () => new Promise<void>((r) => (release = r));
    provider.respond({ tokens: [esFinal(' Dos.'), enTranslation(' Two.')] });
    await vi.waitFor(() => expect(t.store.calls.filter((c) => c === 'insertFinals')).toHaveLength(2));
    await t.runtime.finish('http');
    await vi.waitFor(() => expect(t.runtime.state).toBe('finished'));
    expect(t.runtime.completeness).toBe('incomplete');
    release();
    await t.runtime.idle();
    await flush();
    const drain = t.store.events.find((e) => e.kind === 'drain_timeout');
    expect(drain?.detail.inFlight).toBe(true);
    expect(drain?.detail.persistedUnpublished).toEqual({ 'original:es': [2], 'translation:en': [2] });
    expect(drain?.detail.frozenSeq).toEqual({ 'original:es': 1, 'translation:en': 1 });
    expect(t.store.streams.find((s) => s.id === t.streamOf('original').id)?.publishedSeq).toBe(1);
    expect(t.store.streams.find((s) => s.id === t.streamOf('translation').id)?.publishedSeq).toBe(1);
    const warmed = await warmHubSession(t.store, t.store.sessions.get(t.session.id)!, t.store.streams.filter((s) => s.sessionId === t.session.id), 20);
    expect(warmed.streams.get('es')?.rows.map((r) => r.text)).toEqual(['Uno.']);
    expect(warmed.streams.get('en')?.rows.map((r) => r.text)).toEqual(['One.']);
    expect(warmed.summary.availableLanguages.map((l) => l.lang)).toEqual(['es', 'en']);
  });

  it('deadline without any translation received: nothing is attributed to the translation stream and its window is empty', async () => {
    const t = await setup({ sourceLanguage: 'es', streams: ES_STREAMS, config: { drainTimeoutMs: 20 } });
    const { provider } = await goLive(t);
    provider.respond({ tokens: [esFinal('Uno.')] });
    await t.runtime.idle();
    await t.runtime.finish('http');
    await vi.waitFor(() => expect(t.runtime.state).toBe('finished'));
    expect(t.runtime.completeness).toBe('incomplete');
    await flush();
    const drain = t.store.events.find((e) => e.kind === 'drain_timeout');
    expect(drain?.detail.persistedUnpublished).toEqual({});
    expect(drain?.detail.frozenSeq).toEqual({ 'original:es': 1, 'translation:en': 0 });
    const warmed = await warmHubSession(t.store, t.store.sessions.get(t.session.id)!, t.store.streams.filter((s) => s.sessionId === t.session.id), 20);
    expect(warmed.streams.get('es')?.rows.map((r) => r.text)).toEqual(['Uno.']);
    expect(warmed.streams.get('en')?.rows).toEqual([]);
  });

  it('a Spanish session prepared with one stream requests no translation, offers Spanish only, and drops translation tokens', async () => {
    const t = await setup({ sourceLanguage: 'es', streams: ES_ONLY });
    const { provider } = await goLive(t);
    expect(provider.input.translationTarget).toBeNull();
    expect(t.hub.getPublicRoom('sala-1')?.session?.availableLanguages).toEqual([{ lang: 'es', outputType: 'original', label: 'Español (original)' }]);
    provider.respond({ tokens: [esFinal('Hola.'), enTranslation('Hello.')] });
    await t.runtime.idle();
    const hub = t.hub.getSession('sala-1')!;
    expect(hub.streams.has('en')).toBe(false);
    expect(hub.streams.get('es')?.rows.map((r) => r.text)).toEqual(['Hola.']);
    expect(t.store.streams.filter((s) => s.sessionId === t.session.id)).toHaveLength(1);
    expect(t.store.chunks.map((c) => c.text)).toEqual(['Hola.']);
  });
});

describe('crash recovery watermark', () => {
  it('es→en variant: a translation persisted after the bound is excluded and its window stays empty', async () => {
    const store = new FakeStore();
    let clock = 3_000_000;
    store.clock = () => clock;
    const room = await store.upsertRoom('sala-1', 'Sala 1');
    const { session, streams } = await store.createSession({ roomId: room.id, title: 'T', sourceLanguage: 'es', streams: ES_STREAMS });
    await store.startSession(session.id, { drainTimeoutMs: 30 });
    await store.markFinishing(session.id);
    const original = streams.find((s) => s.outputType === 'original')!;
    const translation = streams.find((s) => s.outputType === 'translation')!;
    await store.insertFinals([{ streamId: original.id, seq: 1, segmentSeq: 1, text: 'temprano', tokens: [], providerGeneration: 1, receivedAt: new Date(clock) }]);
    clock += 100;
    await store.insertFinals([{ streamId: translation.id, seq: 1, segmentSeq: 1, text: 'late', tokens: [], providerGeneration: 1, receivedAt: new Date(clock) }]);
    const result = await recoverFinishingSession(store, (await store.getSession(session.id))!, streams, 15000, 5000, silentLogger);
    expect(result.excluded).toEqual({ 'translation:en': [1] });
    const warmed = await warmHubSession(store, (await store.getSession(session.id))!, await store.loadStreams(session.id), 20);
    expect(warmed.streams.get('en')).toMatchObject({ outputType: 'translation', rows: [] });
    expect(warmed.streams.get('es')?.rows.map((r) => r.text)).toEqual(['temprano']);
    expect(warmed.summary.availableLanguages.map((l) => `${l.outputType}:${l.lang}`)).toEqual(['original:es', 'translation:en']);
  });

  it('gives a stream with no row within the bound a zero watermark, so its late rows are never served', async () => {
    const store = new FakeStore();
    let clock = 1_000_000;
    store.clock = () => clock;
    const room = await store.upsertRoom('sala-1', 'Sala 1');
    const { session, streams } = await store.createSession({ roomId: room.id, title: 'T', sourceLanguage: 'en', streams: EN_STREAMS });
    await store.startSession(session.id, { drainTimeoutMs: 30 });
    await store.markFinishing(session.id);
    const original = streams.find((s) => s.outputType === 'original')!;
    const translation = streams.find((s) => s.outputType === 'translation')!;
    await store.insertFinals([{ streamId: original.id, seq: 1, segmentSeq: 1, text: 'early', tokens: [], providerGeneration: 1, receivedAt: new Date(clock) }]);
    clock += 100;
    await store.insertFinals([{ streamId: translation.id, seq: 1, segmentSeq: 1, text: 'late', tokens: [], providerGeneration: 1, receivedAt: new Date(clock) }]);
    const result = await recoverFinishingSession(store, (await store.getSession(session.id))!, streams, 15000, 5000, silentLogger);
    expect(result.excluded).toEqual({ 'translation:es': [1] });
    const warmed = await warmHubSession(store, (await store.getSession(session.id))!, await store.loadStreams(session.id), 20);
    expect(warmed.streams.get('es')?.rows).toEqual([]);
    expect(warmed.streams.get('en')?.rows.map((r) => r.text)).toEqual(['early']);
  });
});
