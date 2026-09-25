// Level meter tap: source -> analyser -> sink, sampled on a timer. Independent of the frame path,
// so the meter runs whenever a source is attached, with or without a socket.
import { LEVEL_INTERVAL_MS, measure, type LevelSample } from './level.js';

export class LevelMonitor {
  private readonly analyser: AnalyserNode;
  private readonly buffer: Float32Array<ArrayBuffer>;
  private source: AudioNode | null = null;
  private timer: number | null = null;

  constructor(
    context: AudioContext,
    private readonly onSample: (sample: LevelSample, now: number) => void,
  ) {
    this.analyser = new AnalyserNode(context, { fftSize: 2048 });
    this.buffer = new Float32Array(this.analyser.fftSize);
  }

  attach(source: AudioNode, sink: AudioNode) {
    this.detach();
    source.connect(this.analyser);
    this.analyser.connect(sink);
    this.source = source;
    this.timer = window.setInterval(() => {
      this.analyser.getFloatTimeDomainData(this.buffer);
      this.onSample(measure(this.buffer), performance.now());
    }, LEVEL_INTERVAL_MS);
  }

  detach() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    try {
      this.source?.disconnect(this.analyser);
    } catch {
      // already disconnected
    }
    try {
      this.analyser.disconnect();
    } catch {
      // already disconnected
    }
    this.source = null;
  }
}
