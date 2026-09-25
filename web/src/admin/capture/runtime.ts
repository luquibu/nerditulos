// Module-scope capture runtime keyed by room. One shared AudioContext; per room a source, a worklet
// node, a silent gain, and a sender socket. It survives React re-renders, route changes, and
// StrictMode double mounts. Created on the first user action.
import { AUDIO_SAMPLE_RATE, SENDER_CLOSE, type DetachReason, type DiscontinuityDetail, type EndReason, type InterruptionCause, type SessionState } from '@nerditulos/shared';
import processorUrl from './captureProcessor.ts?worker&url';
import { getAdminToken, setCaptureActive } from './registry.js';
import { SenderSocket } from './senderSocket.js';
import { listMicrophones, mapMediaError, openFile, releaseSource, requestMicrophone, rms, type CaptureSource, type DeviceOption, type SourceKind } from './sources.js';
import type { CaptureState, CheckState } from './viewModel.js';

export interface CaptureSnapshot {
  slug: string;
  sessionId: string | null;
  state: CaptureState;
  sourceKind: SourceKind | null;
  sourceLabel: string | null;
  devices: DeviceOption[];
  selectedDeviceId: string | null;
  checks: { permission: CheckState; device: CheckState; signal: CheckState; receipt: CheckState };
  level: number;
  noSignal: boolean;
  epoch: number | null;
  lastAck: { seq: number; samplePosition: number; receivedAt: number } | null;
  framesSent: number;
  framesDropped: number;
  error: string | null;
  message: string | null;
  sessionState: SessionState | null;
  cause: InterruptionCause | null;
  completeness: 'complete' | 'incomplete' | null;
  discontinuities: number;
  file: { currentTime: number; duration: number } | null;
  paused: boolean;
}

type Listener = () => void;

const NO_SIGNAL_RMS = 0.004;
const NO_SIGNAL_MS = 3000;

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

