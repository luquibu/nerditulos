import { AUDIO_FORMAT, encodeFrame, SENDER_CLOSE_NO_RETRY, type DiscontinuityDetail, type SenderClientMessage, type SenderServerMessage } from '@nerditulos/shared';

export interface SenderSocketEvents {
  onReady(epoch: number, expectedPosition: number): void;
  onRejected(reason: string, lastHeardAt?: number): void;
  onAck(ack: { seq: number; samplePosition: number; receivedAt: number }): void;
  onFinishing(): void;
  onState(state: Extract<SenderServerMessage, { type: 'state' }>): void;
  onDiscontinuity(detail: DiscontinuityDetail): void;
  onClose(code: number, reason: string, noRetry: boolean): void;
}

// Client congestion limit: chunks captured while more than 64000 bytes (2 s) are queued are dropped.
export const CLIENT_BUFFER_LIMIT = 64000;

export type TokenGetter = (options?: { skipCache?: boolean }) => Promise<string | null>;

/** One sender connection instance (epoch). Renews its token when the server asks. */
export class SenderSocket {
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  readonly counters = { framesSent: 0, framesDroppedCongestion: 0, renewals: 0 };

  constructor(
    private readonly opts: { url: string; sessionId: string; getToken: TokenGetter; events: SenderSocketEvents; debug?: (line: Record<string, unknown>) => void },
  ) {}

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  get isReady(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const token = await this.opts.getToken({ skipCache: true });
    if (!token) throw new Error('no-token');
    const ws = new WebSocket(this.opts.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        this.sendControl({ type: 'auth', token, sessionId: this.opts.sessionId, format: AUDIO_FORMAT });
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
        this.opts.events.onReady(message.epoch, message.expectedPosition);
        resolve();
        break;
      case 'rejected':
        this.opts.events.onRejected(message.reason, message.lastHeardAt);
        reject(new Error(`rejected:${message.reason}`));
        break;
      case 'ack':
        this.opts.debug?.({ kind: 'ack', ...message, at: Date.now(), perfNow: performance.now() });
        this.opts.events.onAck(message);
        break;
      case 'renew':
        void this.renew();
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
