import { AUDIO_FORMAT, encodeFrame, SENDER_CLOSE_NO_RETRY, type DiscontinuityDetail, type SenderClientMessage, type SenderServerMessage, type SourceTestTarget } from '@nerditulos/shared';

export interface SenderSocketEvents {
  /** `testId` comes with a source test's `ready`. */
  onReady(epoch: number, expectedPosition: number, testId?: string): void;
  onRejected(reason: string, lastHeardAt?: number): void;
  onAck(ack: { seq: number; samplePosition: number; receivedAt: number }): void;
  onFinishing(): void;
  onState(state: Extract<SenderServerMessage, { type: 'state' }>): void;
  onDiscontinuity(detail: DiscontinuityDetail): void;
  onClose(code: number, reason: string, noRetry: boolean): void;
  /** Source test only. */
  onPreview?(message: Extract<SenderServerMessage, { type: 'preview' }>): void;
  onTest?(message: Extract<SenderServerMessage, { type: 'test' }>): void;
}

/** What the socket attaches to: a started session, or a room's source test. */
export type SenderTargetSpec = { sessionId: string } | { test: SourceTestTarget };

// Client congestion limit: chunks captured while more than 64000 bytes (2 s) are queued are dropped.
export const CLIENT_BUFFER_LIMIT = 64000;

export type TokenGetter = (options?: { skipCache?: boolean }) => Promise<string | null>;

/** Constructor of the underlying WebSocket, injectable for tests. */
export type WebSocketFactory = (url: string) => WebSocket;

export interface SenderSocketOptions {
  url: string;
  target: SenderTargetSpec;
  /** `clerk`: fetch a token and send it in `auth`; `demo`: no token, no renewal. */
  auth: { mode: 'clerk' | 'demo' };
  getToken: TokenGetter;
  events: SenderSocketEvents;
  debug?: (line: Record<string, unknown>) => void;
  createWebSocket?: WebSocketFactory;
}

/** One sender connection instance (epoch). With Clerk it renews its token when the server asks. */
export class SenderSocket {
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  readonly counters = { framesSent: 0, framesDroppedCongestion: 0, renewals: 0 };

  constructor(private readonly opts: SenderSocketOptions) {}

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  get isReady(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    let token: string | null = null;
    if (this.opts.auth.mode === 'clerk') {
      token = await this.opts.getToken({ skipCache: true });
      if (!token) throw new Error('no-token');
    }
    // Closed while the token was being fetched (source changed, finish): nothing to open.
    if (this.closed) throw new Error('closed:0:client-close');
    const ws = (this.opts.createWebSocket ?? ((url) => new WebSocket(url)))(this.opts.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        this.sendControl({ type: 'auth', ...(token ? { token } : {}), ...this.opts.target, format: AUDIO_FORMAT });
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let message: SenderServerMessage;
        try {
          message = JSON.parse(event.data) as SenderServerMessage;
        } catch {
          return;
        }
        this.handle(message, resolve, reject);
      };
      ws.onerror = () => {
        if (!this.ready) reject(new Error('socket-error'));
      };
      ws.onclose = (event) => {
        const wasReady = this.ready;
        this.ready = false;
        this.closed = true;
        if (!wasReady) reject(new Error(`closed:${event.code}:${event.reason}`));
        this.opts.events.onClose(event.code, event.reason, SENDER_CLOSE_NO_RETRY.has(event.code));
      };
    });
  }

  private handle(message: SenderServerMessage, resolve: () => void, reject: (e: Error) => void) {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.opts.events.onReady(message.epoch, message.expectedPosition, message.testId);
        resolve();
        break;
      case 'rejected':
        this.opts.events.onRejected(message.reason, message.lastHeardAt);
        reject(new Error(`rejected:${message.reason}`));
        break;
      case 'ack':
        this.opts.debug?.({ kind: 'ack', ...message, at: Date.now() });
        this.opts.events.onAck(message);
        break;
      case 'renew':
        if (this.opts.auth.mode === 'clerk') void this.renew();
        break;
      case 'finishing':
        this.opts.events.onFinishing();
        break;
      case 'state':
        this.opts.events.onState(message);
        break;
      case 'discontinuity':
        this.opts.events.onDiscontinuity(message.detail);
        break;
      case 'preview':
        this.opts.events.onPreview?.(message);
        break;
      case 'test':
        this.opts.debug?.({ kind: 'test', ...message, at: Date.now() });
        this.opts.events.onTest?.(message);
        break;
    }
  }

  private async renew() {
    try {
      const token = await this.opts.getToken({ skipCache: true });
      if (!token || this.closed) return;
      this.counters.renewals++;
      this.sendControl({ type: 'auth', token });
    } catch {
      // Expiry on the server decides; nothing else to do here.
    }
  }

  /** Returns false when the frame was dropped for congestion (the position still advances). */
  sendFrame(seq: number, samplePosition: number, pcm: Int16Array): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.ready) return false;
    if (ws.bufferedAmount > CLIENT_BUFFER_LIMIT) {
      this.counters.framesDroppedCongestion++;
      return false;
    }
    ws.send(encodeFrame(seq, samplePosition, pcm));
    this.counters.framesSent++;
    return true;
  }

  sendControl(message: SenderClientMessage) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  close() {
    this.closed = true;
    this.ws?.close(1000, 'client-close');
  }
}
