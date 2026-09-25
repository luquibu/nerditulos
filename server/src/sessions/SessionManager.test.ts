import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { encodeCursor, type SenderServerMessage } from '@nerditulos/shared';
import { silentLogger } from '../log.js';
import { StreamHub } from '../public/streamHub.js';
import { FakeStore, fakeProviderFactory, finalToken, flush, frameOf, partialToken, type FakeProvider } from '../test/fakes.js';
import { ManagerError, RuntimeSessionManager } from './SessionManager.js';
import type { SenderLink } from './SessionRuntime.js';
import type { StreamRow } from './SessionStore.js';

class FakeRes extends EventEmitter {
  chunks: string[] = [];
  writableLength = 0;
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  destroy() {
    this.emit('close');
  }
  events() {
    return this.chunks
      .join('')
      .split('\n\n')
      .filter((f) => f && !f.startsWith(':'))
      .map((frame) => {
        const out: { event: string; id?: string; data: unknown } = { event: '', data: null };
        for (const line of frame.split('\n')) {
          if (line.startsWith('id: ')) out.id = line.slice(4);
          else if (line.startsWith('event: ')) out.event = line.slice(7);
          else if (line.startsWith('data: ')) out.data = JSON.parse(line.slice(6));
        }
        return out;
      });
  }
}

function link(id: number) {
  const l = { id, sent: [] as SenderServerMessage[], closed: null as { code: number; reason: string } | null, send: (m: SenderServerMessage) => void l.sent.push(m), close: (code: number, reason: string) => void (l.closed = { code, reason }) };
  return l as SenderLink & typeof l;
}

const CONFIG = { drainTimeoutMs: 15000, segmentMaxChars: 400, sonioxModel: 'm', publicWindowSegments: 20, retryIntervalMs: 5, retryBudgetMs: 60, keepaliveIntervalMs: 1e9 };

async function twoRooms() {
  const store = new FakeStore();
  const rooms = [await store.upsertRoom('sala-1', 'Sala 1'), await store.upsertRoom('sala-2', 'Sala 2')];
  const hub = new StreamHub({ publicWindowSegments: 20, log: silentLogger, pingIntervalMs: 1e9 });
  rooms.forEach((r, i) => hub.setRoom({ slug: r.slug, name: r.name, index: i + 1 }));
  const factory = fakeProviderFactory();
  const manager = new RuntimeSessionManager({ store, rooms, hub, providerFactory: factory, log: silentLogger, config: CONFIG });
  return { store, rooms, hub, factory, manager };
}

const finalsOf = (r: FakeRes) => r.events().filter((e) => e.event === 'final');
const textsOf = (events: Array<{ data: unknown }>) => events.map((e) => (e.data as { text: string }).text);
const partialsOf = (r: FakeRes) => textsOf(r.events().filter((e) => e.event === 'partial'));
const specsOf = (streams: StreamRow[]) => streams.map((s) => `${s.outputType}:${s.language}`);

