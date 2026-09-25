import { SENDER_CLOSE, type AudioFrame, type Completeness, type DetachReason, type DiscontinuityDetail, type EndReason, type InterruptionCause, type OutputType, type SessionState, type StorageStatus } from '@nerditulos/shared';
import type { Logger } from '../log.js';
import { createHubStream, type HubSession, type StreamHub } from '../public/streamHub.js';
import type { ProviderConnection, ProviderFactory, SonioxResponse } from '../provider/soniox.js';
import { TokenState, type FinalPart } from '../text/tokenState.js';
import { summaryOf, translationTargetOf } from './recovery.js';
import type { SenderLink, SenderLostReason, SenderTarget } from './senderTarget.js';
import type { FinalChunkInsert, RoomRow, SessionRow, SessionStore, StreamRow, StreamSpec } from './SessionStore.js';

export type { SenderLink, SenderLostReason } from './senderTarget.js';

export interface RuntimeConfig {
  drainTimeoutMs: number;
  segmentMaxChars: number;
  sonioxModel: string;
  publicWindowSegments: number;
  /** Backoff between provider reconnection attempts. */
  reconnectBackoffMs?: number[];
  /** Continuous provider failure after which the session is interrupted. */
  providerFailureWindowMs?: number;
  retryBudgetMs?: number;
  retryIntervalMs?: number;
  chainMaxItems?: number;
  chainMaxAgeMs?: number;
  keepaliveIntervalMs?: number;
  /** Provider send buffer above which server drops start (5 s of audio). */
  providerBufferLimit?: number;
  statementTimeoutMs?: number;
  /** Wall-clock cap of a source test (default 5 minutes): each one holds a provider connection. */
  sourceTestMaxMs?: number;
}

export interface RuntimeDeps {
  store: SessionStore;
  hub: StreamHub;
  providerFactory: ProviderFactory;
  log: Logger;
  config: RuntimeConfig;
  now?: () => number;
  onFinished?: (runtime: SessionRuntime) => void;
}

type GenerationState = 'opening' | 'active' | 'draining' | 'closed';

interface Generation {
  number: number;
  state: GenerationState;
  connection: ProviderConnection | null;
  firstPosition: number | null;
  /** Source position after the last sample forwarded to this generation. */
  frontier: number | null;
  deliveredSamples: number;
  /** Source samples dropped between `firstPosition` and `frontier` (client gaps and server drops). */
  gapSamples: number;
  lastFinalAudioProcMs: number;
  finished: boolean;
  epoch: number;
}

interface StreamRuntime {
  row: StreamRow;
  output: OutputType;
  lang: string;
  nextSeq: number;
  lastPublishedSeq: number;
  lastPersistedSeq: number;
  frozenSeq: number | null;
}

interface ChainItem {
  kind: 'response' | 'finalize' | 'live' | 'attach' | 'other';
  enqueuedAt: number;
  started: boolean;
  dropped: boolean;
  run: () => Promise<void>;
}

const DEFAULT_BACKOFF = [1000, 2000, 5000, 10000];

export class SessionRuntime implements SenderTarget {
  readonly id: string;
  state: SessionState;
  cause: InterruptionCause | null;
  completeness: Completeness | null;
  storage: StorageStatus = 'ok';
  private readonly streams = new Map<OutputType, StreamRuntime>();
  private readonly tokenState: TokenState;
  private generation: Generation | null = null;
  private generationCounter: number;
  private sender: SenderLink | null = null;
  private epochCounter = 0;
  private expectedPosition = 0;
  private lastHeardAt = 0;
  private paused = false;
  private lastAudioAt = 0;
  private audioAccepted = false;
  private eventSeq: number;
  private chainTail: Promise<void> = Promise.resolve();
  private readonly chainItems: ChainItem[] = [];
  private fenced = false;
  private finishingAt: number | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private providerFailureSince: number | null = null;
  private reconnectAttempt = 0;
  private droppedWhileNoGeneration = 0;
  private visible: boolean;
  private persistFailures = 0;
  private deferredPersistFailure: Record<string, unknown> | null = null;
  private inFlightInsert: { seqs: Record<string, number[]> } | null = null;
  private drainTimeoutDetail: Record<string, unknown> | null = null;
  private hubSession: HubSession | null;
  readonly counters = {
    framesDroppedNoSender: 0,
    framesDroppedNoGeneration: 0,
    framesDroppedAfterEnd: 0,
    framesDroppedBackpressure: 0,
    framesDroppedReconnecting: 0,
    responsesFromClosedGeneration: 0,
    responsesDroppedByFence: 0,
    responsesDiscardedStorage: 0,
    partialClearedByMissingStream: 0,
    noneTokens: 0,
    endTokens: 0,
    persistFailures: 0,
  };
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(
    private readonly deps: RuntimeDeps,
    readonly session: SessionRow,
    readonly room: RoomRow,
    streamRows: StreamRow[],
    initial: { counters: Map<number, { maxSeq: number; maxSegmentSeq: number }>; eventSeq: number; visible: boolean; hubSession: HubSession | null },
  ) {
    this.id = session.id;
    this.state = session.state;
    this.cause = session.cause;
    this.completeness = session.completeness;
    this.generationCounter = session.providerGeneration;
    this.eventSeq = initial.eventSeq;
    this.visible = initial.visible;
    this.hubSession = initial.hubSession;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log.child({ sessionId: session.id, room: room.slug });
    const outputs: OutputType[] = [];
    const initialSegments: Partial<Record<OutputType, number>> = {};
    for (const row of streamRows) {
      const c = initial.counters.get(row.id) ?? { maxSeq: 0, maxSegmentSeq: 0 };
      this.streams.set(row.outputType, {
        row,
        output: row.outputType,
        lang: row.language,
        nextSeq: c.maxSeq + 1,
        lastPublishedSeq: c.maxSeq,
        lastPersistedSeq: c.maxSeq,
        frozenSeq: null,
      });
      outputs.push(row.outputType);
      initialSegments[row.outputType] = c.maxSegmentSeq;
    }
    this.tokenState = new TokenState({ segmentMaxChars: deps.config.segmentMaxChars, outputs, initialSegmentSeq: initialSegments });
  }

