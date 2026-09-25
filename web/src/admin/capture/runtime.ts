// Module-scope capture runtime keyed by room. One shared AudioContext; per room a source, a level
// tap, a silent gain, a monitor gain, and per run (session or source test) a worklet node and a
// sender socket. It survives React re-renders, route changes, and StrictMode double mounts.
// Created on the first user action.
import { AUDIO_SAMPLE_RATE, SENDER_CLOSE, type DetachReason, type DiscontinuityDetail, type EndReason, type InterruptionCause, type SenderServerMessage, type SessionState, type SourceLanguage } from '@nerditulos/shared';
import processorUrl from './captureProcessor.ts?worker&url';
import { createGeneration } from './generation.js';
import { initialLevel, reduceLevel, signalCheck, type LevelSample, type LevelState } from './level.js';
import { LevelMonitor } from './levelMonitor.js';
import { appendPreview, emptyPreview, testEndFromClose, testEndFromConnectError, type PreviewEndReason, type PreviewState } from './preview.js';
import { getAdminToken, getAuthMode, setCaptureActive } from './registry.js';
import { SenderSocket, type SenderTargetSpec } from './senderSocket.js';
import type { CaptureNotice } from './notices.js';
import { listMicrophones, mediaErrorCode, openFile, releaseSource, requestMicrophone, type CaptureSource, type DeviceOption, type SourceKind } from './sources.js';
import type { CaptureState, CheckState } from './viewModel.js';

/** The source a run used, kept after its resources were shut down so the console can reopen it. */
export type RememberedSource = { kind: 'microphone'; deviceId: string | null; label: string } | { kind: 'file'; file: File; label: string };

export interface CaptureSnapshot {
  slug: string;
  sessionId: string | null;
  state: CaptureState;
  sourceKind: SourceKind | null;
  /** The file name, or the microphone's label as the browser reports it (possibly empty). */
  sourceLabel: string | null;
  devices: DeviceOption[];
  selectedDeviceId: string | null;
  checks: { permission: CheckState; device: CheckState; signal: CheckState; receipt: CheckState };
  /** Block RMS in [0, 1]. */
  level: number;
  /** Held block peak in [0, 1]. */
  peak: number;
  clipping: boolean;
  noSignal: boolean;
  /** "Escuchar": the source is routed to the speakers. */
  monitor: boolean;
  trackSettings: MediaTrackSettings | null;
  /** Source test: what the provider recognized, and how the last test ended. Null until the first test. */
  preview: PreviewState | null;
  /** A test of the current source reached the provider. */
  testedSource: boolean;
  testStartedAt: number | null;
  testElapsedMs: number;
  /** Server id of this console's running test, so a start over it needs no confirmation. */
  testId: string | null;
  /** Language the current or last test was run with. */
  testLanguage: SourceLanguage | null;
  /** Set once a run's resources were shut down: the console offers to reopen this source. */
  remembered: RememberedSource | null;
  epoch: number | null;
  lastAck: { seq: number; samplePosition: number; receivedAt: number } | null;
  framesSent: number;
  framesDropped: number;
  /** Blocking failure of the source or the connection; the console translates it. */
  error: CaptureNotice | null;
  /** Non-blocking notice; the console translates it. */
  message: CaptureNotice | null;
  sessionState: SessionState | null;
  cause: InterruptionCause | null;
  completeness: 'complete' | 'incomplete' | null;
  discontinuities: number;
  file: { currentTime: number; duration: number } | null;
  paused: boolean;
}

type Listener = () => void;

let sharedContext: AudioContext | null = null;
let moduleLoaded: Promise<void> | null = null;
const debugEnabled = () => new URLSearchParams(window.location.search).get('debug') === '1';

function debugLog(line: Record<string, unknown>) {
  if (debugEnabled()) console.log('[sender]', JSON.stringify(line));
}

async function ensureContext(): Promise<AudioContext> {
  if (!sharedContext) sharedContext = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
  const ctx = sharedContext;
  if (ctx.state !== 'running') await ctx.resume();
  if (ctx.state !== 'running') throw new Error('audio_context_not_running');
  if (ctx.sampleRate !== AUDIO_SAMPLE_RATE) throw new Error('audio_context_sample_rate');
  if (!moduleLoaded) moduleLoaded = ctx.audioWorklet.addModule(processorUrl);
  await moduleLoaded;
  return ctx;
}

/** The notice for an `ensureContext` failure, or null when the error came from somewhere else. */
function audioContextNotice(error: unknown): CaptureNotice | null {
  if (!(error instanceof Error) || !error.message.startsWith('audio_context')) return null;
  return { kind: 'audio_context', code: error.message === 'audio_context_sample_rate' ? 'sample_rate' : 'not_running' };
}

