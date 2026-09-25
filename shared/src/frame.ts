// Binary audio frame: [uint32 seq LE][float64 samplePosition LE] + PCM16LE payload.
export const FRAME_HEADER_BYTES = 12;
export const FRAME_MAX_BYTES = 64 * 1024;

export interface AudioFrame {
  seq: number;
  samplePosition: number;
  pcm: Int16Array;
}

export function encodeFrame(seq: number, samplePosition: number, pcm: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + pcm.length * 2);
  const view = new DataView(buffer);
  view.setUint32(0, seq >>> 0, true);
  view.setFloat64(4, samplePosition, true);
  const body = new Uint8Array(buffer, FRAME_HEADER_BYTES);
  body.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  return buffer;
}

export type FrameDecodeError = 'too_short' | 'odd_payload' | 'oversized' | 'bad_position';

export function decodeFrame(
  data: Uint8Array,
): { ok: true; frame: AudioFrame } | { ok: false; error: FrameDecodeError } {
  if (data.byteLength > FRAME_MAX_BYTES) return { ok: false, error: 'oversized' };
  if (data.byteLength < FRAME_HEADER_BYTES) return { ok: false, error: 'too_short' };
  const payloadBytes = data.byteLength - FRAME_HEADER_BYTES;
  if (payloadBytes % 2 !== 0) return { ok: false, error: 'odd_payload' };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const seq = view.getUint32(0, true);
  const samplePosition = view.getFloat64(4, true);
  if (!Number.isFinite(samplePosition) || samplePosition < 0 || !Number.isInteger(samplePosition)) {
    return { ok: false, error: 'bad_position' };
  }
  // Copy so the Int16Array is aligned regardless of the source offset.
  const copy = new Uint8Array(payloadBytes);
  copy.set(data.subarray(FRAME_HEADER_BYTES));
  const pcm = new Int16Array(copy.buffer, 0, payloadBytes / 2);
  return { ok: true, frame: { seq, samplePosition, pcm } };
}
