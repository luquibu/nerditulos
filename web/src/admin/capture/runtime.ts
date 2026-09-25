// Module-scope capture runtime keyed by room. One shared AudioContext; per room a source, a level
// tap, a silent gain, a monitor gain, and per run (session or source test) a worklet node and a
// sender socket. It survives React re-renders, route changes, and StrictMode double mounts.
// Created on the first user action.
import { AUDIO_SAMPLE_RATE, SENDER_CLOSE, type DetachReason, type DiscontinuityDetail, type EndReason, type InterruptionCause, type SenderServerMessage, type SessionState, type SourceLanguage } from '@nerditulos/shared';
import processorUrl from './captureProcessor.ts?worker&url';
import { initialLevel, reduceLevel, signalCheck, type LevelSample, type LevelState } from './level.js';
import { LevelMonitor } from './levelMonitor.js';
import { appendPreview, emptyPreview, testEndFromClose, testEndFromConnectError, type PreviewEndReason, type PreviewState } from './preview.js';
import { getAdminToken, setCaptureActive } from './registry.js';
import { SenderSocket, type SenderTargetSpec } from './senderSocket.js';
import type { CaptureNotice } from './notices.js';
import { listMicrophones, mediaErrorCode, openFile, releaseSource, requestMicrophone, type CaptureSource, type DeviceOption, type SourceKind } from './sources.js';
import type { CaptureState, CheckState } from './viewModel.js';

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
  private seq = 0;
  private dropAfterFlush = false;
  private droppedAfterFlush = 0;
  private flushWaiters: Array<() => void> = [];
  private connectedToWorklet = false;
  private progressTimer: number | null = null;
  private testTimer: number | null = null;

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
    this.set({ state: 'checking', error: null, message: null });
    try {
      const ctx = await ensureContext();
      this.releaseCurrentSource();
      const source = await requestMicrophone(ctx, deviceId);
      this.source = source;
      source.track.onended = () => this.onDeviceLost();
      source.track.onmute = () => this.set({ message: { kind: 'mic_muted' } });
      source.track.onunmute = () => this.set({ message: null });
      this.set({
        sourceKind: 'microphone',
        sourceLabel: source.track.label || '',
        selectedDeviceId: source.settings.deviceId ?? deviceId ?? null,
        state: 'ready',
        checks: { permission: 'ok', device: 'ok', signal: 'pending', receipt: 'pending' },
        trackSettings: source.settings,
        file: null,
      });
      this.attachGraph(ctx);
      debugLog({ kind: 'source', source: 'microphone', settings: source.settings });
      await this.refreshDevices();
    } catch (error) {
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
    this.set({ state: 'checking', error: null, message: null });
    try {
      const ctx = await ensureContext();
      this.releaseCurrentSource();
      const source = openFile(ctx, file);
      this.source = source;
      source.element.onended = () => this.onFileEnded();
      source.element.onerror = () => this.set({ state: 'error', error: { kind: 'file_decode' } });
      await new Promise<void>((resolve, reject) => {
        source.element.onloadedmetadata = () => resolve();
        source.element.onerror = () => reject(new Error('decode'));
        setTimeout(() => reject(new Error('metadata_timeout')), 10000);
      });
      this.set({
        sourceKind: 'file',
        sourceLabel: file.name,
        state: 'ready',
        checks: { permission: 'ok', device: 'ok', signal: 'pending', receipt: 'pending' },
        trackSettings: null,
        file: { currentTime: 0, duration: source.element.duration },
      });
      this.attachGraph(ctx);
      debugLog({ kind: 'source', source: 'file', name: file.name, size: file.size, duration: source.element.duration });
    } catch (error) {
      this.set({ state: 'error', error: audioContextNotice(error) ?? { kind: 'file_open' } });
    }
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
      checks: { ...this.snap.checks, signal: 'pending' },
    });
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
    setGain(this.ensureMonitorGain(ctx), on ? 1 : 0, ctx, true);
    this.set({ monitor: on });
    debugLog({ kind: 'monitor', on, at: Date.now() });
  }

  // ---- source test ----

  /** Checks the source against the provider without a session; the server echoes the recognized text. */
  async startTest(sourceLanguage: SourceLanguage) {
    if (!this.source || !this.sourceChecked) return;
    if (this.snap.state !== 'ready' && this.snap.state !== 'ended' && this.snap.state !== 'error') return;
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
      checks: { ...this.snap.checks, receipt: 'pending' },
    });
    setCaptureActive(this.slug, true);
    let ctx: AudioContext;
    try {
      ctx = await ensureContext();
      await this.openSocket({ test: { room: this.slug, sourceLanguage } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'error';
      debugLog({ kind: 'test_connect_failed', reason, at: Date.now() });
      this.finishTest(testEndFromConnectError(reason));
      return;
    }
    // The source may have changed while the socket opened; that already ended this test.
    if (!this.isTesting() || !this.source) return;
    this.startWorklet(ctx);
    if (this.source.kind === 'microphone') this.source.track.enabled = true;
    else {
      this.source.element.currentTime = 0;
      await this.source.element.play();
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
    this.socket = null;
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
    this.set({ state: 'ready', preview: { ...preview, state: 'ended', endedReason: reason }, file, testStartedAt: null, message });
    setCaptureActive(this.slug, false);
    debugLog({ kind: 'test_end', reason, at: Date.now() });
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
    this.finishTest('session_started');
    if (this.snap.monitor) void this.setMonitor(false);
    this.set({ sessionId, state: 'connecting', error: null, message: null, epoch: null, lastAck: null, discontinuities: 0, paused: false, checks: { ...this.snap.checks, receipt: 'pending' } });
    setCaptureActive(this.slug, true);
    const ctx = await ensureContext();
    try {
      await this.openSocket({ sessionId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'error';
      if (reason.includes('generation-draining')) {
        this.set({ state: 'waiting', message: { kind: 'waiting_previous' } });
        window.setTimeout(() => void this.start(sessionId), 1500);
        return;
      }
      if (reason.includes('sender-active')) {
        this.set({ state: 'error', error: { kind: 'sender_active' } });
        setCaptureActive(this.slug, false);
        return;
      }
      this.set({ state: 'error', error: { kind: 'connect_failed', reason } });
      setCaptureActive(this.slug, false);
      return;
    }
    // Order: context -> module -> socket ready -> start tracks / play.
    this.startWorklet(ctx);
    if (this.source.kind === 'microphone') this.source.track.enabled = true;
    else {
      await this.source.element.play();
      this.startProgress();
    }
    this.set({ state: 'streaming', paused: false });
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

  private async openSocket(target: SenderTargetSpec) {
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/sender`;
    const socket = new SenderSocket({
      url,
      target,
      getToken: (o) => getAdminToken(o),
      debug: debugEnabled() ? (line) => debugLog(line) : undefined,
      events: {
        onReady: (epoch) => this.set({ epoch }),
        onRejected: (reason) => this.set({ message: { kind: 'rejected', reason } }),
        onAck: (ack) => {
          this.set({ lastAck: ack });
          if (this.snap.checks.receipt !== 'ok') this.setCheck('receipt', 'ok');
        },
        onFinishing: () => this.set({ sessionState: 'finishing', state: 'ending' }),
        onState: (s) => this.setSessionState(s.state, s.cause, s.completeness),
        onDiscontinuity: (detail: DiscontinuityDetail) => {
          this.set({ discontinuities: this.snap.discontinuities + 1 });
          debugLog({ kind: 'discontinuity', detail });
        },
        onPreview: (message) => this.onPreview(message),
        onTest: (message) => this.onTest(message),
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

  /** Voluntary pause: flush, disconnect the source, freeze the counter, tell the server. */
  async pause() {
    if (this.snap.state !== 'streaming' || !this.source) return;
    this.set({ state: 'paused', paused: true });
    await this.flush();
    this.disconnectSourceFromWorklet();
    if (this.source.kind === 'file') this.source.element.pause();
    else this.source.track.enabled = false;
    this.socket?.sendControl({ type: 'pause' });
    debugLog({ kind: 'pause', at: Date.now() });
  }

  async resume() {
    if (this.snap.state !== 'paused' || !this.source) return;
    this.connectSourceToWorklet();
    if (this.source.kind === 'file') await this.source.element.play();
    else this.source.track.enabled = true;
    this.socket?.sendControl({ type: 'resume' });
    this.set({ state: 'streaming', paused: false });
    debugLog({ kind: 'resume', at: Date.now() });
  }

  /** Seeking is allowed only while paused, through the explicit resume position control. */
  seekFile(seconds: number) {
    if (this.snap.state !== 'paused' || this.source?.kind !== 'file') return;
    this.source.element.currentTime = seconds;
    this.set({ file: { currentTime: seconds, duration: this.source.element.duration } });
    debugLog({ kind: 'source_seek', seconds, at: Date.now() });
  }

  /** Stop order: ending -> stop the source -> flush -> reason message. */
  async stop(kind: 'end' | 'detach', reason: EndReason | DetachReason) {
    if (this.snap.state === 'ending' || this.snap.state === 'ended' || this.snap.state === 'idle' || this.snap.state === 'ready' || this.snap.state === 'testing') return;
    this.set({ state: 'ending' });
    this.stopProgress();
    if (this.source?.kind === 'file') this.source.element.pause();
    else if (this.source?.kind === 'microphone' && kind === 'end') this.source.track.enabled = false;
    await this.flush();
    this.dropAfterFlush = true;
    this.disconnectSourceFromWorklet();
    if (kind === 'end') this.socket?.sendControl({ type: 'end', reason: reason as EndReason });
    else this.socket?.sendControl({ type: 'detach', reason: reason as DetachReason });
    debugLog({ kind, reason, droppedAfterFlush: this.droppedAfterFlush, at: Date.now() });
  }

  finish() {
    return this.stop('end', 'finish');
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
    if (this.snap.state === 'testing') {
      this.finishTest(testEndFromClose(code, reason));
      return;
    }
    this.teardownGraph();
    if (code === SENDER_CLOSE.NOT_JOINABLE) {
      this.set({ state: 'ended', message: reason === 'finished' ? null : { kind: 'session_unavailable', reason } });
      setCaptureActive(this.slug, false);
      return;
    }
    if (noRetry) {
      this.set({ state: 'error', error: { kind: 'closed_no_retry', code, reason } });
      setCaptureActive(this.slug, false);
      return;
    }
    if (this.snap.state === 'ending') {
      this.set({ state: 'ended' });
      setCaptureActive(this.slug, false);
      return;
    }
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
    // Nothing leaves the browser without a worklet and a socket; the enabled track only feeds the meter.
    else if (this.source?.kind === 'microphone' && this.source.track.readyState === 'live') this.source.track.enabled = true;
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
