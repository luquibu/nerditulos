import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { AUDIO_FORMAT, decodeFrame, FRAME_MAX_BYTES, SENDER_CLOSE, type AudioFormat, type SenderClientMessage, type SenderServerMessage } from '@nerditulos/shared';
import type { AdminVerifier } from '../auth/token.js';
import type { Logger } from '../log.js';
import type { SessionManager } from '../sessions/SessionManager.js';
import type { SenderLink, SenderLostReason, SessionRuntime } from '../sessions/SessionRuntime.js';

export const SENDER_PATH = '/ws/sender';

export interface SenderServerOptions {
  allowedOrigins: string[];
  verifyAdmin: AdminVerifier;
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

type AuthStatus = 'pending' | 'authorized' | 'unauthorized';

/** One sender connection. Exported for tests, which drive it with a fake socket. */
export class SenderConnection {
  static nextId = 1;
  readonly id = SenderConnection.nextId++;
  readonly link: SenderLink;
  private status: AuthStatus = 'pending';
  private userId: string | null = null;
  private authorizedUntil = 0;
  private runtime: SessionRuntime | null = null;
  private sessionId: string | null = null;
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

  private async onAuth(message: { token?: unknown; sessionId?: unknown; format?: unknown }) {
    if (this.renewing) return;
    this.renewing = true;
    try {
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
          if (this.status === 'pending') {
            this.send({ type: 'rejected', reason: 'unauthenticated' });
            this.close(SENDER_CLOSE.UNAUTHENTICATED, 'unauthenticated');
          }
          // A failed renewal keeps the grace window running; expiry decides.
          return;
        }
        this.send({ type: 'rejected', reason: result.code === 'forbidden' ? 'forbidden' : 'admin-not-configured' });
        this.lostReason = 'auth_expired';
        this.close(SENDER_CLOSE.FORBIDDEN, result.code === 'forbidden' ? 'forbidden' : 'admin-not-configured');
        return;
      }
      if (this.status === 'pending') {
        if (this.authTimer) clearTimeout(this.authTimer);
        this.authTimer = null;
        if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
          this.send({ type: 'rejected', reason: 'missing-session' });
          this.close(SENDER_CLOSE.NOT_JOINABLE, 'missing-session');
          return;
        }
        if (!formatMatches(message.format)) {
          this.send({ type: 'rejected', reason: 'unsupported-format' });
          this.close(SENDER_CLOSE.UNSUPPORTED_FORMAT, 'unsupported-format');
          return;
        }
        const attach = this.opts.manager.attachSender(message.sessionId, this.link);
        if (!attach.ok) {
          this.send({ type: 'rejected', reason: attach.reason, ...(attach.lastHeardAt !== undefined ? { lastHeardAt: attach.lastHeardAt } : {}) });
          this.close(attach.code, attach.reason);
          return;
        }
        this.runtime = attach.runtime;
        this.sessionId = message.sessionId;
        this.userId = result.userId;
        this.setAuthorized(result.exp);
        this.log.info('sender ready', { sessionId: this.sessionId, epoch: attach.epoch });
        this.send({ type: 'ready', epoch: attach.epoch, expectedPosition: attach.expectedPosition });
        return;
      }
      if (result.userId !== this.userId) {
        this.lostReason = 'auth_expired';
        this.close(SENDER_CLOSE.UNAUTHENTICATED, 'subject-changed');
        return;
      }
      this.setAuthorized(result.exp);
      this.log.info('sender renewed', { sessionId: this.sessionId });
    } finally {
      this.renewing = false;
    }
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
