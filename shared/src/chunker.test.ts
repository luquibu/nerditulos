import { describe, expect, it } from 'vitest';
import { Chunker, floatToInt16 } from './chunker.js';

function quanta(total: number, size: number, value = 0.25): Float32Array[] {
  const out: Float32Array[] = [];
  for (let done = 0; done < total; done += size) out.push(new Float32Array(Math.min(size, total - done)).fill(value));
  return out;
}

describe('Chunker', () => {
  it('frames render quanta of any length into 1600-sample chunks tagged with their source position', () => {
    const chunker = new Chunker(1600);
    const chunks = [...quanta(3000, 128), ...quanta(1800, 441)].flatMap((q) => chunker.push(q));
    expect(chunks.map((c) => [c.samplePosition, c.pcm.length])).toEqual([
      [0, 1600],
      [1600, 1600],
      [3200, 1600],
    ]);
    expect(chunker.nextPosition).toBe(4800);
  });

  it('keeps emitted chunks intact when later input arrives', () => {
    const chunker = new Chunker(4);
    const [first] = chunker.push([0.5, 0.5, 0.5, 0.5]);
    chunker.push([-0.5, -0.5, -0.5, -0.5]);
    expect([...first!.pcm]).toEqual([16384, 16384, 16384, 16384]);
  });

  it('flushes the remainder unpadded and keeps positions contiguous across a pause', () => {
    // The pause contract: chunks at 0 and 1600, pause with 800 captured, resume.
    const chunker = new Chunker(1600);
    expect(chunker.push(new Float32Array(4000)).map((c) => c.samplePosition)).toEqual([0, 1600]);
    const remainder = chunker.flush();
    expect(remainder?.samplePosition).toBe(3200);
    expect(remainder?.pcm.length).toBe(800);
    // Paused: nothing is pushed, so the position is frozen.
    expect(chunker.nextPosition).toBe(4000);
    expect(chunker.flush()).toBeNull();
    const [next] = chunker.push(new Float32Array(1600));
    expect(next?.samplePosition).toBe(4000);
  });
});

describe('floatToInt16', () => {
  it('clamps and rounds asymmetrically', () => {
    expect([1, -1, 0, 0.5, -0.5, 2, -2].map(floatToInt16)).toEqual([32767, -32768, 0, 16384, -16384, 32767, -32768]);
  });
});