const quantize = (value: number) => Math.round(value * 1000) / 1000;

function setGain(gain: GainNode, value: number, ctx: AudioContext, ramp: boolean) {
  gain.gain.cancelScheduledValues(ctx.currentTime);
  if (ramp) gain.gain.setTargetAtTime(value, ctx.currentTime, 0.02);
  else gain.gain.setValueAtTime(value, ctx.currentTime);
}

/** Test endings that keep the source alive: the audio continues into a session, or a new source replaces it. */
const TEST_END_KEEPS_SOURCE: ReadonlySet<PreviewEndReason> = new Set<PreviewEndReason>(['session_started', 'source_changed']);

class RoomCapture {
  private snap: CaptureSnapshot;
  private readonly listeners = new Set<Listener>();
  private source: CaptureSource | null = null;
  private worklet: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private monitorGain: GainNode | null = null;
  private levelMonitor: LevelMonitor | null = null;
  private levelState: LevelState = initialLevel();
  private liveSince = 0;
  private wasLive = false;
  private socket: SenderSocket | null = null;
  /** The current run's socket reached `ready`: its end is a real end, not a refused connection. */
  private readyReceived = false;
  private seq = 0;
  private dropAfterFlush = false;
  private droppedAfterFlush = 0;
  private flushWaiters: Array<() => void> = [];
  private connectedToWorklet = false;
  private progressTimer: number | null = null;
  private testTimer: number | null = null;
  private retryTimer: number | null = null;
  /** Invalidates in-flight async operations (source changes, starts, tests) superseded by a newer one. */
  private readonly generation = createGeneration();
  private controlChain: Promise<void> = Promise.resolve();

  constructor(readonly slug: string) {
    this.snap = {
      slug,
      sessionId: null,
      state: 'idle',
      sourceKind: null,
      sourceLabel: null,
      devices: [],
      selectedDeviceId: null,
      checks: { permission: 'pending', device: 'pending', signal: 'pending', receipt: 'pending' },
      level: 0,
      peak: 0,
      clipping: false,
      noSignal: false,
      monitor: false,
      trackSettings: null,
      preview: null,
      testedSource: false,
      testStartedAt: null,
      testElapsedMs: 0,
      testId: null,
      testLanguage: null,
      remembered: null,
      epoch: null,
      lastAck: null,
      framesSent: 0,
      framesDropped: 0,
      error: null,
      message: null,
      sessionState: null,
      cause: null,
      completeness: null,
      discontinuities: 0,
      file: null,
      paused: false,
    };
    navigator.mediaDevices?.addEventListener?.('devicechange', () => void this.refreshDevices());
  }

