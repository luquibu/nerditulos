import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { AUDIO_FORMAT, decodeFrame, FRAME_MAX_BYTES, SENDER_CLOSE, type AudioFormat, type SenderClientMessage, type SenderServerMessage, type SourceTestTarget } from '@nerditulos/shared';
import type { AdminVerifier } from '../auth/token.js';
import type { Logger } from '../log.js';
import type { SenderLink, SenderLostReason, SenderTarget } from '../sessions/senderTarget.js';
import type { SessionManager } from '../sessions/SessionManager.js';

export const SENDER_PATH = '/ws/sender';

export interface SenderServerOptions {
  allowedOrigins: string[];
  verifyAdmin: AdminVerifier;
  /** Demo mode: the `auth` message needs no token and the connection never expires; the verifier is not called. */
  demoMode: boolean;
  manager: SessionManager;
  log: Logger;
  now?: () => number;
  authTimeoutMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  renewLeadMs?: number;
  expiryGraceMs?: number;
  ackIntervalMs?: number;
}

function formatMatches(format: unknown): format is AudioFormat {
  if (!format || typeof format !== 'object') return false;
  const f = format as Record<string, unknown>;
  return f.encoding === AUDIO_FORMAT.encoding && f.sampleRate === AUDIO_FORMAT.sampleRate && f.channels === AUDIO_FORMAT.channels && f.chunkSamples === AUDIO_FORMAT.chunkSamples;
}

function parseTestTarget(test: unknown): { ok: true; target: SourceTestTarget } | { ok: false; reason: 'invalid-test' | 'invalid-language' } {
  if (!test || typeof test !== 'object') return { ok: false, reason: 'invalid-test' };
  const t = test as Record<string, unknown>;
  if (typeof t.room !== 'string' || t.room.length === 0 || t.room.length > 64) return { ok: false, reason: 'invalid-test' };
  if (t.sourceLanguage !== 'es' && t.sourceLanguage !== 'en') return { ok: false, reason: 'invalid-language' };
  return { ok: true, target: { room: t.room, sourceLanguage: t.sourceLanguage } };
}

type AuthStatus = 'pending' | 'authorized' | 'unauthorized';

/** One sender connection. Exported for tests, which drive it with a fake socket. */
export class SenderConnection {
  static nextId = 1;
  readonly id = SenderConnection.nextId++;
  readonly link: SenderLink;
  private status: AuthStatus = 'pending';
  private userId: string | null = null;
  private authorizedUntil = 0;
  private runtime: SenderTarget | null = null;
  /** Log context once attached: the session, or the room under test. */
  private target: { sessionId?: string; room?: string } = {};
  private lostReason: SenderLostReason | null = null;
  private closedByRuntime = false;
  private authTimer: NodeJS.Timeout | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private lastAckAt = 0;
  private renewing = false;
  readonly counters = { framesDroppedUnauthorized: 0, controlRefusedUnauthorized: 0, framesBeforeReady: 0, badFrames: 0 };
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(
    private readonly ws: WebSocket,
    private readonly opts: SenderServerOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log.child({ sender: this.id });
    this.link = {
      id: this.id,
      send: (message) => this.send(message),
      close: (code, reason) => {
        this.closedByRuntime = true;
        this.close(code, reason);
      },
    };
    this.authTimer = setTimeout(() => this.close(SENDER_CLOSE.UNAUTHENTICATED, 'auth-timeout'), opts.authTimeoutMs ?? 5000);
    ws.on('message', (data, isBinary) => this.onMessage(data as Buffer | Buffer[] | ArrayBuffer, isBinary));
    ws.on('pong', () => this.onPong());
    ws.on('close', (code, reason) => this.onClose(code, reason.toString()));
    ws.on('error', (error) => this.log.warn('sender socket error', { error: error.message }));
    this.pingTimer = setInterval(() => this.ping(), opts.pingIntervalMs ?? 25000);
  }

  private send(message: SenderServerMessage) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private close(code: number, reason: string) {
    this.clearTimers();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(code, reason);
  }

  private clearTimers() {
    for (const t of [this.authTimer, this.renewTimer, this.expiryTimer, this.graceTimer, this.pongTimer]) if (t) clearTimeout(t);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.authTimer = this.renewTimer = this.expiryTimer = this.graceTimer = this.pongTimer = this.pingTimer = null;
  }

