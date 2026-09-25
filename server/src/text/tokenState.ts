import type { OutputType } from '@nerditulos/shared';
import type { SonioxResponse, SonioxToken } from '../provider/soniox.js';

// Soniox sends each final token once and replaces the whole non-final suffix on every response.
// https://soniox.com/docs/translation/stt-translation/rt-translation

export const isControlToken = (token: SonioxToken): boolean => /^<[^>]+>$/.test(token.text ?? '');

/** Routing by `translation_status` only; `language` and friends are metadata. */
export const outputOf = (token: SonioxToken): OutputType => (token.translation_status === 'translation' ? 'translation' : 'original');

export interface FinalPart {
  segmentSeq: number;
  text: string;
  tokens: SonioxToken[];
}

export interface StreamOutput {
  finals: FinalPart[];
  partial: { segmentSeq: number; text: string };
  /** A previously non-empty partial was cleared because this response carried none for the stream. */
  partialCleared: boolean;
}

export interface ResponseStats {
  controlTokens: number;
  endTokens: number;
  noneTokens: number;
  finalTokens: number;
  nonFinalTokens: number;
  droppedUnroutable: number;
}

interface StreamState {
  segmentSeq: number;
  segmentChars: number;
  pendingNewSegment: boolean;
  softSplitPending: boolean;
  lastTokenPunctuationOnly: boolean;
  lastPartialText: string;
}

const PUNCTUATION_ONLY = /^[\s\p{P}]+$/u;

export class TokenState {
  private readonly streams = new Map<OutputType, StreamState>();
  private readonly segmentMaxChars: number;

  constructor(opts: { segmentMaxChars: number; outputs: OutputType[]; initialSegmentSeq?: Partial<Record<OutputType, number>> }) {
    this.segmentMaxChars = opts.segmentMaxChars;
    for (const output of opts.outputs) {
      this.streams.set(output, {
        segmentSeq: opts.initialSegmentSeq?.[output] ?? 0,
        segmentChars: 0,
        // A stream with no segment yet opens its first one with its first final.
        pendingNewSegment: true,
        softSplitPending: false,
        lastTokenPunctuationOnly: false,
        lastPartialText: '',
      });
    }
  }

  outputs(): OutputType[] {
    return [...this.streams.keys()];
  }

  currentSegmentSeq(output: OutputType): number {
    return this.streams.get(output)?.segmentSeq ?? 0;
  }

  /** Lazy flag on both streams: the next final of each stream opens a new segment. */
  openNewSegment(): void {
    for (const s of this.streams.values()) s.pendingNewSegment = true;
  }

  /** Dangling flags at session end are dropped so no empty segment is ever created. */
  dropPendingFlags(): void {
    for (const s of this.streams.values()) {
      s.pendingNewSegment = false;
      s.softSplitPending = false;
    }
  }

  accept(response: SonioxResponse): { streams: Map<OutputType, StreamOutput>; stats: ResponseStats } {
    const stats: ResponseStats = { controlTokens: 0, endTokens: 0, noneTokens: 0, finalTokens: 0, nonFinalTokens: 0, droppedUnroutable: 0 };
    const parts = new Map<OutputType, FinalPart[]>();
    const partials = new Map<OutputType, string>();
    for (const output of this.streams.keys()) {
      parts.set(output, []);
      partials.set(output, '');
    }
    for (const token of response.tokens ?? []) {
      if (isControlToken(token)) {
        stats.controlTokens++;
        if (token.text === '<end>' && token.is_final === true) {
          stats.endTokens++;
          this.openNewSegment();
        }
        continue;
      }
      if (token.translation_status === 'none') stats.noneTokens++;
      const output = outputOf(token);
      const stream = this.streams.get(output);
      if (!stream) {
        stats.droppedUnroutable++;
        continue;
      }
      if (token.is_final === true) {
        stats.finalTokens++;
        this.appendFinal(stream, parts.get(output) as FinalPart[], token);
      } else if (!response.finished) {
        stats.nonFinalTokens++;
        partials.set(output, (partials.get(output) ?? '') + token.text);
      }
    }
    const streams = new Map<OutputType, StreamOutput>();
    for (const [output, stream] of this.streams) {
      const text = partials.get(output) ?? '';
      const partialCleared = text.length === 0 && stream.lastPartialText.length > 0;
      stream.lastPartialText = text;
      streams.set(output, {
        finals: parts.get(output) ?? [],
        partial: { segmentSeq: stream.pendingNewSegment ? stream.segmentSeq + 1 : stream.segmentSeq, text },
        partialCleared,
      });
    }
    return { streams, stats };
  }

  private appendFinal(stream: StreamState, parts: FinalPart[], token: SonioxToken) {
    const text = token.text ?? '';
    const startsWithWhitespace = /^\s/.test(text);
    let open = stream.pendingNewSegment;
    if (!open && stream.softSplitPending && (startsWithWhitespace || stream.lastTokenPunctuationOnly)) open = true;
    if (!open && stream.segmentChars >= this.segmentMaxChars * 2) open = true;
    if (open) {
      stream.segmentSeq += 1;
      stream.segmentChars = 0;
      stream.pendingNewSegment = false;
      stream.softSplitPending = false;
    }
    const last = parts[parts.length - 1];
    if (last && last.segmentSeq === stream.segmentSeq) {
      last.text += text;
      last.tokens.push(token);
    } else {
      parts.push({ segmentSeq: stream.segmentSeq, text, tokens: [token] });
    }
    stream.segmentChars += text.length;
    stream.lastTokenPunctuationOnly = PUNCTUATION_ONLY.test(text) && text.trim().length > 0;
    if (stream.segmentChars >= this.segmentMaxChars) stream.softSplitPending = true;
  }
}
