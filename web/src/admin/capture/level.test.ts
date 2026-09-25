import { describe, expect, it } from 'vitest';
import { formatDbfs, initialLevel, measure, meterFraction, reduceLevel, signalCheck, toDbfs } from './level.js';

const block = (fill: (i: number) => number, n = 2048) => Float32Array.from({ length: n }, (_, i) => fill(i));

describe('measure', () => {
  it('reports zero for silence, full scale for a square wave, and 0.5/√2 for a half-scale sine', () => {
    expect(measure(block(() => 0))).toEqual({ rms: 0, peak: 0 });
    expect(measure(new Float32Array(0))).toEqual({ rms: 0, peak: 0 });
    expect(measure(block((i) => (i % 2 === 0 ? 1 : -1)))).toEqual({ rms: 1, peak: 1 });
    const sine = measure(block((i) => 0.5 * Math.sin((2 * Math.PI * i * 8) / 2048)));
    expect(sine.rms).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(sine.peak).toBeCloseTo(0.5, 3);
  });
});

describe('dBFS helpers', () => {
  it('converts, places on the meter, and formats', () => {
    expect(toDbfs(1)).toBe(0);
    expect(toDbfs(0.5)).toBeCloseTo(-6.02, 2);
    expect(toDbfs(0)).toBe(-Infinity);
    expect(meterFraction(0)).toBe(1);
    expect(meterFraction(-60)).toBe(0);
    expect(meterFraction(-30)).toBe(0.5);
    expect(meterFraction(-90)).toBe(0);
    expect(meterFraction(6)).toBe(1);
    expect(meterFraction(-Infinity)).toBe(0);
    expect(meterFraction(-20, -40)).toBe(0.5);
    expect(formatDbfs(-Infinity)).toBe('−∞ dBFS');
    expect(formatDbfs(-23.4)).toBe('−23 dBFS');
    expect(formatDbfs(-0.2)).toBe('0 dBFS');
    expect(formatDbfs(0)).toBe('0 dBFS');
  });
});

describe('reduceLevel', () => {
  it('holds clipping for one second after the last clipped block', () => {
    let s = reduceLevel(initialLevel(), { rms: 0.7, peak: 1 }, 1000);
    expect(s.clipping).toBe(true);
    s = reduceLevel(s, { rms: 0.1, peak: 0.2 }, 1900);
    expect(s.clipping).toBe(true);
    s = reduceLevel(s, { rms: 0.1, peak: 0.2 }, 2000);
    expect(s.clipping).toBe(false);
    s = reduceLevel(s, { rms: 0.1, peak: 0.99 }, 2100);
    expect(s.clipping).toBe(true);
  });

  it('holds the peak for one second, unless a higher peak arrives', () => {
    let s = reduceLevel(initialLevel(), { rms: 0.3, peak: 0.6 }, 1000);
    s = reduceLevel(s, { rms: 0.1, peak: 0.2 }, 1500);
    expect(s.peak).toBe(0.6);
    expect(s.level).toBe(0.1);
    s = reduceLevel(s, { rms: 0.1, peak: 0.8 }, 1600);
    expect(s.peak).toBe(0.8);
    s = reduceLevel(s, { rms: 0.1, peak: 0.2 }, 2600);
    expect(s.peak).toBe(0.2);
  });

  it('records signal only from blocks at or above the silence threshold', () => {
    let s = reduceLevel(initialLevel(), { rms: 0.0039, peak: 0.01 }, 1000);
    expect(s.lastSignalAt).toBe(-Infinity);
    s = reduceLevel(s, { rms: 0.004, peak: 0.01 }, 1100);
    expect(s.lastSignalAt).toBe(1100);
    s = reduceLevel(s, { rms: 0, peak: 0 }, 1200);
    expect(s.lastSignalAt).toBe(1100);
  });
});

describe('signalCheck', () => {
  it('is pending for the first three silent seconds, then a warning, and ok after signal', () => {
    const silent = initialLevel();
    expect(signalCheck(silent, 1000, 3900)).toBe('pending');
    expect(signalCheck(silent, 1000, 4000)).toBe('warning');
    const heard = reduceLevel(silent, { rms: 0.1, peak: 0.2 }, 4500);
    expect(signalCheck(heard, 1000, 4600)).toBe('ok');
    expect(signalCheck(heard, 1000, 7499)).toBe('ok');
    expect(signalCheck(heard, 1000, 7500)).toBe('warning');
    // Signal heard before the source went live does not count.
    expect(signalCheck(heard, 5000, 5100)).toBe('pending');
  });
});
