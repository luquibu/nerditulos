import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame, type SenderServerMessage } from '@nerditulos/shared';
import type { AdminVerifier } from '../auth/token.js';
import { silentLogger } from '../log.js';
import { StreamHub } from '../public/streamHub.js';
import { RuntimeSessionManager } from '../sessions/SessionManager.js';
import { endToken, FakeStore, fakeProviderFactory, finalToken, flush, partialToken } from '../test/fakes.js';
import { SenderConnection, type SenderServerOptions } from './sender.js';

class FakeWs extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  pings = 0;
  send(data: string) {
    this.sent.push(data);
  }
  close(code: number, reason: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
  terminate() {
    this.close(1006, 'terminated');
  }
  ping() {
    this.pings++;
  }
  messages(): SenderServerMessage[] {
    return this.sent.map((s) => JSON.parse(s) as SenderServerMessage);
  }
  text(message: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }
  binary(seq: number, position: number, samples = 1600) {
    this.emit('message', Buffer.from(encodeFrame(seq, position, new Int16Array(samples))), true);
  }
}

const ADMIN = 'user_admin';
const FORMAT = { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, chunkSamples: 1600 };

async function harness(opts: { adminUserId?: string; exp?: () => number; now?: () => number; demoMode?: boolean } = {}) {
  const store = new FakeStore();
  const room = await store.upsertRoom('sala-1', 'Sala 1');
  const room2 = await store.upsertRoom('sala-2', 'Sala 2');
  const hub = new StreamHub({ publicWindowSegments: 20, log: silentLogger, pingIntervalMs: 1e9 });
  hub.setRoom({ slug: 'sala-1', name: 'Sala 1', index: 1 });
  hub.setRoom({ slug: 'sala-2', name: 'Sala 2', index: 2 });
  const factory = fakeProviderFactory();
  const manager = new RuntimeSessionManager({
    store,
    rooms: [room, room2],
    hub,
    providerFactory: factory,
    log: silentLogger,
    config: { drainTimeoutMs: 15000, segmentMaxChars: 400, sonioxModel: 'm', publicWindowSegments: 20, retryIntervalMs: 5, retryBudgetMs: 60, keepaliveIntervalMs: 1e9 },
    now: opts.now,
  });
  const prepared = await manager.prepare('sala-1', { title: 'T', sourceLanguage: 'en' });
  const adminUserId = opts.adminUserId ?? ADMIN;
  const verify: AdminVerifier = async (token) => {
    if (token === 'valid') return adminUserId ? { ok: true, userId: ADMIN, exp: (opts.exp ?? (() => Date.now() + 60000))() } : { ok: false, code: 'not_configured' };
    if (token === 'other') return { ok: false, code: 'forbidden' };
    return { ok: false, code: 'unauthenticated' };
  };
  const options: SenderServerOptions = { allowedOrigins: ['https://x'], verifyAdmin: verify, demoMode: opts.demoMode ?? false, manager, log: silentLogger, now: opts.now, pingIntervalMs: 1e9 };
  const connect = () => {
    const ws = new FakeWs();
    const conn = new SenderConnection(ws as never, options);
    return { ws, conn };
  };
  return { store, manager, factory, prepared, connect, hub };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sender socket auth and codes', () => {
  it('closes 4401 when no auth arrives in time and when the token is garbage', async () => {
    vi.useFakeTimers();
    const h = await harness();
    const { ws } = h.connect();
    await vi.advanceTimersByTimeAsync(5001);
    expect(ws.closed?.code).toBe(4401);
    const second = h.connect();
    second.ws.text({ type: 'auth', token: 'garbage', sessionId: h.prepared.sessionId, format: FORMAT });
    await vi.runOnlyPendingTimersAsync();
    expect(second.ws.closed?.code).toBe(4401);
  });

  it('closes 4403 for another account and when no administrator is configured', async () => {
    const h = await harness();
    const other = h.connect();
    other.ws.text({ type: 'auth', token: 'other', sessionId: h.prepared.sessionId, format: FORMAT });
    await flush();
    expect(other.ws.closed?.code).toBe(4403);
    const unconfigured = await harness({ adminUserId: '' });
    const c = unconfigured.connect();
    c.ws.text({ type: 'auth', token: 'valid', sessionId: unconfigured.prepared.sessionId, format: FORMAT });
    await flush();
    expect(c.ws.closed?.code).toBe(4403);
  });

  it('closes 4404 for a session that is not joinable, 4415 for a bad format, and 4401 for audio before ready', async () => {
    const h = await harness();
    const notStarted = h.connect();
    notStarted.ws.text({ type: 'auth', token: 'valid', sessionId: h.prepared.sessionId, format: FORMAT });
    await flush();
    expect(notStarted.ws.closed?.code).toBe(4404);
    await h.manager.start(h.prepared.sessionId, { confirmedTestId: null });
    const badFormat = h.connect();
    badFormat.ws.text({ type: 'auth', token: 'valid', sessionId: h.prepared.sessionId, format: { ...FORMAT, sampleRate: 48000 } });
    await flush();
    expect(badFormat.ws.closed?.code).toBe(4415);
    const early = h.connect();
    early.ws.binary(0, 0);
    expect(early.ws.closed?.code).toBe(4401);
  });

  it('accepts the first sender, rejects a second with 4409 sender-active, and classifies positions', async () => {
    const h = await harness();
    await h.manager.start(h.prepared.sessionId, { confirmedTestId: null });
    const a = h.connect();
    a.ws.text({ type: 'auth', token: 'valid', sessionId: h.prepared.sessionId, format: FORMAT });
    await flush();
    expect(a.ws.messages()[0]).toEqual({ type: 'ready', epoch: 1, expectedPosition: 0 });
    const runtime = h.manager.getRuntime(h.prepared.sessionId)!;
    expect(runtime.state).toBe('live');
    const b = h.connect();
    b.ws.text({ type: 'auth', token: 'valid', sessionId: h.prepared.sessionId, format: FORMAT });
    await flush();
    expect(b.ws.closed?.code).toBe(4409);
    expect(b.ws.messages()[0]).toMatchObject({ type: 'rejected', reason: 'sender-active' });
    a.ws.binary(0, 0);
    a.ws.binary(1, 1600);
    a.ws.binary(2, 4800);
    const provider = h.factory.all[0]!;
    expect(provider.deliveredSamples()).toBe(4800);
    const gap = a.ws.messages().find((m) => m.type === 'discontinuity') as { detail: Record<string, unknown> };
    expect(gap.detail).toMatchObject({ kind: 'client_gap', extentSamples: 1600 });
    expect(a.ws.messages().filter((m) => m.type === 'ack')).toHaveLength(1);
  });

  it('binds the socket to the session: frames after finish are dropped and the socket closes 4404', async () => {
    const h = await harness();
    await h.manager.start(h.prepared.sessionId, { confirmedTestId: null });
    const a = h.connect();
    a.ws.text({ type: 'auth', token: 'valid', sessionId: h.prepared.sessionId, format: FORMAT });
    await flush();
    a.ws.text({ type: 'end', reason: 'finish' });
    await flush();
    const runtime = h.manager.getRuntime(h.prepared.sessionId)!;
    expect(runtime.state).toBe('finishing');
    a.ws.binary(0, 0);
    expect(runtime.counters.framesDroppedAfterEnd).toBe(1);
    h.factory.all[0]!.respond({ tokens: [], finished: true });
    await runtime.idle();
    await flush();
    expect(a.ws.closed?.code).toBe(4404);
    expect(h.manager.getRuntime(h.prepared.sessionId)).toBeNull();
  });

  it('socket close while live interrupts the session as sender_lost/socket_closed', async () => {
    const h = await harness();
    await h.manager.start(h.prepared.sessionId, { confirmedTestId: null });
    const a = h.connect();
    a.ws.text({ type: 'auth', token: 'valid', sessionId: h.prepared.sessionId, format: FORMAT });
    await flush();
    a.ws.close(1001, 'going away');
    await flush();
    const runtime = h.manager.getRuntime(h.prepared.sessionId)!;
    expect(runtime.state).toBe('interrupted');
    expect(runtime.cause).toBe('sender_lost');
    expect(h.store.events.find((e) => e.kind === 'sender_lost')?.detail.reason).toBe('socket_closed');
  });
});