describe('RuntimeSessionManager with two rooms', () => {
  it('keeps rooms isolated: interleaved responses never cross rooms; seqs, cursors, and subscriptions are independent', async () => {
    const t = await twoRooms();
    const es = await t.manager.prepare('sala-1', { title: 'ES talk', sourceLanguage: 'es' });
    const en = await t.manager.prepare('sala-2', { title: 'EN talk', sourceLanguage: 'en' });
    await t.manager.start(es.sessionId);
    await t.manager.start(en.sessionId);
    const l1 = link(1);
    const l2 = link(2);
    expect(t.manager.attachSender(es.sessionId, l1).ok).toBe(true);
    expect(t.manager.attachSender(en.sessionId, l2).ok).toBe(true);
    await flush();
    const r1 = t.manager.getRuntime(es.sessionId)!;
    const r2 = t.manager.getRuntime(en.sessionId)!;
    expect([r1.state, r2.state]).toEqual(['live', 'live']);
    const [p1, p2] = t.factory.all as [FakeProvider, FakeProvider];
    expect(p1.input).toMatchObject({ sourceLanguage: 'es', translationTarget: 'en' });
    expect(p2.input).toMatchObject({ sourceLanguage: 'en', translationTarget: 'es' });
    expect(p1.input.clientReferenceId.startsWith(es.sessionId)).toBe(true);
    expect(p2.input.clientReferenceId.startsWith(en.sessionId)).toBe(true);
    // Audio frames go only to their own provider.
    r1.onFrame(l1, frameOf(0), 1);
    r2.onFrame(l2, frameOf(0), 1);
    r2.onFrame(l2, frameOf(1600), 2);
    expect([p1.deliveredSamples(), p2.deliveredSamples()]).toEqual([1600, 3200]);
    // Both languages in both rooms: the same `lang` is a translation in one room and an original in the other.
    const readers = { 'sala-1:es': new FakeRes(), 'sala-1:en': new FakeRes(), 'sala-2:es': new FakeRes(), 'sala-2:en': new FakeRes() };
    for (const [key, res] of Object.entries(readers)) {
      const [slug, lang] = key.split(':') as [string, string];
      t.hub.subscribe(slug, lang, null, res as unknown as ServerResponse);
    }
    // The Spanish room gets fewer translations than originals; texts differ per room and per output type.
    for (let i = 1; i <= 5; i++) {
      p1.respond({ tokens: [{ ...finalToken(`es${i} `), language: 'es' }, partialToken('x')] });
      if (i <= 3) p1.respond({ tokens: [{ ...finalToken(`tr-en${i} `, { translation: true }), language: 'en' }, partialToken('y', true)] });
      p2.respond({ tokens: [finalToken(`en${i} `), finalToken(`tr-es${i} `, { translation: true }), partialToken('z')] });
    }
    await r1.idle();
    await r2.idle();
    const chunksByStream = (sessionId: string) =>
      Object.fromEntries(t.store.streams.filter((s) => s.sessionId === sessionId).map((s) => [`${s.outputType}:${s.language}`, t.store.chunksOf(s.id)]));
    const s1 = chunksByStream(es.sessionId);
    const s2 = chunksByStream(en.sessionId);
    expect(Object.keys(s1)).toEqual(['original:es', 'translation:en']);
    expect(Object.keys(s2)).toEqual(['original:en', 'translation:es']);
    expect(s1['original:es']?.map((c) => c.text)).toEqual(['es1 ', 'es2 ', 'es3 ', 'es4 ', 'es5 ']);
    expect(s1['translation:en']?.map((c) => c.text)).toEqual(['tr-en1 ', 'tr-en2 ', 'tr-en3 ']);
    expect(s2['original:en']?.map((c) => c.text)).toEqual(['en1 ', 'en2 ', 'en3 ', 'en4 ', 'en5 ']);
    expect(s2['translation:es']?.map((c) => c.text)).toEqual(['tr-es1 ', 'tr-es2 ', 'tr-es3 ', 'tr-es4 ', 'tr-es5 ']);
    expect(s1['original:es']?.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(s1['translation:en']?.map((c) => c.seq)).toEqual([1, 2, 3]);
    for (const rows of Object.values(s2)) expect(rows.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(textsOf(finalsOf(readers['sala-1:es']))).toEqual(['es1 ', 'es2 ', 'es3 ', 'es4 ', 'es5 ']);
    expect(textsOf(finalsOf(readers['sala-1:en']))).toEqual(['tr-en1 ', 'tr-en2 ', 'tr-en3 ']);
    expect(textsOf(finalsOf(readers['sala-2:en']))).toEqual(['en1 ', 'en2 ', 'en3 ', 'en4 ', 'en5 ']);
    expect(textsOf(finalsOf(readers['sala-2:es']))).toEqual(['tr-es1 ', 'tr-es2 ', 'tr-es3 ', 'tr-es4 ', 'tr-es5 ']);
    // Partials stay within their stream: the English reader of the Spanish room sees the translation hypothesis, never the original one.
    expect(partialsOf(readers['sala-1:en'])).toContain('y');
    expect(partialsOf(readers['sala-1:en'])).not.toContain('x');
    expect(partialsOf(readers['sala-1:es'])).toContain('x');
    expect(partialsOf(readers['sala-1:es'])).not.toContain('y');
    expect(partialsOf(readers['sala-2:en'])).toContain('z');
    expect(partialsOf(readers['sala-2:en'])).not.toContain('x');
    // Cursors carry the output type.
    expect(finalsOf(readers['sala-1:es'])[0]?.id).toBe(encodeCursor({ sessionId: es.sessionId, outputType: 'original', language: 'es', seq: 1 }));
    expect(finalsOf(readers['sala-1:en'])[0]?.id).toBe(encodeCursor({ sessionId: es.sessionId, outputType: 'translation', language: 'en', seq: 1 }));
    expect(finalsOf(readers['sala-2:en'])[0]?.id).toBe(encodeCursor({ sessionId: en.sessionId, outputType: 'original', language: 'en', seq: 1 }));
    expect(finalsOf(readers['sala-2:es'])[0]?.id).toBe(encodeCursor({ sessionId: en.sessionId, outputType: 'translation', language: 'es', seq: 1 }));
    // A cursor from the other room, even for the same `lang`, is a snapshot, never a delta.
    const cross = new FakeRes();
    t.hub.subscribe('sala-2', 'en', finalsOf(readers['sala-1:en'])[2]?.id ?? null, cross as unknown as ServerResponse);
    expect(cross.events().map((e) => e.event)).toEqual(['session', 'snapshot', 'state', 'partial']);
    // Cutting one room's input leaves the other live.
    r1.senderLost(l1, 'socket_closed');
    expect(r1.state).toBe('interrupted');
    expect(r2.state).toBe('live');
    p2.respond({ tokens: [finalToken('en6 '), finalToken('tr-es6 ', { translation: true })] });
    await r2.idle();
    expect(finalsOf(readers['sala-2:en'])).toHaveLength(6);
    expect(finalsOf(readers['sala-2:es'])).toHaveLength(6);
    expect(finalsOf(readers['sala-1:es'])).toHaveLength(5);
    expect(finalsOf(readers['sala-1:en'])).toHaveLength(3);
    expect(t.hub.getPublicRoom('sala-1')?.session?.state).toBe('interrupted');
    expect(t.hub.getPublicRoom('sala-2')?.session?.state).toBe('live');
    // A second sender for the live room is rejected.
    expect(t.manager.attachSender(en.sessionId, link(3))).toMatchObject({ ok: false, code: 4409, reason: 'sender-active' });
  });

  it('start refuses a room with an active session and a non-prepared session; finish from prepared is 409', async () => {
    const t = await twoRooms();
    const a = await t.manager.prepare('sala-1', { title: 'A', sourceLanguage: 'es' });
    const b = await t.manager.prepare('sala-1', { title: 'B', sourceLanguage: 'es' });
    await t.manager.start(a.sessionId);
    await expect(t.manager.start(b.sessionId)).rejects.toMatchObject({ status: 409, code: 'room_busy', detail: { blockingSessionId: a.sessionId } });
    await expect(t.manager.start(a.sessionId)).rejects.toMatchObject({ status: 409, code: 'not_prepared' });
    await expect(t.manager.finish(b.sessionId)).rejects.toBeInstanceOf(ManagerError);
    const finished = await t.manager.finish(a.sessionId);
    expect(finished.state).toBe('finished');
    const again = await t.manager.finish(a.sessionId);
    expect(again.state).toBe('finished');
    const other = await t.manager.prepare('sala-2', { title: 'C', sourceLanguage: 'en' });
    await expect(t.manager.start(other.sessionId)).resolves.toMatchObject({ state: 'starting' });
  });

  it('boot recovery marks starting/live sessions interrupted with restart events and recovers finishing ones', async () => {
    const t = await twoRooms();
    const live = await t.manager.prepare('sala-1', { title: 'L', sourceLanguage: 'es' });
    await t.manager.start(live.sessionId);
    const l = link(1);
    t.manager.attachSender(live.sessionId, l);
    await flush();
    t.factory.all[0]!.respond({ tokens: [{ ...finalToken('hola'), language: 'es' }] });
    await t.manager.getRuntime(live.sessionId)!.idle();
    const fin = await t.manager.prepare('sala-2', { title: 'F', sourceLanguage: 'es' });
    await t.manager.start(fin.sessionId);
    await t.store.markFinishing(fin.sessionId);
    // Simulate a restart: a fresh manager over the same store.
    const hub2 = new StreamHub({ publicWindowSegments: 20, log: silentLogger, pingIntervalMs: 1e9 });
    t.rooms.forEach((r, i) => hub2.setRoom({ slug: r.slug, name: r.name, index: i + 1 }));
    const manager2 = new RuntimeSessionManager({ store: t.store, rooms: await t.store.listRooms(), hub: hub2, providerFactory: fakeProviderFactory(), log: silentLogger, config: { drainTimeoutMs: 15000, segmentMaxChars: 400, sonioxModel: 'm', publicWindowSegments: 20 } });
    await manager2.boot();
    expect(t.store.sessions.get(live.sessionId)?.state).toBe('interrupted');
    expect(t.store.sessions.get(live.sessionId)?.cause).toBe('interrupted_on_restart');
    const kinds = t.store.events.filter((e) => e.sessionId === live.sessionId).map((e) => e.kind);
    expect(kinds).toContain('interrupted_on_restart');
    expect(t.store.events.find((e) => e.sessionId === live.sessionId && e.kind === 'discontinuity')?.detail).toMatchObject({ kind: 'restart', extentSamples: 'unknown', lastPersistedSeq: { 'original:es': 1, 'translation:en': 0 } });
    expect(t.store.sessions.get(fin.sessionId)?.state).toBe('finished');
    expect(t.store.sessions.get(fin.sessionId)?.completeness).toBe('incomplete');
    // The recovered runtime accepts a re-auth with the same session id and resumes.
    const l2 = link(2);
    expect(manager2.attachSender(live.sessionId, l2)).toMatchObject({ ok: true, epoch: 1 });
    await flush();
    expect(manager2.getRuntime(live.sessionId)?.state).toBe('live');
    expect(manager2.getRuntime(live.sessionId)?.generationNumber).toBe(2);
  });

  it('boot recovery derives each session\'s provider target from its own streams', async () => {
    const t = await twoRooms();
    const fresh = await t.manager.prepare('sala-1', { title: 'Fresh ES', sourceLanguage: 'es' });
    // A Spanish session prepared before English translation existed: one stream, inserted as the older code did.
    const { session: legacy } = await t.store.createSession({ roomId: t.rooms[1]!.id, title: 'Legacy ES', sourceLanguage: 'es', streams: [{ outputType: 'original', language: 'es' }] });
    await t.manager.start(fresh.sessionId);
    await t.manager.start(legacy.id);
    expect(t.manager.attachSender(fresh.sessionId, link(1)).ok).toBe(true);
    expect(t.manager.attachSender(legacy.id, link(2)).ok).toBe(true);
    await flush();
    expect(t.manager.getRuntime(fresh.sessionId)?.state).toBe('live');
    expect(t.manager.getRuntime(legacy.id)?.state).toBe('live');
    expect(t.factory.all.map((p) => p.input.translationTarget)).toEqual(['en', null]);
    t.manager.dispose();
    const hub2 = new StreamHub({ publicWindowSegments: 20, log: silentLogger, pingIntervalMs: 1e9 });
    t.rooms.forEach((r, i) => hub2.setRoom({ slug: r.slug, name: r.name, index: i + 1 }));
    const factory2 = fakeProviderFactory();
    const manager2 = new RuntimeSessionManager({ store: t.store, rooms: await t.store.listRooms(), hub: hub2, providerFactory: factory2, log: silentLogger, config: CONFIG });
    await manager2.boot();
    expect(manager2.attachSender(fresh.sessionId, link(3)).ok).toBe(true);
    expect(manager2.attachSender(legacy.id, link(4)).ok).toBe(true);
    await flush();
    expect(factory2.all).toHaveLength(2);
    const targetByReference = new Map(factory2.all.map((p) => [p.input.clientReferenceId, p.input.translationTarget]));
    expect(targetByReference.get(`${fresh.sessionId}/2`)).toBe('en');
    expect(targetByReference.get(`${legacy.id}/2`)).toBeNull();
    expect(manager2.getRuntime(fresh.sessionId)?.offeredStreams()).toEqual([{ outputType: 'original', language: 'es' }, { outputType: 'translation', language: 'en' }]);
    expect(manager2.getRuntime(legacy.id)?.offeredStreams()).toEqual([{ outputType: 'original', language: 'es' }]);
  });
});

describe('RuntimeSessionManager stream policy and start', () => {
  it('prepare gives a Spanish session Spanish original and English translation, and an English session the reverse', async () => {
    const t = await twoRooms();
    const es = await t.manager.prepare('sala-1', { title: 'ES', sourceLanguage: 'es' });
    const en = await t.manager.prepare('sala-1', { title: 'EN', sourceLanguage: 'en' });
    expect(specsOf(t.store.streams.filter((s) => s.sessionId === es.sessionId))).toEqual(['original:es', 'translation:en']);
    expect(specsOf(t.store.streams.filter((s) => s.sessionId === en.sessionId))).toEqual(['original:en', 'translation:es']);
    expect(es).not.toHaveProperty('availableLanguages');
    expect(es).toMatchObject({ roomSlug: 'sala-1', state: 'prepared', sourceLanguage: 'es', startedAt: null, endedAt: null });
  });

  it('start reads the streams once before the state write and records the target the provider will be asked for', async () => {
    const t = await twoRooms();
    const check = async (sessionId: string, expected: 'es' | 'en' | null, linkId: number) => {
      t.store.calls.length = 0;
      await t.manager.start(sessionId);
      const calls = t.store.calls;
      expect(calls.filter((c) => c === 'loadStreams')).toHaveLength(1);
      expect(calls.indexOf('loadStreams')).toBeLessThan(calls.indexOf('startSession'));
      expect((t.store.sessions.get(sessionId)?.effectiveConfig as { translationTarget: unknown }).translationTarget).toBe(expected);
      expect(t.manager.attachSender(sessionId, link(linkId)).ok).toBe(true);
      expect(t.factory.all[t.factory.all.length - 1]?.input.translationTarget).toBe(expected);
      // Finish from `starting` frees the room without waiting for the provider.
      await t.manager.finish(sessionId);
    };
    const es = await t.manager.prepare('sala-1', { title: 'ES', sourceLanguage: 'es' });
    await check(es.sessionId, 'en', 1);
    const en = await t.manager.prepare('sala-1', { title: 'EN', sourceLanguage: 'en' });
    await check(en.sessionId, 'es', 2);
    const { session: legacy } = await t.store.createSession({ roomId: t.rooms[0]!.id, title: 'Legacy', sourceLanguage: 'es', streams: [{ outputType: 'original', language: 'es' }] });
    await check(legacy.id, null, 3);
    // A failed stream read leaves the session prepared and without a runtime.
    const failing = await t.manager.prepare('sala-1', { title: 'F', sourceLanguage: 'es' });
    t.store.failures.set('loadStreams', 1);
    t.store.calls.length = 0;
    await expect(t.manager.start(failing.sessionId)).rejects.toThrow('fake failure: loadStreams');
    expect(t.store.sessions.get(failing.sessionId)?.state).toBe('prepared');
    expect(t.manager.getRuntime(failing.sessionId)).toBeNull();
    expect(t.store.calls).not.toContain('startSession');
  });

  it('concurrent starts: the same session twice yields one runtime; two sessions in one room yield one room_busy', async () => {
    const t = await twoRooms();
    t.store.latency = (op) => (op === 'findBlockingSession' ? 5 : 0);
    const a = await t.manager.prepare('sala-1', { title: 'A', sourceLanguage: 'es' });
    const twice = await Promise.allSettled([t.manager.start(a.sessionId), t.manager.start(a.sessionId)]);
    expect(twice.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((twice.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined)?.reason).toMatchObject({ status: 409, code: 'not_prepared' });
    expect(t.manager.liveRuntimes().map((r) => r.id)).toEqual([a.sessionId]);
    const b = await t.manager.prepare('sala-2', { title: 'B', sourceLanguage: 'en' });
    const c = await t.manager.prepare('sala-2', { title: 'C', sourceLanguage: 'es' });
    const race = await Promise.allSettled([t.manager.start(b.sessionId), t.manager.start(c.sessionId)]);
    const rejected = race.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ status: 409, code: 'room_busy' });
    expect(t.manager.liveRuntimes().filter((r) => r.room.slug === 'sala-2')).toHaveLength(1);
    expect([b.sessionId, c.sessionId].filter((id) => t.store.sessions.get(id)?.state === 'starting')).toHaveLength(1);
  });

  it('lists sessions without availableLanguages, from a runtime or from the store alike', async () => {
    const t = await twoRooms();
    const a = await t.manager.prepare('sala-1', { title: 'A', sourceLanguage: 'es' });
    await t.manager.start(a.sessionId);
    const withRuntime = (await t.manager.listAdminRooms())[0]!.sessions[0]!;
    expect(withRuntime).toMatchObject({ sessionId: a.sessionId, state: 'starting', roomSlug: 'sala-1', sourceLanguage: 'es' });
    expect(withRuntime).not.toHaveProperty('availableLanguages');
    await t.manager.finish(a.sessionId);
    const fromStore = (await t.manager.listAdminRooms())[0]!.sessions[0]!;
    expect(fromStore).toMatchObject({ sessionId: a.sessionId, state: 'finished', completeness: null });
    expect(fromStore).not.toHaveProperty('availableLanguages');
    expect(Object.keys(fromStore).sort()).toEqual(Object.keys(withRuntime).sort());
  });
});
