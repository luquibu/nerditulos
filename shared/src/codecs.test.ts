import { describe, expect, it } from 'vitest';
import { encodeCursor, parseCursor } from './cursor.js';
import { decodeFrame, encodeFrame, FRAME_HEADER_BYTES, FRAME_MAX_BYTES } from './frame.js';

describe('cursor codec', () => {
  it('round-trips', () => {
    const cursor = { sessionId: '6f1c2c3a-0000-4000-8000-000000000001', outputType: 'translation' as const, language: 'es', seq: 42 };
    expect(parseCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects garbage', () => {
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor('')).toBeNull();
    expect(parseCursor('a:b:c')).toBeNull();
    expect(parseCursor('a:b:c:d:e')).toBeNull();
    expect(parseCursor('s:audio:es:1')).toBeNull();
    expect(parseCursor('s:original:es:-1')).toBeNull();
    expect(parseCursor('s:original:es:1.5')).toBeNull();
    expect(parseCursor('s:original::1')).toBeNull();
    expect(parseCursor(':original:es:1')).toBeNull();
  });
});

describe('frame codec', () => {
  it('round-trips little-endian header and PCM payload', () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768, 1234]);
    const bytes = new Uint8Array(encodeFrame(7, 1600 * 5, pcm));
    expect(bytes.byteLength).toBe(FRAME_HEADER_BYTES + pcm.byteLength);
    // Explicit little-endian check: seq 7 -> 07 00 00 00.
    expect([...bytes.subarray(0, 4)]).toEqual([7, 0, 0, 0]);
    const decoded = decodeFrame(bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.seq).toBe(7);
    expect(decoded.frame.samplePosition).toBe(8000);
    expect([...decoded.frame.pcm]).toEqual([...pcm]);
  });

  it('decodes from an unaligned view', () => {
    const pcm = new Int16Array([5, -5, 100]);
    const encoded = new Uint8Array(encodeFrame(1, 0, pcm));
    const padded = new Uint8Array(encoded.byteLength + 1);
    padded.set(encoded, 1);
    const decoded = decodeFrame(padded.subarray(1));
    expect(decoded.ok && [...decoded.frame.pcm]).toEqual([5, -5, 100]);
  });

  it('rejects short, odd, oversized, and non-integer positions', () => {
    expect(decodeFrame(new Uint8Array(11))).toEqual({ ok: false, error: 'too_short' });
    expect(decodeFrame(new Uint8Array(13))).toEqual({ ok: false, error: 'odd_payload' });
    expect(decodeFrame(new Uint8Array(FRAME_MAX_BYTES + 2))).toEqual({ ok: false, error: 'oversized' });
    const bad = new Uint8Array(encodeFrame(1, 0, new Int16Array(2)));
    new DataView(bad.buffer).setFloat64(4, 1.5, true);
    expect(decodeFrame(bad)).toEqual({ ok: false, error: 'bad_position' });
    new DataView(bad.buffer).setFloat64(4, -1, true);
    expect(decodeFrame(bad)).toEqual({ ok: false, error: 'bad_position' });
  });
});