  // ---- public views ----

  get roomSlug(): string {
    return this.room.slug;
  }

  get generationNumber(): number {
    return this.generationCounter;
  }

  get generationState(): GenerationState | null {
    return this.generation?.state ?? null;
  }

  get currentEpoch(): number {
    return this.epochCounter;
  }

  get senderActive(): boolean {
    return this.sender !== null;
  }

  isSender(link: SenderLink): boolean {
    return this.sender !== null && this.sender.id === link.id;
  }

  summaryState() {
    return { state: this.state, cause: this.cause, completeness: this.completeness, storage: this.storage };
  }

  /** The session's persisted streams, as copies: the rows themselves carry a `publishedSeq` frozen at construction. */
  offeredStreams(): StreamSpec[] {
    return [...this.streams.values()].map((s) => ({ outputType: s.output, language: s.lang }));
  }

  streamInfo(): Array<{ output: OutputType; lang: string; nextSeq: number; lastPublishedSeq: number; lastPersistedSeq: number; frozenSeq: number | null }> {
    return [...this.streams.values()].map((s) => ({
      output: s.output,
      lang: s.lang,
      nextSeq: s.nextSeq,
      lastPublishedSeq: s.lastPublishedSeq,
      lastPersistedSeq: s.lastPersistedSeq,
      frozenSeq: s.frozenSeq,
    }));
  }

  /** Resolves when every chain item enqueued so far has run (tests and shutdown). */
  idle(): Promise<void> {
    return this.chainTail;
  }

  // ---- sender attachment (compare-and-set) ----

  attachSender(link: SenderLink): { ok: true; epoch: number; expectedPosition: number } | { ok: false; code: number; reason: string; lastHeardAt?: number } {
    if (this.state === 'finished' || this.state === 'finishing' || this.state === 'prepared') {
      return { ok: false, code: SENDER_CLOSE.NOT_JOINABLE, reason: 'session-not-joinable' };
    }
    if (this.sender) return { ok: false, code: SENDER_CLOSE.SENDER_ACTIVE, reason: 'sender-active', lastHeardAt: this.lastHeardAt };
    if (this.generation && this.generation.state !== 'closed') {
      return { ok: false, code: SENDER_CLOSE.SENDER_ACTIVE, reason: 'generation-draining' };
    }
    if (this.state !== 'starting' && this.state !== 'interrupted') return { ok: false, code: SENDER_CLOSE.NOT_JOINABLE, reason: 'session-not-joinable' };
    if (this.storage === 'failing') return { ok: false, code: SENDER_CLOSE.SENDER_ACTIVE, reason: 'storage-unavailable' };
    this.sender = link;
    this.epochCounter += 1;
    this.expectedPosition = 0;
    this.paused = false;
    this.audioAccepted = true;
    this.lastHeardAt = this.now();
    const epoch = this.epochCounter;
    const resumed = this.state === 'interrupted';
    this.log.info('sender attached', { epoch, resumed });
    if (resumed) {
      this.recordDiscontinuity({ epoch, kind: 'new_epoch', extentSamples: 'unknown', generation: this.generationCounter + 1 });
    }
    this.openGeneration(epoch);
    return { ok: true, epoch, expectedPosition: 0 };
  }

  private detachSenderLink(code: number, reason: string) {
    const link = this.sender;
    this.sender = null;
    this.audioAccepted = false;
    if (link) link.close(code, reason);
  }

  // ---- audio frames ----

