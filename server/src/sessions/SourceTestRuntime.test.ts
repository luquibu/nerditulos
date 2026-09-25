import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../log.js';
import { endToken, fakeLink, fakeProviderFactory, finalToken, flush, frameOf, partialToken } from '../test/fakes.js';
import type { RuntimeConfig } from './SessionRuntime.js';
import { SOURCE_TEST_MAX_MS, SourceTestRuntime } from './SourceTestRuntime.js';

const CONFIG: RuntimeConfig = { drainTimeoutMs: 15000, segmentMaxChars: 400, sonioxModel: 'm', publicWindowSegments: 20, keepaliveIntervalMs: 1e9 };

function setup(opts: { config?: Partial<RuntimeConfig>; openBehavior?: 'resolve' | 'reject' | 'hang' | 'deferred'; now?: () => number } = {}) {
  const factory = fakeProviderFactory();
  factory.openBehavior = opts.openBehavior ?? 'resolve';
  const ended: string[] = [];
  const link = fakeLink(1);
  const runtime = new SourceTestRuntime(
    { providerFactory: factory, log: silentLogger, config: { ...CONFIG, ...opts.config }, now: opts.now, onEnded: (r) => ended.push(r.endReason ?? 'null') },
    'sala-1',
    'es',
    link,
    7,
  );
  return { factory, link, runtime, ended, provider: () => factory.all[0]! };
}

/** Microtask-only settle, so it also works under fake timers (the fake provider opens and closes in microtasks). */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function listening(opts: Parameters<typeof setup>[0] = {}) {
  const t = setup(opts);
  t.runtime.open();
  await settle();
  expect(t.runtime.state).toBe('listening');
  return t;
}

const esFinal = (text: string) => ({ ...finalToken(text), language: 'es' });

afterEach(() => {
  vi.useRealTimers();
});