describe('sender socket renewal and expiry', () => {
  function timed() {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    return harness({ exp: () => Date.now() + 60000, now: () => Date.now() });
  }

  it('renewal before exp keeps frames flowing', async () => {
    const h = await timed();
    await h.manager.start(h.prepared.sessionId, { confirmedTestId: null });
    const a = h.connect();
    a.ws.text({ type: 'auth', token: 'valid', sessionId: h.prepared.sessionId, format: FORMAT });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(40000);
    expect(a.ws.messages().some((m) => m.type === 'renew')).toBe(true);
    a.ws.text({ type: 'auth', token: 'valid' });
    await vi.advanceTimersByTimeAsync(30000);
    a.ws.binary(0, 0);
    expect(h.factory.all[0]!.deliveredSamples()).toBe(1600);
    expect(a.ws.closed).toBeNull();
  });

  it('without renewal frames after exp are dropped and counted; close 4401 at exp + 10 s', async () => {
    const h = await timed();
    await h.manager.start(h.prepared.sessionId, { confirmedTestId: null });
    const a = h.connect();
    a.ws.text({ type: 'auth', token: 'valid', sessionId: h.prepared.sessionId, format: FORMAT });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60000);
    a.ws.binary(0, 0);
    a.ws.text({ type: 'pause' });
    expect(a.conn.counters.framesDroppedUnauthorized).toBe(1);
    expect(a.conn.counters.controlRefusedUnauthorized).toBe(1);
    expect(h.factory.all[0]!.deliveredSamples()).toBe(0);
    await vi.advanceTimersByTimeAsync(9990);
    expect(a.ws.closed).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    expect(a.ws.closed?.code).toBe(4401);
    const runtime = h.manager.getRuntime(h.prepared.sessionId)!;
    expect(runtime.cause).toBe('sender_lost');
    expect(h.store.events.find((e) => e.kind === 'sender_lost')?.detail.reason).toBe('auth_expired');
  });

  it('late renewal at exp + 5 s: frames in between dropped and counted, frames after accepted', async () => {
    const h = await timed();
    await h.manager.start(h.prepared.sessionId, { confirmedTestId: null });
    const a = h.connect();
    a.ws.text({ type: 'auth', token: 'valid', sessionId: h.prepared.sessionId, format: FORMAT });
    await vi.advanceTimersByTimeAsync(1);
    a.ws.binary(0, 0);
    await vi.advanceTimersByTimeAsync(60000);
    a.ws.binary(1, 1600);
    a.ws.binary(2, 3200);
    await vi.advanceTimersByTimeAsync(5000);
    a.ws.text({ type: 'auth', token: 'valid' });
    await vi.advanceTimersByTimeAsync(1);
    a.ws.binary(3, 4800);
    expect(a.conn.counters.framesDroppedUnauthorized).toBe(2);
    expect(h.factory.all[0]!.deliveredSamples()).toBe(3200);
    const gap = a.ws.messages().find((m) => m.type === 'discontinuity') as { detail: Record<string, unknown> };
    expect(gap.detail).toMatchObject({ kind: 'client_gap', fromPosition: 1600, toPosition: 4800, extentSamples: 3200 });
    await vi.advanceTimersByTimeAsync(20000);
    expect(a.ws.closed).toBeNull();
  });
});