  onFrame(link: SenderLink, frame: AudioFrame, receivedAt: number): void {
    if (!this.isSender(link)) {
      this.counters.framesDroppedNoSender++;
      return;
    }
    this.lastHeardAt = receivedAt;
    // An attached sender in `interrupted` is resuming: its frames are classified (and dropped until the new generation is active).
    if (!this.audioAccepted || (this.state !== 'live' && this.state !== 'starting' && this.state !== 'interrupted')) {
      this.counters.framesDroppedAfterEnd++;
      return;
    }
    const n = frame.pcm.length;
    const epoch = this.epochCounter;
    if (frame.samplePosition > this.expectedPosition) {
      const extent = frame.samplePosition - this.expectedPosition;
      this.recordDiscontinuity({ epoch, kind: 'client_gap', fromPosition: this.expectedPosition, toPosition: frame.samplePosition, extentSamples: extent, generation: this.generation?.number });
      // Only a gap after the generation's first sample lies inside it; earlier gaps are reported by this event alone.
      if (this.generation && this.generation.state === 'active' && this.generation.firstPosition !== null) this.generation.gapSamples += extent;
    } else if (frame.samplePosition < this.expectedPosition) {
      // Positions restarted without a new socket: treat as a new epoch of unknown relation.
      this.epochCounter += 1;
      this.recordDiscontinuity({ epoch: this.epochCounter, kind: 'new_epoch', fromPosition: this.expectedPosition, toPosition: frame.samplePosition, extentSamples: 'unknown', generation: this.generation?.number });
    }
    this.expectedPosition = frame.samplePosition + n;
    const gen = this.generation;
    if (!gen || gen.state !== 'active' || !gen.connection) {
      this.counters.framesDroppedNoGeneration++;
      this.counters.framesDroppedReconnecting += gen && gen.state === 'closed' ? 1 : 0;
      this.droppedWhileNoGeneration += n;
      return;
    }
    const limit = this.deps.config.providerBufferLimit ?? 160000;
    if (gen.connection.bufferedAmount > limit) {
      this.counters.framesDroppedBackpressure++;
      gen.gapSamples += n;
      this.recordDiscontinuity({ epoch, kind: 'server_drop', fromPosition: frame.samplePosition, toPosition: frame.samplePosition + n, extentSamples: n, generation: gen.number });
      return;
    }
    if (gen.firstPosition === null) gen.firstPosition = frame.samplePosition;
    gen.connection.sendAudio(Buffer.from(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength));
    gen.deliveredSamples += n;
    gen.frontier = frame.samplePosition + n;
    this.lastAudioAt = receivedAt;
  }

  onPause(link: SenderLink): void {
    if (!this.isSender(link)) return;
    this.paused = true;
    this.log.info('sender paused', { epoch: this.epochCounter, position: this.expectedPosition });
  }

  onResume(link: SenderLink): void {
    if (!this.isSender(link)) return;
    this.paused = false;
    this.log.info('sender resumed', { epoch: this.epochCounter, position: this.expectedPosition });
  }

  onEnd(link: SenderLink, reason: EndReason): void {
    if (!this.isSender(link)) return;
    this.log.info('sender end', { reason, epoch: this.epochCounter });
    void this.finish(reason);
  }

  onDetach(link: SenderLink, reason: DetachReason): void {
    if (!this.isSender(link)) return;
    this.senderLost(link, reason);
  }

  senderLost(link: SenderLink, reason: SenderLostReason): void {
    if (!this.isSender(link)) return;
    this.log.warn('sender lost', { reason, epoch: this.epochCounter, state: this.state });
    this.audioAccepted = false;
    if (this.state === 'finishing' || this.state === 'finished') {
      this.sender = null;
      link.close(SENDER_CLOSE.NOT_JOINABLE, 'finished');
      return;
    }
    if (this.state === 'live' || this.state === 'starting') {
      // Transition while the link is still the sender, so its socket learns the state before the close.
      this.transition('interrupted', 'sender_lost');
      this.recordEvent('sender_lost', { reason, epoch: this.epochCounter, position: this.expectedPosition });
    }
    this.sender = null;
    // Includes a generation opened by a resume attempt that never went live.
    this.drainGeneration();
    link.close(SENDER_CLOSE.DETACHED, 'detached');
  }

  // ---- provider generations ----