  private ping() {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.ping();
    if (!this.pongTimer) {
      this.pongTimer = setTimeout(() => {
        this.lostReason = 'pong_timeout';
        this.log.warn('pong deadline missed');
        this.ws.terminate();
      }, this.opts.pongTimeoutMs ?? 10000);
    }
  }

  private onPong() {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private onMessage(data: Buffer | Buffer[] | ArrayBuffer, isBinary: boolean) {
    if (isBinary) {
      this.onBinary(Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    }
    let message: SenderClientMessage;
    try {
      message = JSON.parse((Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8')) as SenderClientMessage;
    } catch {
      this.close(1007, 'invalid-json');
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      this.close(1007, 'invalid-message');
      return;
    }
    if (message.type === 'auth') {
      void this.onAuth(message);
      return;
    }
    if (this.status !== 'authorized' || !this.runtime) {
      this.counters.controlRefusedUnauthorized++;
      return;
    }
    switch (message.type) {
      case 'pause':
        this.runtime.onPause(this.link);
        break;
      case 'resume':
        this.runtime.onResume(this.link);
        break;
      case 'end':
        if (message.reason === 'finish' || message.reason === 'file_end') this.runtime.onEnd(this.link, message.reason);
        break;
      case 'detach':
        if (message.reason === 'device_lost') {
          this.lostReason = 'device_lost';
          this.runtime.onDetach(this.link, message.reason);
        }
        break;
      default:
        this.close(1007, 'unknown-message');
    }
  }

  private onBinary(data: Buffer) {
    if (this.status === 'pending') {
      this.counters.framesBeforeReady++;
      this.close(SENDER_CLOSE.UNAUTHENTICATED, 'audio-before-ready');
      return;
    }
    if (this.status === 'unauthorized' || !this.runtime) {
      this.counters.framesDroppedUnauthorized++;
      return;
    }
    if (data.byteLength > FRAME_MAX_BYTES) {
      this.close(SENDER_CLOSE.OVERSIZED, 'oversized');
      return;
    }
    const decoded = decodeFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (!decoded.ok) {
      this.counters.badFrames++;
      this.close(1007, `bad-frame:${decoded.error}`);
      return;
    }
    const receivedAt = this.now();
    this.runtime.onFrame(this.link, decoded.frame, receivedAt);
    if (receivedAt - this.lastAckAt >= (this.opts.ackIntervalMs ?? 1000)) {
      this.lastAckAt = receivedAt;
      this.send({ type: 'ack', seq: decoded.frame.seq, samplePosition: decoded.frame.samplePosition, receivedAt });
    }
  }

  private reject(reason: string, code: number, lostReason?: SenderLostReason) {
    this.send({ type: 'rejected', reason });
    if (lostReason) this.lostReason = lostReason;
    this.close(code, reason);
  }

  private async onAuth(message: { token?: unknown; sessionId?: unknown; test?: unknown; format?: unknown }) {
    if (this.renewing) return;
    this.renewing = true;
    try {
      if (this.opts.demoMode) {
        // No identity to verify and nothing to renew: a second `auth` on an attached socket is ignored.
        if (this.status !== 'pending' || this.ws.readyState !== WebSocket.OPEN) return;
        const attached = this.attachTarget(message);
        if (!attached) return;
        this.status = 'authorized';
        this.log.info('sender ready', { ...this.target, epoch: attached.epoch, demo: true });
        this.send({ type: 'ready', epoch: attached.epoch, expectedPosition: attached.expectedPosition, ...(attached.testId ? { testId: attached.testId } : {}) });
        return;
      }
      const token = typeof message.token === 'string' ? message.token : '';
      let result: Awaited<ReturnType<AdminVerifier>>;
      try {
        result = await this.opts.verifyAdmin(token);
      } catch {
        result = { ok: false, code: 'unauthenticated' };
      }
      if (this.ws.readyState !== WebSocket.OPEN) return;
      if (!result.ok) {
        if (result.code === 'unauthenticated') {
          if (this.status === 'pending') this.reject('unauthenticated', SENDER_CLOSE.UNAUTHENTICATED);
          // A failed renewal keeps the grace window running; expiry decides.
          return;
        }
        this.reject(result.code === 'forbidden' ? 'forbidden' : 'admin-not-configured', SENDER_CLOSE.FORBIDDEN, 'auth_expired');
        return;
      }
      if (this.status === 'pending') {
        const attached = this.attachTarget(message);
        if (!attached) return;
        this.userId = result.userId;
        this.setAuthorized(result.exp);
        this.log.info('sender ready', { ...this.target, epoch: attached.epoch });
        this.send({ type: 'ready', epoch: attached.epoch, expectedPosition: attached.expectedPosition, ...(attached.testId ? { testId: attached.testId } : {}) });
        return;
      }
      if (result.userId !== this.userId) {
        this.lostReason = 'auth_expired';
        this.close(SENDER_CLOSE.UNAUTHENTICATED, 'subject-changed');
        return;
      }
      this.setAuthorized(result.exp);
      this.log.info('sender renewed', { ...this.target });
    } finally {
      this.renewing = false;
    }
  }

  /**
   * First `auth` on the socket: validates the target and the format, attaches to the session or the
   * room's source test, and rejects (closing the socket) when anything is off. One target per socket.
   */
  private attachTarget(message: { sessionId?: unknown; test?: unknown; format?: unknown }): { epoch: number; expectedPosition: number; testId?: string } | null {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
    const sessionId = typeof message.sessionId === 'string' && message.sessionId.length > 0 ? message.sessionId : null;
    const hasTest = message.test !== undefined && message.test !== null;
    if (sessionId && hasTest) {
      this.reject('ambiguous-target', SENDER_CLOSE.NOT_JOINABLE);
      return null;
    }
    if (!sessionId && !hasTest) {
      this.reject('missing-target', SENDER_CLOSE.NOT_JOINABLE);
      return null;
    }
    if (!formatMatches(message.format)) {
      this.reject('unsupported-format', SENDER_CLOSE.UNSUPPORTED_FORMAT);
      return null;
    }
    let attach: ReturnType<SessionManager['attachSender']> | ReturnType<SessionManager['attachTest']>;
    let testId: string | undefined;
    if (sessionId) {
      attach = this.opts.manager.attachSender(sessionId, this.link);
      this.target = { sessionId };
    } else {
      const parsed = parseTestTarget(message.test);
      if (!parsed.ok) {
        this.reject(parsed.reason, SENDER_CLOSE.NOT_JOINABLE);
        return null;
      }
      const test = this.opts.manager.attachTest(parsed.target, this.link);
      attach = test;
      if (test.ok) testId = test.runtime.id;
      this.target = { room: parsed.target.room };
    }
    if (!attach.ok) {
      this.send({ type: 'rejected', reason: attach.reason, ...(attach.lastHeardAt !== undefined ? { lastHeardAt: attach.lastHeardAt } : {}) });
      this.close(attach.code, attach.reason);
      return null;
    }
    this.runtime = attach.runtime;
    return { epoch: attach.epoch, expectedPosition: attach.expectedPosition, ...(testId ? { testId } : {}) };
  }

  private setAuthorized(exp: number) {
    this.status = 'authorized';
    this.authorizedUntil = exp;
    for (const t of [this.renewTimer, this.expiryTimer, this.graceTimer]) if (t) clearTimeout(t);
    this.renewTimer = this.expiryTimer = this.graceTimer = null;
    const now = this.now();
    const lead = this.opts.renewLeadMs ?? 20000;
    this.renewTimer = setTimeout(() => this.send({ type: 'renew' }), Math.max(0, exp - lead - now));
    this.expiryTimer = setTimeout(() => this.onExpiry(), Math.max(0, exp - now));
  }

  private onExpiry() {
    if (this.status !== 'authorized') return;
    if (this.now() < this.authorizedUntil) return;
    this.status = 'unauthorized';
    this.log.warn('sender authorization expired; awaiting renewal');
    this.graceTimer = setTimeout(() => {
      if (this.status === 'unauthorized') {
        this.lostReason = 'auth_expired';
        this.close(SENDER_CLOSE.UNAUTHENTICATED, 'auth-expired');
      }
    }, this.opts.expiryGraceMs ?? 10000);
  }

  private onClose(code: number, reason: string) {
    this.clearTimers();
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime && !this.closedByRuntime && runtime.isSender(this.link)) {
      runtime.senderLost(this.link, this.lostReason ?? 'socket_closed');
    }
    this.log.info('sender closed', { code, reason: reason.slice(0, 60), counters: this.counters });
  }
}

export function attachSenderServer(server: Server, opts: SenderServerOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: FRAME_MAX_BYTES });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== SENDER_PATH) {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin ?? '';
    if (!opts.allowedOrigins.includes(origin)) {
      opts.log.warn('sender upgrade rejected: origin', { origin: origin.slice(0, 80) });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      new SenderConnection(ws, opts);
    });
  });
  return wss;
}
