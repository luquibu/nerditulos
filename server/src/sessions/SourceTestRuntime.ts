// A source test: one sender link, one provider connection, and the recognized original text echoed
// back as previews. No store, no hub, no reconnection; the room's public view never sees it.
import { randomUUID } from 'node:crypto';
import { SENDER_CLOSE, type AudioFrame, type DetachReason, type EndReason, type SourceLanguage, type SourceTestEndReason } from '@nerditulos/shared';
import type { Logger } from '../log.js';
import type { ProviderConnection, ProviderFactory, SonioxResponse } from '../provider/soniox.js';
import { TokenState } from '../text/tokenState.js';
import type { SenderLink, SenderLostReason, SenderTarget } from './senderTarget.js';
import type { RuntimeConfig } from './SessionRuntime.js';

export const SOURCE_TEST_MAX_MS = 300000;

export interface SourceTestDeps {
  providerFactory: ProviderFactory;
  log: Logger;
  config: RuntimeConfig;
  now?: () => number;
  onEnded?: (runtime: SourceTestRuntime) => void;
}

export type SourceTestState = 'opening' | 'listening' | 'ended';

const CLOSE_REASON: Record<SourceTestEndReason, string> = {
  stopped: 'stopped',
  provider_error: 'provider-error',
  provider_closed: 'provider-closed',
  time_limit: 'time-limit',
  session_started: 'session-started',
};

export class SourceTestRuntime implements SenderTarget {
  /** Public identity of the test: consoles confirm a start over it by this id, never by position or room. */
  readonly id = randomUUID();
  /** Clock value at construction, on the runtime's own clock. */
  readonly startedAt: number;
  state: SourceTestState = 'opening';
  endReason: SourceTestEndReason | null = null;
  private sender: SenderLink | null;
  private connection: ProviderConnection | null = null;
  private readonly tokenState: TokenState;
  private paused = false;
  private lastAudioAt = 0;
  private lastPartial = '';
  private limitTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  readonly counters = {
    framesDroppedNoSender: 0,
    framesDroppedNoProvider: 0,
    framesDroppedBackpressure: 0,
    responsesAfterEnd: 0,
    previews: 0,
    endTokens: 0,
  };
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(
    private readonly deps: SourceTestDeps,
    readonly roomSlug: string,
    readonly sourceLanguage: SourceLanguage,
    link: SenderLink,
    readonly number: number,
  ) {
    this.sender = link;
    this.now = deps.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.log = deps.log.child({ room: roomSlug, test: number });
    this.tokenState = new TokenState({ segmentMaxChars: deps.config.segmentMaxChars, outputs: ['original'] });
  }

  get clientReferenceId(): string {
    return `test/${this.roomSlug}/${this.number}`;
  }

  isSender(link: SenderLink): boolean {
    return this.sender !== null && this.sender.id === link.id;
  }

  /** Opens the provider connection and arms the time cap. Called once, right after construction. */
  open(): void {
    const connection = this.deps.providerFactory({
      model: this.deps.config.sonioxModel,
      sourceLanguage: this.sourceLanguage,
      translationTarget: null,
      clientReferenceId: this.clientReferenceId,
    });
    this.connection = connection;
    connection.on('response', (response) => this.onProviderResponse(response));
    connection.on('close', (code, reason) => this.onProviderClose(code, reason));
    connection.on('error', (error) => this.log.warn('provider error', { error: error.message }));
    this.limitTimer = setTimeout(() => this.end('time_limit'), this.deps.config.sourceTestMaxMs ?? SOURCE_TEST_MAX_MS);
    this.limitTimer.unref?.();
    this.log.info('source test opening', { sourceLanguage: this.sourceLanguage });
    connection
      .open()
      .then(() => {
        if (this.state !== 'opening') return;
        this.state = 'listening';
        this.tokenState.openNewSegment();
        this.startKeepalive();
        this.sender?.send({ type: 'test', state: 'listening' });
        this.log.info('source test listening');
      })
      .catch((error: Error) => {
        this.log.warn('provider open failed', { error: error.message });
        this.end('provider_error');
      });
  }