  private openGeneration(epoch: number) {
    const number = this.generationCounter + 1;
    this.generationCounter = number;
    const gen: Generation = { number, state: 'opening', connection: null, firstPosition: null, frontier: null, deliveredSamples: 0, gapSamples: 0, lastFinalAudioProcMs: 0, finished: false, epoch };
    this.generation = gen;
    // Every provider connection of the session (start, reconnection, resume) derives its target from the same rows.
    const translationTarget = translationTargetOf(this.offeredStreams(), this.log);
    this.log.info('provider generation opening', { generation: number, translationTarget });
    const connection = this.deps.providerFactory({
      model: this.deps.config.sonioxModel,
      sourceLanguage: this.session.sourceLanguage,
      translationTarget,
      clientReferenceId: `${this.id}/${number}`,
    });
    gen.connection = connection;
    connection.on('response', (response) => this.onProviderResponse(gen, response));
    connection.on('close', (code, reason) => this.onProviderClose(gen, code, reason));
    connection.on('error', (error) => this.log.warn('provider error', { generation: number, error: error.message }));
    void this.deps.store.setProviderGeneration(this.id, number).catch((error: Error) => this.log.warn('generation write failed', { error: error.message }));
    connection
      .open()
      .then(() => {
        if (this.generation !== gen || gen.state !== 'opening') return;
        gen.state = 'active';
        this.providerFailureSince = null;
        this.reconnectAttempt = 0;
        // Through the chain, so the new segment opens after every response of the previous generation still queued.
        this.enqueue('other', async () => this.tokenState.openNewSegment());
        this.startKeepalive();
        // Frames that arrived while no generation was active (reconnecting, or this one opening) are known drops.
        const dropped = this.droppedWhileNoGeneration;
        this.droppedWhileNoGeneration = 0;
        const dead = this.lastClosedGeneration;
        this.lastClosedGeneration = null;
        if (dropped > 0 || dead) {
          const detail: DiscontinuityDetail = { epoch, kind: 'provider_unprocessed', extentSamples: dropped, droppedSamples: dropped, generation: number };
          if (dead) {
            // The dead generation's tail that the provider never finalized.
            const unprocessed = Math.max(0, dead.deliveredSamples - dead.lastFinalAudioProcMs * 16);
            const frontier = dead.frontier ?? dead.firstPosition ?? 0;
            detail.unprocessedSamples = unprocessed;
            detail.sourceRange = dead.gapSamples === 0
              ? { exact: true, start: frontier - unprocessed, end: frontier }
              : { exact: false, start: frontier - unprocessed - dead.gapSamples, startMax: frontier - unprocessed, end: frontier };
          }
          this.recordDiscontinuity(detail);
        }
        if (this.state === 'starting' || this.state === 'interrupted') this.enqueue('live', () => this.goLive(gen));
        if (this.state === 'finishing') {
          // Finish arrived while opening: end immediately so the generation drains.
          gen.state = 'draining';
          connection.endAudio();
        }
      })
      .catch((error: Error) => {
        this.log.warn('provider open failed', { generation: number, error: error.message });
        if (this.generation === gen && gen.state === 'opening') {
          gen.state = 'closed';
          this.handleProviderFailure(gen, error.message);
        }
      });
  }

  private lastClosedGeneration: Generation | null = null;

  private async goLive(gen: Generation): Promise<void> {
    const sender = this.sender;
    const before = this.state;
    if (before !== 'starting' && before !== 'interrupted') return;
    if (!sender || this.generation !== gen || gen.state !== 'active') return;
    const resumed = before === 'interrupted';
    const makeVisible = !this.visible;
    let applied: boolean;
    try {
      applied = await this.deps.store.markLive(this.id, this.room.id, makeVisible);
    } catch (error) {
      this.log.error('live write failed', { error: (error as Error).message });
      this.storageFailed('live_write');
      return;
    }
    if (this.state !== before || this.sender !== sender || this.generation !== gen || gen.state !== 'active') {
      // Superseded while the write ran (sender lost, finish, or provider failure): memory wins.
      this.log.warn('live transition superseded', { state: this.state, applied });
      if (applied && this.state === 'interrupted' && this.cause) {
        const cause = this.cause;
        void this.withRetry('state-write', () => this.deps.store.markInterrupted(this.id, cause)).catch((error: Error) =>
          this.log.error('state write failed', { state: 'interrupted', error: error.message }),
        );
      }
      return;
    }
    if (!applied) this.log.warn('live write matched no row', { state: before });
    this.state = 'live';
    this.cause = null;
    if (makeVisible) {
      this.visible = true;
      const hubStreams = new Map(
        [...this.streams.values()].map((s) => [s.lang, createHubStream(s.output, s.lang)] as const),
      );
      this.hubSession = { summary: this.summary(), storage: this.storage, streams: hubStreams };
      this.deps.hub.switchSession(this.room.slug, this.hubSession);
    } else {
      this.publishState();
    }
    this.sender?.send({ type: 'state', ...this.summaryState() });
    this.log.info(resumed ? 'session resumed' : 'session live', { generation: this.generationCounter });
  }

  private onProviderResponse(gen: Generation, response: SonioxResponse) {
    if (gen.state === 'closed') {
      this.counters.responsesFromClosedGeneration++;
      return;
    }
    if (response.error_code !== undefined) {
      this.log.error('provider error response', { generation: gen.number, code: response.error_code });
      this.recordEvent('provider_error', { generation: gen.number, code: response.error_code });
      const authError = response.error_code === 401 || response.error_code === 403;
      gen.state = 'closed';
      gen.connection?.terminate();
      if (authError && (this.state === 'live' || this.state === 'starting' || (this.state === 'interrupted' && this.sender))) {
        this.transition('interrupted', 'provider_error');
        this.detachSenderLink(SENDER_CLOSE.DETACHED, 'provider-error');
      } else {
        this.handleProviderFailure(gen, `error ${response.error_code}`);
      }
      return;
    }
    if (typeof response.final_audio_proc_ms === 'number') gen.lastFinalAudioProcMs = response.final_audio_proc_ms;
    if (response.finished) gen.finished = true;
    const receivedAt = this.now();
    this.enqueue('response', () => this.processResponse(gen, response, receivedAt));
    if (response.finished) {
      gen.state = 'closed';
      this.onGenerationFinished(gen);
    }
  }

