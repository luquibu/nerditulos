import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame, type SenderServerMessage } from '@nerditulos/shared';
import type { AdminVerifier } from '../auth/token.js';
import { silentLogger } from '../log.js';
import { StreamHub } from '../public/streamHub.js';
import { RuntimeSessionManager } from '../sessions/SessionManager.js';
import { FakeStore, fakeProviderFactory, flush } from '../test/fakes.js';
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

async function harness(opts: { adminUserId?: string; exp?: () => number; now?: () => number } = {}) {
  const store = new FakeStore();
  const room = await store.upsertRoom('sala-1', 'Sala 1');
  const hub = new StreamHub({ publicWindowSegments: 20, log: silentLogger, pingIntervalMs: 1e9 });
  hub.setRoom({ slug: 'sala-1', name: 'Sala 1', index: 1 });
  const factory = fakeProviderFactory();
  const manager = new RuntimeSessionManager({
    store,
    rooms: [room],
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
  const options: SenderServerOptions = { allowedOrigins: ['https://x'], verifyAdmin: verify, manager, log: silentLogger, now: opts.now, pingIntervalMs: 1e9 };
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
    await h.manager.start(h.prepared.sessionId);
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
    await h.manager.start(h.prepared.sessionId);
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
    await h.manager.start(h.prepared.sessionId);
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
    await h.manager.start(h.prepared.sessionId);
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
    await h.manager.start(h.prepared.sessionId);
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
    await h.manager.start(h.prepared.sessionId);
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
    await h.manager.start(h.prepared.sessionId);
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