class RoomCapture {
  private snap: CaptureSnapshot;
  private readonly listeners = new Set<Listener>();
  private source: CaptureSource | null = null;
  private worklet: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private socket: SenderSocket | null = null;
  private seq = 0;
  private dropAfterFlush = false;
  private droppedAfterFlush = 0;
  private lastSignalAt = 0;
  private signalTimer: number | null = null;
  private flushWaiters: Array<() => void> = [];
  private connectedToWorklet = false;
  private progressTimer: number | null = null;

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
      noSignal: false,
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
    this.set({ state: 'checking', error: null, message: null });
    try {
      const ctx = await ensureContext();
      this.releaseCurrentSource();
      const source = await requestMicrophone(ctx, deviceId);
      this.source = source;
      source.track.onended = () => this.onDeviceLost();
      source.track.onmute = () => this.set({ message: 'Sin señal: el micrófono está silenciado por el sistema.' });
      source.track.onunmute = () => this.set({ message: null });
      const label = source.track.label || 'Micrófono';
      this.set({
        sourceKind: 'microphone',
        sourceLabel: label,
        selectedDeviceId: source.settings.deviceId ?? deviceId ?? null,
        state: 'ready',
        checks: { permission: 'ok', device: 'ok', signal: 'pending', receipt: 'pending' },
        file: null,
      });
      debugLog({ kind: 'source', source: 'microphone', settings: source.settings });
      await this.refreshDevices();
    } catch (error) {
      const mapped = error instanceof Error && error.message.startsWith('audio_context') ? { code: error.message, message: error.message === 'audio_context_sample_rate' ? 'El navegador no permite capturar a 16 kHz.' : 'El contexto de audio no se pudo activar. Hacé clic de nuevo.' } : mapMediaError(error);
      this.set({
        state: 'error',
        error: mapped.message,
        checks: { permission: mapped.code === 'permission_denied' ? 'error' : this.snap.checks.permission === 'ok' ? 'ok' : 'pending', device: mapped.code === 'no_device' || mapped.code === 'device_busy' || mapped.code === 'constraints' ? 'error' : 'pending', signal: 'pending', receipt: 'pending' },
      });
    }
  }

  async useFile(file: File) {
    this.set({ state: 'checking', error: null, message: null });
    try {
      const ctx = await ensureContext();
      this.releaseCurrentSource();
      const source = openFile(ctx, file);
      this.source = source;
      source.element.onended = () => void this.stop('end', 'file_end');
      source.element.onerror = () => this.set({ state: 'error', error: 'No se pudo decodificar el archivo de audio.' });
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
        file: { currentTime: 0, duration: source.element.duration },
      });
      debugLog({ kind: 'source', source: 'file', name: file.name, size: file.size, duration: source.element.duration });
    } catch (error) {
      this.set({ state: 'error', error: error instanceof Error && error.message.startsWith('audio_context') ? 'El contexto de audio no se pudo activar.' : 'No se pudo abrir el archivo WAV.' });
    }
  }

  private releaseCurrentSource() {
    if (this.source) releaseSource(this.source);
    this.source = null;
    this.set({ sourceKind: null, sourceLabel: null, file: null });
  }

  // ---- session control ----

  async start(sessionId: string) {
    if (!this.source) throw new Error('no-source');
    if (this.snap.state === 'streaming' || this.snap.state === 'connecting') return;
    this.set({ sessionId, state: 'connecting', error: null, message: null, epoch: null, lastAck: null, discontinuities: 0, paused: false });
    setCaptureActive(this.slug, true);
    const ctx = await ensureContext();
    try {
      await this.openSocket(sessionId);
    } catch (error) {
      // The rejected socket's close event must not overwrite the state set here.
      this.socket = null;
      const reason = error instanceof Error ? error.message : 'error';
      if (reason.includes('generation-draining')) {
        this.set({ state: 'waiting', message: 'Esperando cierre de la conexión anterior' });
        window.setTimeout(() => void this.start(sessionId), 1500);
        return;
      }
      if (reason.includes('sender-active')) {
        this.set({ state: 'error', error: 'Otra fuente ya está enviando audio a esta sesión. No se reemplaza la fuente activa.' });
        setCaptureActive(this.slug, false);
        return;
      }
      this.set({ state: 'error', error: `No se pudo conectar el envío de audio (${reason}).` });
      setCaptureActive(this.slug, false);
      return;
    }
    // Order: context -> module -> socket ready -> start tracks / play.
    this.seq = 0;
    this.dropAfterFlush = false;
    const worklet = new AudioWorkletNode(ctx, 'nerditulos-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    worklet.port.onmessage = (event: MessageEvent) => this.onWorkletMessage(event.data as { type: string; samplePosition?: number; pcm?: Int16Array });
    const gain = this.gain ?? ctx.createGain();
    gain.gain.value = 0;
    this.gain = gain;
    worklet.connect(gain);
    gain.connect(ctx.destination);
    this.worklet = worklet;
    this.connectSourceToWorklet();
    if (this.source.kind === 'microphone') this.source.track.enabled = true;
    else {
      await this.source.element.play();
      this.startProgress();
    }
    this.lastSignalAt = performance.now();
    this.startSignalWatch();
    this.set({ state: 'streaming', paused: false });
  }

  private async openSocket(sessionId: string) {
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/sender`;
    const socket = new SenderSocket({
      url,
      sessionId,
      getToken: (o) => getAdminToken(o),
      debug: debugEnabled() ? (line) => debugLog(line) : undefined,
      events: {
        onReady: (epoch) => this.set({ epoch }),
        onRejected: (reason) => this.set({ message: `Rechazado: ${reason}` }),
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
        onClose: (code, reason, noRetry) => {
          if (this.socket === socket) this.onSocketClosed(code, reason, noRetry);
        },
      },
    });
    this.socket = socket;
    await socket.connect();
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
    const level = rms(pcm);
    if (level >= NO_SIGNAL_RMS) this.lastSignalAt = performance.now();
    const socket = this.socket;
    const seq = this.seq++;
    const sent = socket ? socket.sendFrame(seq, data.samplePosition, pcm) : false;
    const sourceTime = this.source?.kind === 'file' ? this.source.element.currentTime : undefined;
    if (debugEnabled()) debugLog({ kind: 'chunk', seq, samplePosition: data.samplePosition, samples: pcm.length, sent, sourceTime, sentAt: Date.now(), perfNow: performance.now(), buffered: socket?.bufferedAmount ?? 0 });
    if (seq % 5 === 0 || !sent) {
      this.set({ level, framesSent: socket?.counters.framesSent ?? this.snap.framesSent, framesDropped: (socket?.counters.framesDroppedCongestion ?? 0) + this.droppedAfterFlush });
    }
  }

  private startSignalWatch() {
    this.stopSignalWatch();
    this.signalTimer = window.setInterval(() => {
      if (this.snap.state !== 'streaming') return;
      const silent = performance.now() - this.lastSignalAt >= NO_SIGNAL_MS;
      if (silent !== this.snap.noSignal) this.set({ noSignal: silent });
      const check: CheckState = silent ? 'warning' : 'ok';
      if (this.snap.checks.signal !== check) this.setCheck('signal', check);
    }, 500);
  }

  private stopSignalWatch() {
    if (this.signalTimer !== null) window.clearInterval(this.signalTimer);
    this.signalTimer = null;
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
    this.lastSignalAt = performance.now();
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
    if (this.snap.state === 'ending' || this.snap.state === 'ended' || this.snap.state === 'idle' || this.snap.state === 'ready') return;
    this.set({ state: 'ending' });
    this.stopSignalWatch();
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

  private onDeviceLost() {
    if (this.snap.state === 'streaming' || this.snap.state === 'paused') {
      void this.stop('detach', 'device_lost').then(() => {
        this.set({ checks: { ...this.snap.checks, device: 'error' }, error: 'Se perdió el dispositivo de audio.' });
      });
    } else {
      this.set({ checks: { ...this.snap.checks, device: 'error' }, error: 'Se perdió el dispositivo de audio.', state: 'error' });
    }
  }

  private onSocketClosed(code: number, reason: string, noRetry: boolean) {
    debugLog({ kind: 'socket_close', code, reason, at: Date.now() });
    this.teardownGraph();
    if (code === SENDER_CLOSE.NOT_JOINABLE) {
      this.set({ state: 'ended', message: reason === 'finished' ? null : `Sesión no disponible (${reason}).` });
      setCaptureActive(this.slug, false);
      return;
    }
    if (noRetry) {
      this.set({ state: 'error', error: `Conexión cerrada por el servidor (${code} ${reason}). No se reintenta.` });
      setCaptureActive(this.slug, false);
      return;
    }
    if (this.snap.state === 'ending') {
      this.set({ state: 'ended' });
      setCaptureActive(this.slug, false);
      return;
    }
    this.set({ state: 'interrupted', message: `Envío interrumpido (${code} ${reason}).` });
    setCaptureActive(this.slug, false);
  }

  private teardownGraph() {
    this.stopSignalWatch();
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
      this.set({ error: 'El micrófono anterior ya no está disponible. Elegí una fuente de nuevo.' });
      return;
    }
    this.teardownGraph();
    await this.start(this.snap.sessionId);
  }

  reset() {
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
