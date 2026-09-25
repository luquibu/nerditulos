import { AUDIO_SAMPLE_RATE } from '@nerditulos/shared';
import type { CaptionSegment } from './useCaptionStream.js';

export function Caption({
  segments,
  partial,
  lang,
  describeGap,
}: {
  segments: CaptionSegment[];
  partial: { segmentSeq: number; text: string };
  lang: string;
  /** Tooltip for a lost stretch, given its length in seconds (formatted) or null when unknown. */
  describeGap: (seconds: string | null) => string;
}) {
  const partialInLast = segments.length > 0 && segments[segments.length - 1]?.segmentSeq === partial.segmentSeq;
  return (
    <div className="caption" lang={lang} aria-live="off">
      {segments.map((seg, index) => {
        const isLast = index === segments.length - 1;
        return (
          <span className="caption__line" key={seg.segmentSeq} data-segment={seg.segmentSeq}>
            {seg.rows.map((row) => (
              <span key={row.seq}>{row.text}</span>
            ))}
            {isLast && partialInLast && partial.text && <span className="caption__segment--provisional">{partial.text}</span>}
            {seg.gapAfter && (
              <span className="caption__gap" title={describeGap(seg.gapAfter.extent === 'unknown' ? null : (seg.gapAfter.extent / AUDIO_SAMPLE_RATE).toFixed(1))}>
                {' '}
                […]
              </span>
            )}
          </span>
        );
      })}
      {!partialInLast && partial.text && (
        <span className="caption__line caption__segment--provisional" data-segment={partial.segmentSeq}>
          {partial.text}
        </span>
      )}
    </div>
  );
}