  // ---- sender target ----

  onFrame(link: SenderLink, frame: AudioFrame, receivedAt: number): void {
    if (!this.isSender(link)) {
      this.counters.framesDroppedNoSender++;
      return;
    }
    const connection = this.connection;
    if (this.state !== 'listening' || !connection) {
      this.counters.framesDroppedNoProvider++;
      return;
    }
    if (connection.bufferedAmount > (this.deps.config.providerBufferLimit ?? 160000)) {
      this.counters.framesDroppedBackpressure++;
      return;
    }
    connection.sendAudio(Buffer.from(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength));
    this.lastAudioAt = receivedAt;
  }

  onPause(link: SenderLink): void {
    if (this.isSender(link)) this.paused = true;
  }

  onResume(link: SenderLink): void {
    if (this.isSender(link)) this.paused = false;
  }

  onEnd(link: SenderLink, _reason: EndReason): void {
    if (this.isSender(link)) this.end('stopped');
  }

  onDetach(link: SenderLink, _reason: DetachReason): void {
    if (this.isSender(link)) this.end('stopped');
  }

  senderLost(link: SenderLink, reason: SenderLostReason): void {
    if (!this.isSender(link)) return;
    this.log.info('source test sender lost', { reason });
    this.end('stopped');
  }

  // ---- provider ----

  private onProviderResponse(response: SonioxResponse) {
    if (this.state === 'ended') {
      this.counters.responsesAfterEnd++;
      return;
    }
    if (response.error_code !== undefined) {
      this.log.error('provider error response', { code: response.error_code });
      this.end('provider_error', response.error_code);
      return;
    }
    const { streams, stats } = this.tokenState.accept(response);
    this.counters.endTokens += stats.endTokens;
    const original = streams.get('original');
    if (original) {
      const final = original.finals.map((part) => part.text).join('');
      const partial = original.partial.text;
      if (final.length > 0 || partial !== this.lastPartial) {
        this.lastPartial = partial;
        this.counters.previews++;
        this.sender?.send({ type: 'preview', final, partial });
      }
    }
    if (response.finished) this.end('provider_closed');
  }

  private onProviderClose(code: number, reason: string) {
    if (this.state === 'ended') return;
    this.log.warn('provider closed', { code, reason: reason.slice(0, 80) });
    this.end('provider_closed', code);
  }

  private startKeepalive() {
    const interval = this.deps.config.keepaliveIntervalMs ?? 10000;
    this.keepaliveTimer = setInterval(() => {
      const connection = this.connection;
      if (this.state !== 'listening' || !connection) return;
      if (this.paused || this.now() - this.lastAudioAt >= interval) connection.keepalive();
    }, interval);
    this.keepaliveTimer.unref?.();
  }

  private stopTimers() {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.limitTimer = null;
    this.keepaliveTimer = null;
  }

  /** The only way out. Idempotent: terminates the provider, tells the sender, closes its link. */
  end(reason: SourceTestEndReason, code?: number): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.endReason = reason;
    this.stopTimers();
    this.connection?.terminate();
    const sender = this.sender;
    this.sender = null;
    if (sender) {
      sender.send({ type: 'test', state: 'ended', reason, ...(code !== undefined ? { code } : {}) });
      sender.close(reason === 'stopped' ? 1000 : SENDER_CLOSE.DETACHED, CLOSE_REASON[reason]);
    }
    this.log.info('source test ended', { reason, code, counters: { ...this.counters } });
    this.deps.onEnded?.(this);
  }

  /** Process shutdown: no messages, nothing to recover. */
  dispose(): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.stopTimers();
    this.connection?.terminate();
    this.sender = null;
  }
}
