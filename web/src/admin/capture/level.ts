// Level metering, pure: samples in, meter state out. The runtime feeds it from an AnalyserNode.
import type { CheckState } from './viewModel.js';

export const LEVEL_INTERVAL_MS = 100;
/** RMS below which a block counts as silence (about -48 dBFS). */
export const NO_SIGNAL_RMS = 0.004;
export const NO_SIGNAL_MS = 3000;
export const CLIP_PEAK = 0.99;
export const CLIP_HOLD_MS = 1000;
export const PEAK_HOLD_MS = 1000;
export const METER_FLOOR_DBFS = -60;

export interface LevelSample {
  rms: number;
  peak: number;
}

export interface LevelState {
  level: number;
  peak: number;
  peakAt: number;
  clipping: boolean;
  clipAt: number;
  /** Time of the last block at or above `NO_SIGNAL_RMS`; -Infinity until one is seen. */
  lastSignalAt: number;
}

export function initialLevel(): LevelState {
  return { level: 0, peak: 0, peakAt: -Infinity, clipping: false, clipAt: -Infinity, lastSignalAt: -Infinity };
}

/** RMS and absolute peak of a block of float samples in [-1, 1]. */
export function measure(samples: Float32Array): LevelSample {
  if (samples.length === 0) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] as number;
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sum / samples.length), peak };
}

export function toDbfs(value: number): number {
  return value <= 0 ? -Infinity : 20 * Math.log10(value);
}

/** Position of a dBFS value on a meter from `floor` to 0, in [0, 1]. */
export function meterFraction(dbfs: number, floor: number = METER_FLOOR_DBFS): number {
  if (!Number.isFinite(dbfs)) return dbfs > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, (dbfs - floor) / -floor));
}

export function formatDbfs(dbfs: number): string {
  if (!Number.isFinite(dbfs)) return '−∞ dBFS';
  const rounded = Math.round(dbfs);
  return `${rounded < 0 ? '−' : ''}${Math.abs(rounded)} dBFS`;
}

export function reduceLevel(prev: LevelState, sample: LevelSample, now: number): LevelState {
  const holdPeak = sample.peak < prev.peak && now - prev.peakAt < PEAK_HOLD_MS;
  const clippingNow = sample.peak >= CLIP_PEAK;
  return {
    level: sample.rms,
    peak: holdPeak ? prev.peak : sample.peak,
    peakAt: holdPeak ? prev.peakAt : now,
    clipping: clippingNow || (prev.clipping && now - prev.clipAt < CLIP_HOLD_MS),
    clipAt: clippingNow ? now : prev.clipAt,
    lastSignalAt: sample.rms >= NO_SIGNAL_RMS ? now : prev.lastSignalAt,
  };
}

/** Signal check for a live source: the first silent 3 s after it went live are pending, not a warning. */
export function signalCheck(state: LevelState, liveSince: number, now: number): Extract<CheckState, 'ok' | 'warning' | 'pending'> {
  if (state.lastSignalAt >= liveSince) return now - state.lastSignalAt < NO_SIGNAL_MS ? 'ok' : 'warning';
  return now - liveSince < NO_SIGNAL_MS ? 'pending' : 'warning';
}