describe('sender socket source test', () => {
  const TEST = { room: 'sala-1', sourceLanguage: 'es' };

  async function testing(h: Awaited<ReturnType<typeof harness>>, test: Record<string, unknown> = TEST) {
    const c = h.connect();
    c.ws.text({ type: 'auth', token: 'valid', test, format: FORMAT });
    await flush();
    return c;
  }

  it('rejects auth without a target, with both, with a bad test, and with an unknown room', async () => {
    const h = await harness();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, 'missing-target'],
      [{ sessionId: h.prepared.sessionId, test: TEST }, 'ambiguous-target'],
      [{ test: 'sala-1' }, 'invalid-test'],
      [{ test: { room: '', sourceLanguage: 'es' } }, 'invalid-test'],
      [{ test: { room: 'sala-1', sourceLanguage: 'fr' } }, 'invalid-language'],
      [{ test: { room: 'sala-9', sourceLanguage: 'es' } }, 'room-not-found'],
    ];
    for (const [extra, reason] of cases) {
      const c = h.connect();
      c.ws.text({ type: 'auth', token: 'valid', format: FORMAT, ...extra });
      await flush();
      expect(c.ws.messages()[0], reason).toEqual({ type: 'rejected', reason });
      expect(c.ws.closed, reason).toEqual({ code: 4404, reason });
    }
    expect(h.factory.all).toHaveLength(0);
  });

  it('attaches a test: ready, listening, an original-only provider, and nothing stored or published', async () => {
    const h = await harness();
    h.store.calls.length = 0;
    const c = await testing(h);
    expect(c.ws.messages()).toEqual([{ type: 'ready', epoch: 1, expectedPosition: 0, testId: h.manager.testForRoom('sala-1')!.id }, { type: 'test', state: 'listening' }]);
    const provider = h.factory.all[0]!;
    expect(provider.input).toMatchObject({ sourceLanguage: 'es', translationTarget: null });
    expect(provider.input.clientReferenceId).toMatch(/^test\/sala-1\/\d+$/);
    expect(h.store.calls.filter((call) => call === 'createSession' || call === 'startSession' || call === 'insertFinals')).toEqual([]);
    expect(h.hub.getPublicRoom('sala-1')?.session).toBeNull();
    expect(h.manager.testForRoom('sala-1')).not.toBeNull();
  });

  it('frames before the provider opens are dropped while acks keep flowing; previews come from the provider', async () => {
    const h = await harness();
    h.factory.openBehavior = 'deferred';
    const c = await testing(h);
    expect(c.ws.messages()).toEqual([{ type: 'ready', epoch: 1, expectedPosition: 0, testId: expect.any(String) }]);
    c.ws.binary(0, 0);
    const provider = h.factory.all[0]!;
    expect(provider.deliveredSamples()).toBe(0);
    expect(c.ws.messages().filter((m) => m.type === 'ack')).toHaveLength(1);
    provider.resolveOpen();
    await flush();
    expect(c.ws.messages().some((m) => m.type === 'test' && m.state === 'listening')).toBe(true);
    c.ws.binary(1, 1600);
    expect(provider.deliveredSamples()).toBe(1600);
    provider.respond({ tokens: [{ ...finalToken('Hola'), language: 'es' }, partialToken(' mun')] });
    provider.respond({ tokens: [{ ...finalToken(' mundo'), language: 'es' }, endToken] });
    expect(c.ws.messages().filter((m) => m.type === 'preview')).toEqual([
      { type: 'preview', final: 'Hola', partial: ' mun' },
      { type: 'preview', final: ' mundo', partial: '' },
    ]);
    expect(c.ws.sent.join('')).not.toContain('<end>');
    expect(h.store.chunks).toHaveLength(0);
  });

  it('end from the client stops the test with 1000 and frees the room; a client close terminates the provider too', async () => {
    const h = await harness();
    const c = await testing(h);
    c.ws.text({ type: 'end', reason: 'file_end' });
    await flush();
    expect(c.ws.messages()[c.ws.messages().length - 1]).toEqual({ type: 'test', state: 'ended', reason: 'stopped' });
    expect(c.ws.closed).toEqual({ code: 1000, reason: 'stopped' });
    expect(h.factory.all[0]!.terminated).toBe(true);
    expect(h.manager.testForRoom('sala-1')).toBeNull();
    const again = await testing(h);
    expect(again.ws.messages()[0]).toEqual({ type: 'ready', epoch: 1, expectedPosition: 0, testId: expect.any(String) });
    again.ws.close(1001, 'going away');
    await flush();
    expect(h.factory.all[1]!.terminated).toBe(true);
    expect(h.manager.testForRoom('sala-1')).toBeNull();
  });

  it('rejects a test in a room with an active session and a second test in the same room', async () => {
    const h = await harness();
    await h.manager.start(h.prepared.sessionId, { confirmedTestId: null });
    const busy = await testing(h);
    expect(busy.ws.messages()[0]).toEqual({ type: 'rejected', reason: 'room-busy' });
    expect(busy.ws.closed).toEqual({ code: 4409, reason: 'room-busy' });
    const first = await testing(h, { room: 'sala-2', sourceLanguage: 'en' });
    expect(first.ws.messages()[0]).toEqual({ type: 'ready', epoch: 1, expectedPosition: 0, testId: expect.any(String) });
    const second = await testing(h, { room: 'sala-2', sourceLanguage: 'en' });
    expect(second.ws.messages()[0]).toEqual({ type: 'rejected', reason: 'test-active' });
    expect(second.ws.closed).toEqual({ code: 4409, reason: 'test-active' });
    expect(first.ws.closed).toBeNull();
  });

  it('starting a session in the room ends its test with session_started, and the session sender then attaches', async () => {
    const h = await harness();
    const c = await testing(h);
    const testId = (c.ws.messages()[0] as { testId?: string }).testId;
    expect(testId).toBe(h.manager.testForRoom('sala-1')!.id);
    await expect(h.manager.start(h.prepared.sessionId, { confirmedTestId: null })).rejects.toMatchObject({ status: 409, code: 'test_active', detail: { testId, testSourceLanguage: 'es' } });
    expect(c.ws.closed).toBeNull();
    await h.manager.start(h.prepared.sessionId, { confirmedTestId: testId ?? null });
    expect(c.ws.messages()[c.ws.messages().length - 1]).toEqual({ type: 'test', state: 'ended', reason: 'session_started' });
    expect(c.ws.closed).toEqual({ code: 4410, reason: 'session-started' });
    expect(h.factory.all[0]!.terminated).toBe(true);
    const s = h.connect();
    s.ws.text({ type: 'auth', token: 'valid', sessionId: h.prepared.sessionId, format: FORMAT });
    await flush();
    expect(s.ws.messages()[0]).toEqual({ type: 'ready', epoch: 1, expectedPosition: 0 });
    expect(h.manager.getRuntime(h.prepared.sessionId)?.state).toBe('live');
  });

  it('expiry without renewal closes 4401 and terminates the provider; renewal keeps the test', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const h = await harness({ exp: () => Date.now() + 60000, now: () => Date.now() });
    const c = h.connect();
    c.ws.text({ type: 'auth', token: 'valid', test: TEST, format: FORMAT });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(70010);
    expect(c.ws.closed?.code).toBe(4401);
    expect(h.factory.all[0]!.terminated).toBe(true);
    expect(h.manager.testForRoom('sala-1')).toBeNull();
    const r = h.connect();
    r.ws.text({ type: 'auth', token: 'valid', test: TEST, format: FORMAT });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(40000);
    expect(r.ws.messages().some((m) => m.type === 'renew')).toBe(true);
    r.ws.text({ type: 'auth', token: 'valid' });
    await vi.advanceTimersByTimeAsync(40000);
    r.ws.binary(0, 0);
    expect(h.factory.all[1]!.deliveredSamples()).toBe(1600);
    expect(r.ws.closed).toBeNull();
    expect(h.manager.testForRoom('sala-1')).not.toBeNull();
  });
});