  snapshot(): CaptureSnapshot {
    return this.snap;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<CaptureSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  private setCheck(name: keyof CaptureSnapshot['checks'], value: CheckState) {
    this.set({ checks: { ...this.snap.checks, [name]: value } });
  }

  get sourceChecked(): boolean {
    const c = this.snap.checks;
    return this.source !== null && c.permission === 'ok' && c.device === 'ok';
  }

  setSessionState(sessionState: SessionState | null, cause: InterruptionCause | null, completeness: 'complete' | 'incomplete' | null) {
    this.set({ sessionState, cause, completeness });
    if (sessionState === 'interrupted' && (this.snap.state === 'streaming' || this.snap.state === 'paused' || this.snap.state === 'connecting')) {
      this.set({ state: 'interrupted' });
    }
  }

  // ---- sources ----

  async refreshDevices() {
    try {
      const devices = await listMicrophones();
      this.set({ devices });
    } catch {
      // ignore
    }
  }

  async useMicrophone(deviceId?: string) {
    this.finishTest('source_changed');
    this.clearRetry();
    const gen = this.generation.bump();
    this.set({ state: 'checking', error: null, message: null });
    let source: CaptureSource | null = null;
    try {
      const ctx = await ensureContext();
      if (!this.generation.isCurrent(gen)) return;
      // Acquire first, then swap: a failed request leaves the previous source in place.
      source = await requestMicrophone(ctx, deviceId);
      if (!this.generation.isCurrent(gen)) {
        releaseSource(source);
        return;
      }
      this.releaseCurrentSource();
      this.source = source;
      const mine = source;
      source.track.onended = () => {
        if (this.source === mine) this.onDeviceLost();
      };
      source.track.onmute = () => {
        if (this.source === mine) this.set({ message: { kind: 'mic_muted' } });
      };
      source.track.onunmute = () => {
        if (this.source === mine) this.set({ message: null });
      };
      this.set({
        sourceKind: 'microphone',
        sourceLabel: source.track.label || '',
        selectedDeviceId: source.settings.deviceId ?? deviceId ?? null,
        state: 'ready',
        remembered: null,
        checks: { permission: 'ok', device: 'ok', signal: 'pending', receipt: 'pending' },
        trackSettings: source.settings,
        file: null,
      });
      this.attachGraph(ctx);
      debugLog({ kind: 'source', source: 'microphone', settings: source.settings });
      await this.refreshDevices();
    } catch (error) {
      if (!this.generation.isCurrent(gen)) return;
      const notice = audioContextNotice(error) ?? { kind: 'media' as const, code: mediaErrorCode(error) };
      const code = notice.kind === 'media' ? notice.code : null;
      this.set({
        state: 'error',
        error: notice,
        checks: { permission: code === 'permission_denied' ? 'error' : this.snap.checks.permission === 'ok' ? 'ok' : 'pending', device: code === 'no_device' || code === 'device_busy' || code === 'constraints' ? 'error' : 'pending', signal: 'pending', receipt: 'pending' },
      });
    }
  }

  async useFile(file: File) {
    this.finishTest('source_changed');
    this.clearRetry();
    const gen = this.generation.bump();
    this.set({ state: 'checking', error: null, message: null });
    let source: CaptureSource | null = null;
    try {
      const ctx = await ensureContext();
      if (!this.generation.isCurrent(gen)) return;
      source = openFile(ctx, file);
      const mine = source;
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('metadata_timeout')), 10000);
        mine.element.onloadedmetadata = () => {
          window.clearTimeout(timer);
          resolve();
        };
        mine.element.onerror = () => {
          window.clearTimeout(timer);
          reject(new Error('decode'));
        };
      });
      if (!this.generation.isCurrent(gen)) {
        releaseSource(source);
        return;
      }
      this.releaseCurrentSource();
      this.source = source;
      mine.element.onended = () => {
        if (this.source === mine) this.onFileEnded();
      };
      mine.element.onerror = () => {
        if (this.source === mine) this.set({ state: 'error', error: { kind: 'file_decode' } });
      };
      this.set({
        sourceKind: 'file',
        sourceLabel: file.name,
        state: 'ready',
        remembered: null,
        checks: { permission: 'ok', device: 'ok', signal: 'pending', receipt: 'pending' },
        trackSettings: null,
        file: { currentTime: 0, duration: source.element.duration },
      });
      this.attachGraph(ctx);
      debugLog({ kind: 'source', source: 'file', name: file.name, size: file.size, duration: source.element.duration });
    } catch (error) {
      if (source && this.source !== source) releaseSource(source);
      if (!this.generation.isCurrent(gen)) return;
      this.set({ state: 'error', error: audioContextNotice(error) ?? { kind: 'file_open' } });
    }
  }

  /** Reopens the source a finished run used ("Fuente apagada · Volver a abrir"). */
  async reopen() {
    const remembered = this.snap.remembered;
    if (!remembered || this.source) return;
    if (remembered.kind === 'microphone') await this.useMicrophone(remembered.deviceId ?? undefined);
    else await this.useFile(remembered.file);
  }

  private releaseCurrentSource() {
    this.levelMonitor?.detach();
    if (this.source) releaseSource(this.source);
    this.source = null;
    if (this.monitorGain && sharedContext) setGain(this.monitorGain, 0, sharedContext, false);
    this.levelState = initialLevel();
    this.wasLive = false;
    this.set({
      sourceKind: null,
      sourceLabel: null,
      file: null,
      level: 0,
      peak: 0,
      clipping: false,
      noSignal: false,
      monitor: false,
      trackSettings: null,
      preview: null,
      testedSource: false,
      remembered: null,
      checks: { ...this.snap.checks, signal: 'pending' },
    });
  }

  /**
   * End of a run that reached the server: the microphone track stops (or the file unloads), the
   * meter and monitoring stop, the socket closes. The test result stays on screen and the source is
   * remembered so the console can reopen it. Never for a refused connection or a mere interruption.
   */
  private shutdownResources() {
    const source = this.source;
    if (!source) return;
    const remembered: RememberedSource =
      source.kind === 'microphone'
        ? { kind: 'microphone', deviceId: this.snap.selectedDeviceId, label: this.snap.sourceLabel ?? '' }
        : { kind: 'file', file: source.file, label: source.file.name };
    this.levelMonitor?.detach();
    releaseSource(source);
    this.source = null;
    if (this.monitorGain && sharedContext) setGain(this.monitorGain, 0, sharedContext, false);
    this.levelState = initialLevel();
    this.wasLive = false;
    this.set({ sourceKind: null, sourceLabel: null, file: null, level: 0, peak: 0, clipping: false, noSignal: false, monitor: false, trackSettings: null, remembered, checks: { ...this.snap.checks, signal: 'pending' } });
    debugLog({ kind: 'source_shutdown', source: remembered.kind, at: Date.now() });
  }

  /** Per-source graph, alive until the source is released: level tap and monitor path, both silent by default. */
  private attachGraph(ctx: AudioContext) {
    if (!this.source) return;
    const silent = this.ensureSilentGain(ctx);
    const monitor = this.ensureMonitorGain(ctx);
    this.source.node.connect(monitor);
    if (!this.levelMonitor) this.levelMonitor = new LevelMonitor(ctx, (sample, now) => this.onLevelTick(sample, now));
    this.levelState = initialLevel();
    this.wasLive = false;
    this.levelMonitor.attach(this.source.node, silent);
  }

  private ensureSilentGain(ctx: AudioContext): GainNode {
    if (!this.silentGain) {
      this.silentGain = ctx.createGain();
      this.silentGain.gain.value = 0;
      this.silentGain.connect(ctx.destination);
    }
    return this.silentGain;
  }

  private ensureMonitorGain(ctx: AudioContext): GainNode {
    if (!this.monitorGain) {
      this.monitorGain = ctx.createGain();
      this.monitorGain.gain.value = 0;
      this.monitorGain.connect(ctx.destination);
    }
    return this.monitorGain;
  }

  private sourceLive(): boolean {
    const source = this.source;
    if (!source) return false;
    if (source.kind === 'microphone') return source.track.readyState === 'live' && source.track.enabled;
    return !source.element.paused && !source.element.ended;
  }

  private onLevelTick(sample: LevelSample, now: number) {
    this.levelState = reduceLevel(this.levelState, sample, now);
    const live = this.sourceLive();
    if (live && !this.wasLive) this.liveSince = now;
    this.wasLive = live;
    const patch: Partial<CaptureSnapshot> = {};
    const level = quantize(this.levelState.level);
    const peak = quantize(this.levelState.peak);
    if (level !== this.snap.level) patch.level = level;
    if (peak !== this.snap.peak) patch.peak = peak;
    if (this.levelState.clipping !== this.snap.clipping) patch.clipping = this.levelState.clipping;
    if (live) {
      const check = signalCheck(this.levelState, this.liveSince, now);
      const noSignal = check === 'warning';
      if (noSignal !== this.snap.noSignal) patch.noSignal = noSignal;
      if (check !== this.snap.checks.signal) patch.checks = { ...this.snap.checks, signal: check };
    } else if (this.snap.noSignal) {
      patch.noSignal = false;
    }
    if (Object.keys(patch).length > 0) this.set(patch);
  }

  /** "Escuchar": route the source to the speakers. Off by default; turned off when a session starts. */
  async setMonitor(on: boolean) {
    let ctx: AudioContext;
    try {
      ctx = await ensureContext();
    } catch {
      this.set({ monitor: false, message: { kind: 'audio_context', code: 'not_running' } });
      return;
    }
    if (!this.source) return;
    setGain(this.ensureMonitorGain(ctx), on ? 1 : 0, ctx, true);
    this.set({ monitor: on });
    debugLog({ kind: 'monitor', on, at: Date.now() });
  }

  // ---- source test ----

  /** Checks the source against the provider without a session; the server echoes the recognized text. */
  async startTest(sourceLanguage: SourceLanguage) {
    if (!this.source || !this.sourceChecked) return;
    if (this.snap.state !== 'ready' && this.snap.state !== 'ended' && this.snap.state !== 'error') return;
    const gen = this.generation.bump();
    this.set({
      state: 'testing',
      error: null,
      message: null,
      preview: emptyPreview('connecting'),
      epoch: null,
      lastAck: null,
      framesSent: 0,
      framesDropped: 0,
      discontinuities: 0,
      testStartedAt: null,
      testElapsedMs: 0,
      testId: null,
      testLanguage: sourceLanguage,
      checks: { ...this.snap.checks, receipt: 'pending' },
    });
    setCaptureActive(this.slug, true);
    let ctx: AudioContext;
    try {
      ctx = await ensureContext();
      if (!this.generation.isCurrent(gen)) throw new Error('superseded');
      await this.openSocket({ test: { room: this.slug, sourceLanguage } }, gen);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'error';
      if (!this.generation.isCurrent(gen)) return;
      debugLog({ kind: 'test_connect_failed', reason, at: Date.now() });
      this.finishTest(testEndFromConnectError(reason));
      return;
    }
    // The source may have changed while the socket opened; that already ended this test.
    if (!this.generation.isCurrent(gen) || !this.isTesting() || !this.source) return;
    this.startWorklet(ctx);
    if (this.source.kind === 'microphone') this.source.track.enabled = true;
    else {
      this.source.element.currentTime = 0;
      try {
        await this.source.element.play();
      } catch {
        // Autoplay refusals surface as no signal; the run continues.
      }
      if (!this.generation.isCurrent(gen)) return;
      this.startProgress();
    }
    const startedAt = performance.now();
    this.set({ testStartedAt: startedAt, testElapsedMs: 0 });
    this.testTimer = window.setInterval(() => this.set({ testElapsedMs: performance.now() - startedAt }), 1000);
    debugLog({ kind: 'test_start', sourceLanguage, at: Date.now() });
  }

  stopTest(reason: Extract<PreviewEndReason, 'stopped' | 'session_started'> = 'stopped') {
    this.finishTest(reason);
  }

  private isTesting(): boolean {
    return this.snap.state === 'testing';
  }

  /** The only way out of `testing`, idempotent. The socket's own close is ignored once it is dropped here. */
  private finishTest(reason: PreviewEndReason) {
    if (this.snap.state !== 'testing') return;
    const socket = this.socket;
    const reachedServer = this.readyReceived;
    this.socket = null;
    this.readyReceived = false;
    this.generation.bump();
    if (this.testTimer !== null) window.clearInterval(this.testTimer);
    this.testTimer = null;
    this.teardownGraph();
    socket?.close();
    let file = this.snap.file;
    if (this.source?.kind === 'file') {
      this.source.element.currentTime = 0;
      file = { currentTime: 0, duration: this.source.element.duration };
    }
    const preview = this.snap.preview ?? emptyPreview();
    // A rejection (`room-busy`, say) is already explained by the end-of-test line; a muted microphone still is not.
    const message = this.snap.message?.kind === 'rejected' ? null : this.snap.message;
    this.set({ state: 'ready', preview: { ...preview, state: 'ended', endedReason: reason }, file, testStartedAt: null, testId: null, message });
    setCaptureActive(this.slug, false);
    debugLog({ kind: 'test_end', reason, reachedServer, at: Date.now() });
    // A test that ran against the provider is a real end of audio use; a refused one never used it.
    if (reachedServer && !TEST_END_KEEPS_SOURCE.has(reason)) this.shutdownResources();
  }

  private onPreview(message: Extract<SenderServerMessage, { type: 'preview' }>) {
    if (this.snap.state !== 'testing') return;
    this.set({ preview: appendPreview(this.snap.preview ?? emptyPreview('listening'), message) });
  }

  private onTest(message: Extract<SenderServerMessage, { type: 'test' }>) {
    if (this.snap.state !== 'testing') return;
    if (message.state === 'listening') {
      this.set({ preview: { ...(this.snap.preview ?? emptyPreview()), state: 'listening' }, testedSource: true });
      return;
    }
    this.finishTest(message.reason);
  }

  // ---- session control ----

  async start(sessionId: string) {
    if (!this.source) throw new Error('no-source');
    if (this.snap.state === 'streaming' || this.snap.state === 'connecting') return;
    // Own test over the same source: its audio continues into the session, nothing shuts down.
    this.finishTest('session_started');
    this.clearRetry();
    const gen = this.generation.bump();
    if (this.snap.monitor) void this.setMonitor(false);
    this.set({ sessionId, state: 'connecting', error: null, message: null, epoch: null, lastAck: null, discontinuities: 0, paused: false, checks: { ...this.snap.checks, receipt: 'pending' } });
    setCaptureActive(this.slug, true);
    let ctx: AudioContext;
    try {
      ctx = await ensureContext();
      if (!this.generation.isCurrent(gen)) return;
      await this.openSocket({ sessionId }, gen);
    } catch (error) {
      if (!this.generation.isCurrent(gen)) return;
      const reason = error instanceof Error ? error.message : 'error';
      if (reason.includes('generation-draining')) {
        this.set({ state: 'waiting', message: { kind: 'waiting_previous' } });
        this.retryTimer = window.setTimeout(() => {
          this.retryTimer = null;
          if (this.generation.isCurrent(gen) && this.snap.state === 'waiting') void this.start(sessionId);
        }, 1500);
        return;
      }
      if (reason.includes('sender-active')) {
        this.set({ state: 'error', error: { kind: 'sender_active' } });
        setCaptureActive(this.slug, false);
        return;
      }
      const notice: CaptureNotice = audioContextNotice(error) ?? { kind: 'connect_failed', reason };
      this.set({ state: 'error', error: notice });
      setCaptureActive(this.slug, false);
      return;
    }
    if (!this.generation.isCurrent(gen) || !this.source || this.snapshot().state !== 'connecting') return;
    // Order: context -> module -> socket ready -> start tracks / play.
    this.startWorklet(ctx);
    if (this.source.kind === 'microphone') this.source.track.enabled = true;
    else {
      try {
        await this.source.element.play();
      } catch {
        // Autoplay refusals surface as no signal; the run continues.
      }
      if (!this.generation.isCurrent(gen)) return;
      this.startProgress();
    }
    this.set({ state: 'streaming', paused: false });
  }

  /** Cancels a start that has not reached `streaming` (this console's session was finished elsewhere). */
  abort() {
    if (this.snap.state !== 'connecting' && this.snap.state !== 'waiting') return;
    this.clearRetry();
    this.generation.bump();
    const socket = this.socket;
    this.socket = null;
    this.readyReceived = false;
    this.teardownGraph();
    socket?.close();
    this.set({ state: this.source ? 'ready' : 'idle', sessionId: null, message: null, sessionState: null, cause: null, completeness: null });
    setCaptureActive(this.slug, false);
    debugLog({ kind: 'abort', at: Date.now() });
  }

  private clearRetry() {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** A fresh worklet per run, so the chunker starts at position 0 and the server sees no client gap. */
  private startWorklet(ctx: AudioContext) {
    this.seq = 0;
    this.dropAfterFlush = false;
    this.droppedAfterFlush = 0;
    const worklet = new AudioWorkletNode(ctx, 'nerditulos-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    worklet.port.onmessage = (event: MessageEvent) => this.onWorkletMessage(event.data as { type: string; samplePosition?: number; pcm?: Int16Array });
    worklet.connect(this.ensureSilentGain(ctx));
    this.worklet = worklet;
    this.connectSourceToWorklet();
  }

  private async openSocket(target: SenderTargetSpec, gen: number) {
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/sender`;
    this.readyReceived = false;
    const socket = new SenderSocket({
      url,
      target,
      auth: { mode: getAuthMode() },
      getToken: (o) => getAdminToken(o),
      debug: debugEnabled() ? (line) => debugLog(line) : undefined,
      events: {
        onReady: (epoch, _position, testId) => {
          if (this.socket !== socket) return;
          this.readyReceived = true;
          this.set({ epoch, ...(testId ? { testId } : {}) });
        },
        onRejected: (reason) => {
          if (this.socket === socket) this.set({ message: { kind: 'rejected', reason } });
        },
        onAck: (ack) => {
          if (this.socket !== socket) return;
          this.set({ lastAck: ack });
          if (this.snap.checks.receipt !== 'ok') this.setCheck('receipt', 'ok');
        },
        onFinishing: () => {
          if (this.socket === socket) this.onRemoteFinishing();
        },
        onState: (s) => {
          if (this.socket === socket) this.setSessionState(s.state, s.cause, s.completeness);
        },
        onDiscontinuity: (detail: DiscontinuityDetail) => {
          if (this.socket !== socket) return;
          this.set({ discontinuities: this.snap.discontinuities + 1 });
          debugLog({ kind: 'discontinuity', detail });
        },
        onPreview: (message) => {
          if (this.socket === socket) this.onPreview(message);
        },
        onTest: (message) => {
          if (this.socket === socket) this.onTest(message);
        },
        onClose: (code, reason, noRetry) => {
          if (this.socket === socket) this.onSocketClosed(code, reason, noRetry);
        },
      },
    });
    this.socket = socket;
    try {
      await socket.connect();
    } catch (error) {
      // The rejected socket's close event must not overwrite the state its caller sets.
      if (this.socket === socket) this.socket = null;
      throw error;
    }
    if (!this.generation.isCurrent(gen)) {
      // Superseded while opening: this run is over before it started.
      if (this.socket === socket) this.socket = null;
      socket.close();
      throw new Error('superseded');
    }
  }

  private connectSourceToWorklet() {
    if (!this.source || !this.worklet || this.connectedToWorklet) return;
    this.source.node.connect(this.worklet);
    this.connectedToWorklet = true;
  }

  private disconnectSourceFromWorklet() {
    if (!this.source || !this.worklet || !this.connectedToWorklet) return;
    try {
      this.source.node.disconnect(this.worklet);
    } catch {
      // already disconnected
    }
    this.connectedToWorklet = false;
  }

  private onWorkletMessage(data: { type: string; samplePosition?: number; pcm?: Int16Array }) {
    if (data.type === 'flushed') {
      const waiters = this.flushWaiters;
      this.flushWaiters = [];
      for (const w of waiters) w();
      return;
    }
    if (data.type !== 'chunk' || !data.pcm || data.samplePosition === undefined) return;
    if (this.dropAfterFlush) {
      this.droppedAfterFlush++;
      return;
    }
    const pcm = data.pcm;
    const socket = this.socket;
    const seq = this.seq++;
    const sent = socket ? socket.sendFrame(seq, data.samplePosition, pcm) : false;
    const sourceTime = this.source?.kind === 'file' ? this.source.element.currentTime : undefined;
    if (debugEnabled()) debugLog({ kind: 'chunk', seq, samplePosition: data.samplePosition, samples: pcm.length, sent, sourceTime, sentAt: Date.now(), perfNow: performance.now(), buffered: socket?.bufferedAmount ?? 0 });
    if (seq % 5 === 0 || !sent) {
      this.set({ framesSent: socket?.counters.framesSent ?? this.snap.framesSent, framesDropped: (socket?.counters.framesDroppedCongestion ?? 0) + this.droppedAfterFlush });
    }
  }

  private startProgress() {
    this.stopProgress();
    this.progressTimer = window.setInterval(() => {
      if (this.source?.kind === 'file') this.set({ file: { currentTime: this.source.element.currentTime, duration: this.source.element.duration } });
    }, 500);
  }

  private stopProgress() {
    if (this.progressTimer !== null) window.clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  private flush(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.worklet) {
        resolve();
        return;
      }
      this.flushWaiters.push(resolve);
      this.worklet.port.postMessage({ type: 'flush' });
      window.setTimeout(resolve, 1000);
    });
  }

  /** Pause and resume run one after the other, so a quick pair never interleaves its awaits. */
  private serialize(fn: () => Promise<void>): Promise<void> {
    const run = this.controlChain.then(fn, fn);
    this.controlChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Voluntary pause: flush, disconnect the source, freeze the counter, tell the server. */
  pause() {
    return this.serialize(async () => {
      if (this.snap.state !== 'streaming' || !this.source) return;
      const socket = this.socket;
      this.set({ state: 'paused', paused: true });
      await this.flush();
      if (this.snapshot().state !== 'paused' || this.socket !== socket || !this.source) return;
      this.disconnectSourceFromWorklet();
      if (this.source.kind === 'file') this.source.element.pause();
      else this.source.track.enabled = false;
      socket?.sendControl({ type: 'pause' });
      debugLog({ kind: 'pause', at: Date.now() });
    });
  }

  resume() {
    return this.serialize(async () => {
      if (this.snap.state !== 'paused' || !this.source) return;
      const socket = this.socket;
      this.connectSourceToWorklet();
      if (this.source.kind === 'file') {
        try {
          await this.source.element.play();
        } catch {
          // Autoplay refusals surface as no signal.
        }
        if (this.snapshot().state !== 'paused' || this.socket !== socket) return;
      } else this.source.track.enabled = true;
      socket?.sendControl({ type: 'resume' });
      this.set({ state: 'streaming', paused: false });
      debugLog({ kind: 'resume', at: Date.now() });
    });
  }

  /** Seeking is allowed only while paused, through the explicit resume position control. */
  seekFile(seconds: number) {
    if (this.snap.state !== 'paused' || this.source?.kind !== 'file') return;
    this.source.element.currentTime = seconds;
    this.set({ file: { currentTime: seconds, duration: this.source.element.duration } });
    debugLog({ kind: 'source_seek', seconds, at: Date.now() });
  }

  /** Stop order: ending -> stop the source -> flush -> reason message, to the socket of this run only. */
  async stop(kind: 'end' | 'detach', reason: EndReason | DetachReason) {
    if (this.snap.state === 'ending' || this.snap.state === 'ended' || this.snap.state === 'idle' || this.snap.state === 'ready' || this.snap.state === 'testing') return;
    const socket = this.socket;
    this.clearRetry();
    this.set({ state: 'ending' });
    this.stopProgress();
    if (this.source?.kind === 'file') this.source.element.pause();
    else if (this.source?.kind === 'microphone' && kind === 'end') this.source.track.enabled = false;
    await this.flush();
    this.dropAfterFlush = true;
    this.disconnectSourceFromWorklet();
    if (kind === 'end') socket?.sendControl({ type: 'end', reason: reason as EndReason });
    else socket?.sendControl({ type: 'detach', reason: reason as DetachReason });
    debugLog({ kind, reason, droppedAfterFlush: this.droppedAfterFlush, at: Date.now() });
  }

  finish() {
    return this.stop('end', 'finish');
  }

  /** The server is finishing the session (another console, or a file end): stop feeding, keep the socket for its last messages. */
  private onRemoteFinishing() {
    this.set({ sessionState: 'finishing', state: 'ending' });
    this.stopProgress();
    if (this.source?.kind === 'file') this.source.element.pause();
    else if (this.source?.kind === 'microphone') this.source.track.enabled = false;
    this.dropAfterFlush = true;
    this.disconnectSourceFromWorklet();
  }

  private onFileEnded() {
    if (this.snap.state === 'testing') this.finishTest('file_end');
    else void this.stop('end', 'file_end');
  }

  private onDeviceLost() {
    const lost = { checks: { ...this.snap.checks, device: 'error' as const }, error: { kind: 'device_lost' as const } };
    if (this.snap.state === 'testing') {
      this.finishTest('device_lost');
      this.set({ ...lost, state: 'error' });
    } else if (this.snap.state === 'streaming' || this.snap.state === 'paused') {
      void this.stop('detach', 'device_lost').then(() => {
        this.set({ checks: { ...this.snap.checks, device: 'error' }, error: lost.error });
      });
    } else {
      this.set({ ...lost, state: 'error' });
    }
  }

  private onSocketClosed(code: number, reason: string, noRetry: boolean) {
    debugLog({ kind: 'socket_close', code, reason, at: Date.now() });
    const reachedServer = this.readyReceived;
    this.readyReceived = false;
    if (this.snap.state === 'testing') {
      this.finishTest(testEndFromClose(code, reason));
      return;
    }
    this.teardownGraph();
    if (code === SENDER_CLOSE.NOT_JOINABLE) {
      this.set({ state: 'ended', message: reason === 'finished' ? null : { kind: 'session_unavailable', reason } });
      setCaptureActive(this.slug, false);
      if (reachedServer) this.shutdownResources();
      return;
    }
    if (noRetry) {
      this.set({ state: 'error', error: { kind: 'closed_no_retry', code, reason } });
      setCaptureActive(this.slug, false);
      if (reachedServer) this.shutdownResources();
      return;
    }
    if (this.snap.state === 'ending') {
      this.set({ state: 'ended' });
      setCaptureActive(this.slug, false);
      if (reachedServer) this.shutdownResources();
      return;
    }
    // Interrupted: the source stays so "Reconectar" can resume with it.
    this.set({ state: 'interrupted', message: { kind: 'send_interrupted', code, reason } });
    setCaptureActive(this.slug, false);
  }

  /** Ends a run: drops the worklet and socket, leaves the source and its level tap in place. */
  private teardownGraph() {
    this.stopProgress();
    this.disconnectSourceFromWorklet();
    if (this.worklet) {
      try {
        this.worklet.port.onmessage = null;
        this.worklet.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.worklet = null;
    this.socket = null;
    if (this.source?.kind === 'file') this.source.element.pause();
  }

  /** Re-auth with the same session id after an interruption: new socket, new epoch, fresh chunker. */
  async reconnect() {
    if (!this.snap.sessionId || !this.source) return;
    if (this.source.kind === 'microphone' && this.source.track.readyState === 'ended') {
      this.set({ error: { kind: 'mic_gone' } });
      return;
    }
    this.teardownGraph();
    await this.start(this.snap.sessionId);
  }

  reset() {
    this.finishTest('stopped');
    this.clearRetry();
    this.generation.bump();
    this.teardownGraph();
    this.set({ state: this.source ? 'ready' : 'idle', sessionId: null, epoch: null, lastAck: null, message: null, error: null, sessionState: null, cause: null, completeness: null, paused: false, checks: { ...this.snap.checks, signal: 'pending', receipt: 'pending' } });
  }
}

const captures = new Map<string, RoomCapture>();

export function getCapture(slug: string): RoomCapture {
  let capture = captures.get(slug);
  if (!capture) {
    capture = new RoomCapture(slug);
    captures.set(slug, capture);
  }
  return capture;
}

export type { RoomCapture };
