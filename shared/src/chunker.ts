import { CHUNK_SAMPLES } from './protocol.js';

export interface Chunk {
  samplePosition: number;
  pcm: Int16Array;
}

/** Float32 [-1, 1] to Int16 with clamping and rounding. */
export function floatToInt16(sample: number): number {
  const s = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return Math.round(s < 0 ? s * 32768 : s * 32767);
}

/**
 * Pure chunker: accepts render quanta of any length and emits fixed-size PCM16 chunks
 * tagged with the source position (in samples) of their first sample. `flush()` emits the
 * remainder unpadded. Positions keep advancing across chunks; the caller freezes the
 * chunker by simply not pushing input.
 */
export class Chunker {
  private buffer: Int16Array;
  private filled = 0;
  private position = 0;
  private readonly size: number;

  constructor(chunkSamples: number = CHUNK_SAMPLES) {
    this.size = chunkSamples;
    this.buffer = new Int16Array(chunkSamples);
  }

  /** Source position of the next sample that will be pushed. */
  get nextPosition(): number {
    return this.position + this.filled;
  }

  push(input: ArrayLike<number>): Chunk[] {
    const out: Chunk[] = [];
    for (let i = 0; i < input.length; i++) {
      this.buffer[this.filled++] = floatToInt16(input[i] as number);
      if (this.filled === this.size) {
        out.push({ samplePosition: this.position, pcm: this.buffer });
        this.position += this.size;
        this.buffer = new Int16Array(this.size);
        this.filled = 0;
      }
    }
    return out;
  }

  flush(): Chunk | null {
    if (this.filled === 0) return null;
    const pcm = this.buffer.subarray(0, this.filled).slice();
    const chunk = { samplePosition: this.position, pcm };
    this.position += this.filled;
    this.buffer = new Int16Array(this.size);
    this.filled = 0;
    return chunk;
  }
}