describe('SourceTestRuntime', () => {
  it('opens one provider connection without translation and reports listening', async () => {
    const t = await listening();
    expect(t.factory.all).toHaveLength(1);
    expect(t.provider().input).toEqual({ model: 'm', sourceLanguage: 'es', translationTarget: null, clientReferenceId: 'test/sala-1/7' });
    expect(t.link.sent).toEqual([{ type: 'test', state: 'listening' }]);
    expect(t.link.closed).toBeNull();
    expect(t.ended).toEqual([]);
  });

  it('forwards frames only while listening and only from its sender', async () => {
    const t = setup({ openBehavior: 'deferred' });
    t.runtime.open();
    t.runtime.onFrame(t.link, frameOf(0), 1);
    expect(t.runtime.counters.framesDroppedNoProvider).toBe(1);
    expect(t.provider().deliveredSamples()).toBe(0);
    t.provider().resolveOpen();
    await flush();
    t.runtime.onFrame(t.link, frameOf(1600), 2);
    t.runtime.onFrame(fakeLink(2), frameOf(3200), 3);
    expect(t.provider().deliveredSamples()).toBe(1600);
    expect(t.runtime.counters.framesDroppedNoSender).toBe(1);
    t.provider().bufferedAmount = 160001;
    t.runtime.onFrame(t.link, frameOf(3200), 4);
    expect(t.runtime.counters.framesDroppedBackpressure).toBe(1);
    expect(t.provider().deliveredSamples()).toBe(1600);
  });

  it('turns provider responses into previews: accumulated finals, replaced partials, no control tokens', async () => {
    const t = await listening();
    t.provider().respond({ tokens: [esFinal('Hola'), partialToken(' mun')] });
    t.provider().respond({ tokens: [partialToken(' mundo')] });
    t.provider().respond({ tokens: [partialToken(' mundo')] });
    t.provider().respond({ tokens: [esFinal(' mundo'), endToken] });
    t.provider().respond({ tokens: [] });
    const previews = t.link.sent.filter((m) => m.type === 'preview');
    expect(previews).toEqual([
      { type: 'preview', final: 'Hola', partial: ' mun' },
      { type: 'preview', final: '', partial: ' mundo' },
      { type: 'preview', final: ' mundo', partial: '' },
    ]);
    expect(t.runtime.counters.previews).toBe(3);
    expect(t.runtime.counters.endTokens).toBe(1);
    expect(JSON.stringify(t.link.sent)).not.toContain('<end>');
  });

  it('ends as stopped on end, detach, or sender loss: provider terminated, link closed 1000 once', async () => {
    for (const trigger of ['end', 'detach', 'lost'] as const) {
      const t = await listening();
      if (trigger === 'end') t.runtime.onEnd(t.link, 'file_end');
      else if (trigger === 'detach') t.runtime.onDetach(t.link, 'device_lost');
      else t.runtime.senderLost(t.link, 'socket_closed');
      expect(t.runtime.state).toBe('ended');
      expect(t.provider().terminated).toBe(true);
      expect(t.link.sent[t.link.sent.length - 1]).toEqual({ type: 'test', state: 'ended', reason: 'stopped' });
      expect(t.link.closed).toEqual({ code: 1000, reason: 'stopped' });
      await flush();
      expect(t.ended).toEqual(['stopped']);
      // The provider's close after terminate does not end it again.
      expect(t.link.sent.filter((m) => m.type === 'test' && m.state === 'ended')).toHaveLength(1);
    }
  });

  it('ignores controls from another link', async () => {
    const t = await listening();
    t.runtime.onEnd(fakeLink(2), 'finish');
    t.runtime.senderLost(fakeLink(2), 'socket_closed');
    expect(t.runtime.state).toBe('listening');
  });

  it('ends on provider error responses with the code, without reconnecting', async () => {
    for (const code of [401, 500]) {
      const t = await listening();
      t.provider().respond({ error_code: code, error_message: 'x' });
      expect(t.runtime.state).toBe('ended');
      expect(t.link.sent[t.link.sent.length - 1]).toEqual({ type: 'test', state: 'ended', reason: 'provider_error', code });
      expect(t.link.closed).toEqual({ code: 4410, reason: 'provider-error' });
      await flush();
      expect(t.factory.all).toHaveLength(1);
      expect(t.ended).toEqual(['provider_error']);
    }
  });

  it('ends as provider_closed on a server close and on finished', async () => {
    const closed = await listening();
    closed.provider().closeFromServer(1011, 'gone');
    expect(closed.link.sent[closed.link.sent.length - 1]).toEqual({ type: 'test', state: 'ended', reason: 'provider_closed', code: 1011 });
    expect(closed.link.closed).toEqual({ code: 4410, reason: 'provider-closed' });
    const finished = await listening();
    finished.provider().respond({ tokens: [esFinal('fin')], finished: true });
    expect(finished.link.sent.filter((m) => m.type === 'preview')).toEqual([{ type: 'preview', final: 'fin', partial: '' }]);
    expect(finished.link.sent[finished.link.sent.length - 1]).toEqual({ type: 'test', state: 'ended', reason: 'provider_closed' });
    await flush();
    expect(finished.ended).toEqual(['provider_closed']);
  });

  it('a provider that fails to open ends the test as provider_error exactly once', async () => {
    const t = setup({ openBehavior: 'reject' });
    t.runtime.open();
    await flush();
    expect(t.runtime.state).toBe('ended');
    expect(t.link.sent).toEqual([{ type: 'test', state: 'ended', reason: 'provider_error' }]);
    expect(t.ended).toEqual(['provider_error']);
  });

  it('caps the test at five minutes by default, or at sourceTestMaxMs', async () => {
    vi.useFakeTimers();
    const t = await listening();
    await vi.advanceTimersByTimeAsync(SOURCE_TEST_MAX_MS - 1);
    expect(t.runtime.state).toBe('listening');
    await vi.advanceTimersByTimeAsync(1);
    expect(t.runtime.state).toBe('ended');
    expect(t.link.sent[t.link.sent.length - 1]).toEqual({ type: 'test', state: 'ended', reason: 'time_limit' });
    expect(t.link.closed).toEqual({ code: 4410, reason: 'time-limit' });
    const short = await listening({ config: { sourceTestMaxMs: 2000 } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(short.runtime.endReason).toBe('time_limit');
  });

  it('sends keepalives only while paused or without audio', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const t = await listening({ config: { keepaliveIntervalMs: 1000 }, now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.provider().keepalives).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    t.runtime.onFrame(t.link, frameOf(0), Date.now());
    await vi.advanceTimersByTimeAsync(500);
    expect(t.provider().keepalives).toBe(1);
    t.runtime.onPause(t.link);
    await vi.advanceTimersByTimeAsync(500);
    t.runtime.onFrame(t.link, frameOf(1600), Date.now());
    await vi.advanceTimersByTimeAsync(500);
    expect(t.provider().keepalives).toBe(2);
    t.runtime.onResume(t.link);
    await vi.advanceTimersByTimeAsync(500);
    t.runtime.onFrame(t.link, frameOf(3200), Date.now());
    await vi.advanceTimersByTimeAsync(500);
    expect(t.provider().keepalives).toBe(2);
  });

  it('counts responses after the end and dispose ends silently', async () => {
    const t = await listening();
    t.runtime.onEnd(t.link, 'finish');
    t.provider().respond({ tokens: [esFinal('tarde')] });
    expect(t.runtime.counters.responsesAfterEnd).toBe(1);
    expect(t.link.sent.filter((m) => m.type === 'preview')).toHaveLength(0);
    const d = await listening();
    d.runtime.dispose();
    expect(d.runtime.state).toBe('ended');
    expect(d.provider().terminated).toBe(true);
    expect(d.link.sent).toEqual([{ type: 'test', state: 'listening' }]);
    expect(d.link.closed).toBeNull();
    await flush();
    expect(d.ended).toEqual([]);
  });
});
