// AudioWorklet processor: reads channel 0 of its single input, converts Float32 to Int16,
// and posts 1600-sample chunks tagged with their source position. Served as a separate asset.
import { CHUNK_SAMPLES, Chunker } from '@nerditulos/shared';

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor & { process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean },
): void;

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly chunker = new Chunker(CHUNK_SAMPLES);
  private quantaSeen = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      if (data?.type === 'flush') {
        const rest = this.chunker.flush();
        if (rest) this.port.postMessage({ type: 'chunk', samplePosition: rest.samplePosition, pcm: rest.pcm }, [rest.pcm.buffer]);
        this.port.postMessage({ type: 'flushed', nextPosition: this.chunker.nextPosition });
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;
    this.quantaSeen++;
    for (const chunk of this.chunker.push(channel)) {
      this.port.postMessage({ type: 'chunk', samplePosition: chunk.samplePosition, pcm: chunk.pcm }, [chunk.pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('nerditulos-capture', CaptureProcessor);