  private onProviderClose(gen: Generation, code: number, reason: string) {
    if (gen.state === 'closed') return;
    const previous = gen.state;
    gen.state = 'closed';
    this.log.warn('provider closed', { generation: gen.number, code, reason: reason.slice(0, 80), previous });
    if (previous === 'draining') {
      this.onGenerationFinished(gen);
      return;
    }
    if (this.state === 'live' || this.state === 'starting') {
      this.lastClosedGeneration = gen;
      this.handleProviderFailure(gen, `close ${code}`);
    } else if (this.state === 'finishing') {
      this.onGenerationFinished(gen);
    } else if (this.state === 'interrupted') {
      // A resume attempt whose provider went away: release the sender instead of holding it.
      this.handleProviderFailure(gen, `close ${code}`);
    }
  }

  /** Generation reached `finished` or closed after end of audio. */
  private onGenerationFinished(gen: Generation) {
    this.log.info('provider generation finished', { generation: gen.number, finished: gen.finished });
    this.stopKeepalive();
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.state === 'finishing') this.enqueue('finalize', () => this.finalize());
    else if (this.state === 'live' && this.sender) {
      // Provider ended on its own while live (e.g. stream cap): reconnect as an unexpected close.
      this.lastClosedGeneration = gen;
      this.handleProviderFailure(gen, 'finished-while-live');
    }
  }

  private handleProviderFailure(gen: Generation, why: string) {
    if (this.generation !== gen) return;
    if (this.state === 'interrupted') {
      // Only a resume attempt has a sender here; it must not stay attached to a session with no provider.
      if (!this.sender) return;
      this.log.warn('provider failed during resume; releasing the sender', { why, generation: gen.number });
      this.recordEvent('provider_error', { reason: 'resume_failed', why, generation: gen.number });
      this.transition('interrupted', 'provider_unavailable');
      this.detachSenderLink(SENDER_CLOSE.DETACHED, 'provider-unavailable');
      return;
    }
    if (this.state !== 'live' && this.state !== 'starting') return;
    const now = this.now();
    if (this.providerFailureSince === null) this.providerFailureSince = now;
    const windowMs = this.deps.config.providerFailureWindowMs ?? 60000;
    if (now - this.providerFailureSince >= windowMs) {
      this.log.error('provider unavailable', { since: this.providerFailureSince, why });
      this.transition('interrupted', 'provider_unavailable');
      this.recordEvent('provider_error', { reason: 'unavailable', windowMs, generation: gen.number });
      this.detachSenderLink(SENDER_CLOSE.DETACHED, 'provider-unavailable');
      return;
    }
    const backoff = this.deps.config.reconnectBackoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(this.reconnectAttempt, backoff.length - 1)] as number;
    this.reconnectAttempt += 1;
    this.log.warn('provider reconnect scheduled', { delayMs: delay, attempt: this.reconnectAttempt, why });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.generation !== gen) return;
      if (this.state !== 'live' && this.state !== 'starting') return;
      if (!this.sender) return;
      const elapsed = this.now() - (this.providerFailureSince ?? this.now());
      if (elapsed >= windowMs) {
        this.transition('interrupted', 'provider_unavailable');
        this.recordEvent('provider_error', { reason: 'unavailable', windowMs, generation: gen.number });
        this.detachSenderLink(SENDER_CLOSE.DETACHED, 'provider-unavailable');
        return;
      }
      this.openGeneration(this.epochCounter);
    }, delay);
  }

  /** Sends the end frame and lets the open generation drain, bounded by the drain timeout. */
  private drainGeneration() {
    const gen = this.generation;
    if (!gen || gen.state === 'closed') return;
    if (gen.state === 'opening') {
      // Nothing was delivered: close it outright.
      gen.state = 'closed';
      gen.connection?.terminate();
      return;
    }
    gen.state = 'draining';
    gen.connection?.endAudio();
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (gen.state === 'draining') {
        this.log.warn('drain timeout; terminating generation', { generation: gen.number });
        gen.state = 'closed';
        gen.connection?.terminate();
      }
    }, this.deps.config.drainTimeoutMs);
  }

  private startKeepalive() {
    this.stopKeepalive();
    const interval = this.deps.config.keepaliveIntervalMs ?? 10000;
    this.keepaliveTimer = setInterval(() => {
      const gen = this.generation;
      if (!gen || gen.state !== 'active' || !gen.connection) return;
      if (this.paused || this.now() - this.lastAudioAt >= interval) gen.connection.keepalive();
    }, interval);
    this.keepaliveTimer.unref?.();
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  // ---- finish ----

  async finish(reason: EndReason | 'http' = 'http'): Promise<{ state: SessionState; completeness: Completeness | null }> {
    if (this.state === 'finished' || this.state === 'finishing') return { state: this.state, completeness: this.completeness };
    if (this.state === 'starting') {
      this.state = 'finished';
      this.completeness = null;
      this.tokenState.dropPendingFlags();
      const gen = this.generation;
      if (gen && gen.state !== 'closed') {
        gen.state = 'closed';
        gen.connection?.terminate();
      }
      this.stopTimers();
      this.detachSenderLink(SENDER_CLOSE.NOT_JOINABLE, 'finished');
      const write = () => this.deps.store.markFinished(this.id, null, []);
      try {
        await this.withRetry('finish-starting', write);
        this.deps.onFinished?.(this);
      } catch (error) {
        // Finished in memory: the room stays occupied (the row is still `starting`) until the write lands.
        this.log.error('finish write failed from starting; retrying until it lands', { error: (error as Error).message });
        this.storage = 'failing';
        void this.withRetry('finish-starting', write, Infinity)
          .then(() => {
            this.storage = 'ok';
            this.deps.onFinished?.(this);
          })
          .catch(() => undefined);
      }
      return { state: this.state, completeness: this.completeness };
    }
    // live | interrupted
    this.state = 'finishing';
    this.cause = null;
    this.finishingAt = this.now();
    this.audioAccepted = false;
    this.log.info('finishing', { reason });
    this.publishState();
    this.sender?.send({ type: 'finishing' });
    this.deadlineTimer = setTimeout(() => this.onDeadline(), this.deps.config.drainTimeoutMs);
    const gen = this.generation;
    if (gen && (gen.state === 'active' || gen.state === 'draining')) {
      if (gen.state === 'active') {
        gen.state = 'draining';
        gen.connection?.endAudio();
      }
    } else if (!gen || gen.state === 'closed') {
      this.enqueue('finalize', () => this.finalize());
    }
    try {
      await this.withRetry('finishing-write', () => this.deps.store.markFinishing(this.id));
    } catch (error) {
      this.log.error('finishing write failed', { error: (error as Error).message });
      this.storage = 'failing';
      this.publishState();
    }
    return { state: this.state, completeness: this.completeness };
  }

  /** Chain step: every earlier response is committed and published, so the finish transaction can run. */
  private async finalize(): Promise<void> {
    if (this.state !== 'finishing' || this.fenced) return;
    // The drain is over once this step runs; the deadline must not race the finish write.
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    this.tokenState.dropPendingFlags();
    const completeness: Completeness = this.persistFailures > 0 ? 'incomplete' : 'complete';
    const publishedSeqs = [...this.streams.values()].map((s) => ({ streamId: s.row.id, publishedSeq: s.lastPublishedSeq }));
    const write = () => this.deps.store.markFinished(this.id, completeness, publishedSeqs);
    const written = () => {
      this.storage = 'ok';
      void this.flushEvents();
    };
    try {
      await this.withRetry('finish-write', write);
      written();
    } catch (error) {
      this.log.error('finish write failed; finishing in memory and retrying', { error: (error as Error).message });
      this.storage = 'failing';
      void this.withRetry('finish-write', write, Infinity).then(written).catch(() => undefined);
    }
    this.completeFinish(completeness);
  }

  private completeFinish(completeness: Completeness) {
    this.state = 'finished';
    this.cause = null;
    this.completeness = completeness;
    this.stopTimers();
    this.publishState();
    this.detachSenderLink(SENDER_CLOSE.NOT_JOINABLE, 'finished');
    this.log.info('finished', { completeness, persistFailures: this.persistFailures, counters: { ...this.counters } });
    this.deps.onFinished?.(this);
  }

  /** Wall-clock deadline outside the chain: freeze the window and fence pending items. */
  private onDeadline() {
    this.deadlineTimer = null;
    if (this.state !== 'finishing') return;
    const gen = this.generation;
    if (gen && gen.state !== 'closed') {
      gen.state = 'closed';
      gen.connection?.terminate();
    }
    let droppedItems = 0;
    for (const item of this.chainItems) {
      if (!item.started && !item.dropped) {
        item.dropped = true;
        droppedItems++;
      }
    }
    this.counters.responsesDroppedByFence += droppedItems;
    this.fenced = true;
    for (const s of this.streams.values()) s.frozenSeq = s.lastPublishedSeq;
    this.drainTimeoutDetail = { droppedItems, inFlight: this.inFlightInsert !== null, frozenSeq: this.frozenSeqs() };
    this.log.warn('drain deadline reached', this.drainTimeoutDetail);
    this.completeFinish('incomplete');
    const publishedSeqs = [...this.streams.values()].map((s) => ({ streamId: s.row.id, publishedSeq: s.frozenSeq }));
    void this.withRetry('finish-write-deadline', () => this.deps.store.markFinished(this.id, 'incomplete', publishedSeqs), Infinity).catch(() => undefined);
    if (!this.inFlightInsert) this.writeDrainTimeoutEvent({});
  }

  private frozenSeqs(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const s of this.streams.values()) out[`${s.output}:${s.lang}`] = s.frozenSeq;
    return out;
  }

  private writeDrainTimeoutEvent(persistedUnpublished: Record<string, number[]>) {
    const detail = { ...(this.drainTimeoutDetail ?? {}), persistedUnpublished, drainTimeoutMs: this.deps.config.drainTimeoutMs, ambiguousWindowMs: this.deps.config.statementTimeoutMs ?? 5000 };
    this.recordEvent('drain_timeout', detail);
  }

  // ---- chain ----

  private enqueue(kind: ChainItem['kind'], run: () => Promise<void>) {
    const item: ChainItem = { kind, enqueuedAt: this.now(), started: false, dropped: false, run };
    if (kind === 'response') {
      if (this.storage === 'failing' && this.state === 'interrupted') {
        this.counters.responsesDiscardedStorage++;
        return;
      }
      const pending = this.chainItems.filter((i) => !i.started && !i.dropped);
      const maxItems = this.deps.config.chainMaxItems ?? 100;
      const maxAge = this.deps.config.chainMaxAgeMs ?? 20000;
      const oldest = pending[0];
      if (pending.length >= maxItems || (oldest && this.now() - oldest.enqueuedAt > maxAge)) {
        this.storageFailed('queue_bound');
        this.counters.responsesDiscardedStorage++;
        return;
      }
    }
    this.chainItems.push(item);
    this.chainTail = this.chainTail
      .then(async () => {
        if (item.dropped) return;
        item.started = true;
        try {
          await item.run();
        } catch (error) {
          this.log.error('chain item failed', { kind, error: (error as Error).message });
        }
      })
      .finally(() => {
        const index = this.chainItems.indexOf(item);
        if (index >= 0) this.chainItems.splice(index, 1);
      });
  }

  private async processResponse(gen: Generation, response: SonioxResponse, receivedAt: number): Promise<void> {
    if (this.fenced) {
      this.counters.responsesDroppedByFence++;
      return;
    }
    const { streams, stats } = this.tokenState.accept(response);
    this.counters.noneTokens += stats.noneTokens;
    this.counters.endTokens += stats.endTokens;
    // Allocate seqs once; they survive retries.
    const rows: Array<FinalChunkInsert & { stream: StreamRuntime; part: FinalPart }> = [];
    for (const [output, result] of streams) {
      const stream = this.streams.get(output);
      if (!stream) continue;
      if (result.partialCleared) this.counters.partialClearedByMissingStream++;
      for (const part of result.finals) {
        rows.push({ streamId: stream.row.id, seq: stream.nextSeq++, segmentSeq: part.segmentSeq, text: part.text, tokens: part.tokens, providerGeneration: gen.number, receivedAt: new Date(receivedAt), stream, part });
      }
    }
    let persisted: Set<string> = new Set();
    const failed = new Set<string>();
    if (rows.length > 0) {
      const inserts: FinalChunkInsert[] = rows.map(({ streamId, seq, segmentSeq, text, tokens, providerGeneration, receivedAt: r }) => ({ streamId, seq, segmentSeq, text, tokens, providerGeneration, receivedAt: r }));
      const seqsByStream: Record<string, number[]> = {};
      for (const r of rows) (seqsByStream[`${r.stream.output}:${r.stream.lang}`] ??= []).push(r.seq);
      this.inFlightInsert = { seqs: seqsByStream };
      let returned: Array<{ streamId: number; seq: number }>;
      try {
        returned = await this.withRetry('insert', () => this.deps.store.insertFinals(inserts));
      } catch (error) {
        this.inFlightInsert = null;
        this.log.error('insert failed after retries', { error: (error as Error).message, rows: rows.length });
        this.storageFailed('insert');
        return;
      }
      this.inFlightInsert = null;
      persisted = new Set(returned.map((r) => `${r.streamId}:${r.seq}`));
      for (const r of rows) {
        const key = `${r.streamId}:${r.seq}`;
        if (persisted.has(key)) continue;
        let existing: { text: string; providerGeneration: number } | null = null;
        try {
          existing = await this.withRetry('readback', () => this.deps.store.readBack(r.streamId, r.seq));
        } catch {
          existing = null;
        }
        if (existing && existing.text === r.text && existing.providerGeneration === r.providerGeneration) persisted.add(key);
        else {
          failed.add(key);
          this.persistFailures++;
          this.counters.persistFailures++;
          this.recordEvent('persist_failure', { stream: `${r.stream.output}:${r.stream.lang}`, seq: r.seq, generation: r.providerGeneration, chars: r.text.length, reason: existing ? 'mismatch' : 'missing' });
        }
      }
      if (this.fenced) {
        // Deadline fired while this INSERT was executing: persisted, never published.
        const excluded: Record<string, number[]> = {};
        for (const r of rows) if (persisted.has(`${r.streamId}:${r.seq}`)) (excluded[`${r.stream.output}:${r.stream.lang}`] ??= []).push(r.seq);
        this.writeDrainTimeoutEvent(excluded);
        return;
      }
      if (this.storage === 'failing') {
        this.storage = 'ok';
        this.publishState();
      }
    }
    // Publication never precedes commit: ring append and fan-out only for persisted rows.
    const publishedAt = this.now();
    for (const r of rows) {
      const key = `${r.streamId}:${r.seq}`;
      r.stream.lastPersistedSeq = Math.max(r.stream.lastPersistedSeq, r.seq);
      if (!persisted.has(key)) continue;
      r.stream.lastPublishedSeq = Math.max(r.stream.lastPublishedSeq, r.seq);
      if (this.visible) this.deps.hub.publishFinal(this.room.slug, this.id, r.stream.lang, { seq: r.seq, segmentSeq: r.segmentSeq, text: r.text, receivedAt, publishedAt });
    }
    for (const [output, result] of streams) {
      const stream = this.streams.get(output);
      if (!stream || !this.visible) continue;
      this.deps.hub.publishPartial(this.room.slug, this.id, stream.lang, { segmentSeq: result.partial.segmentSeq, text: result.partial.text, receivedAt, publishedAt });
    }
    await this.flushEvents();
  }

  // ---- storage failure policy ----

  private storageFailed(where: string) {
    this.storage = 'failing';
    // An attached sender in `interrupted` is a resume attempt: it is released like a live one.
    if (this.state === 'live' || this.state === 'starting' || this.state === 'finishing' || (this.state === 'interrupted' && this.sender)) {
      this.log.error('storage unavailable', { where, state: this.state });
      const gen = this.generation;
      if (gen && gen.state !== 'closed') {
        gen.state = 'closed';
        gen.connection?.terminate();
      }
      let discarded = 0;
      for (const item of this.chainItems) if (item.kind === 'response' && !item.started && !item.dropped) {
        item.dropped = true;
        discarded++;
      }
      this.counters.responsesDiscardedStorage += discarded;
      this.audioAccepted = false;
      const lastPersisted: Record<string, number> = {};
      for (const s of this.streams.values()) lastPersisted[`${s.output}:${s.lang}`] = s.lastPersistedSeq;
      if (this.state === 'finishing') {
        // A finishing session is not interrupted: its lost output makes it incomplete, and the
        // finish step runs next (every queued response was discarded) and retries its write.
        this.persistFailures++;
        this.recordEvent('persist_failure', { where, discardedResponses: discarded, lastPersistedSeq: lastPersisted });
        this.enqueue('finalize', () => this.finalize());
        return;
      }
      this.deferredPersistFailure = { where, discardedResponses: discarded, lastPersistedSeq: lastPersisted, at: this.now() };
      this.transition('interrupted', 'storage_unavailable');
      this.detachSenderLink(SENDER_CLOSE.DETACHED, 'storage-unavailable');
      void this.withRetry('interrupted-write', () => this.deps.store.markInterrupted(this.id, 'storage_unavailable'), Infinity)
        .then(() => {
          this.storage = 'ok';
          const detail = this.deferredPersistFailure;
          this.deferredPersistFailure = null;
          if (detail) this.recordEvent('persist_failure', detail);
          this.publishState();
        })
        .catch(() => undefined);
    }
  }

  // ---- state and events ----

  private transition(state: SessionState, cause: InterruptionCause | null) {
    this.state = state;
    this.cause = cause;
    this.publishState();
    this.sender?.send({ type: 'state', ...this.summaryState() });
    if (state === 'interrupted' && cause) {
      void this.withRetry('state-write', () => this.deps.store.markInterrupted(this.id, cause)).catch((error: Error) =>
        this.log.error('state write failed', { state, error: error.message }),
      );
    }
  }

  private publishState() {
    if (!this.visible) return;
    this.deps.hub.publishState(this.room.slug, this.id, this.summaryState());
  }

  private summary() {
    return summaryOf({ ...this.session, state: this.state, cause: this.cause, completeness: this.completeness }, this.offeredStreams());
  }

  private recordDiscontinuity(detail: DiscontinuityDetail) {
    this.log.info('discontinuity', { ...detail });
    this.sender?.send({ type: 'discontinuity', detail });
    if (this.visible) this.deps.hub.publishGap(this.room.slug, this.id, detail.extentSamples, this.summaryState());
    this.recordEvent('discontinuity', { ...detail });
  }

  private pendingEvents: Array<{ seq: number; kind: string; detail: Record<string, unknown>; at: Date }> = [];

  private recordEvent(kind: string, detail: Record<string, unknown>) {
    this.eventSeq += 1;
    this.pendingEvents.push({ seq: this.eventSeq, kind, detail, at: new Date(this.now()) });
    void this.flushEvents();
  }

  private flushing = false;

  private async flushEvents(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pendingEvents.length > 0) {
        const event = this.pendingEvents[0] as { seq: number; kind: string; detail: Record<string, unknown>; at: Date };
        try {
          await this.deps.store.insertEvent({ sessionId: this.id, ...event });
          this.pendingEvents.shift();
        } catch (error) {
          this.log.warn('event write failed; kept for retry', { kind: event.kind, error: (error as Error).message });
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async withRetry<T>(label: string, fn: () => Promise<T>, budgetMs: number = this.deps.config.retryBudgetMs ?? 10000): Promise<T> {
    const started = this.now();
    const interval = this.deps.config.retryIntervalMs ?? 500;
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        attempt++;
        const elapsed = this.now() - started;
        if (elapsed + interval > budgetMs) throw error;
        if (attempt === 1 && (label === 'insert' || label === 'finishing-write')) {
          this.storage = 'failing';
          this.publishState();
        }
        this.log.warn('store operation failed; retrying', { label, attempt, error: (error as Error).message });
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    }
  }

  private stopTimers() {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.deadlineTimer = null;
    this.reconnectTimer = null;
    this.drainTimer = null;
    this.stopKeepalive();
  }

  /** Process shutdown: nothing is transitioned; restart recovery handles the rest. */
  dispose() {
    this.stopTimers();
    const gen = this.generation;
    if (gen && gen.state !== 'closed') {
      gen.state = 'closed';
      gen.connection?.terminate();
    }
  }
}
