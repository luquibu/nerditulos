// Notices the capture runtime records as codes, so the console renders them in the current interface
// language and a message already on screen follows a language change. Pure.
import type { ConsoleStrings } from '../consoleStrings.js';
import type { MediaErrorCode } from './sources.js';

export type CaptureNotice =
  | { kind: 'media'; code: MediaErrorCode }
  | { kind: 'audio_context'; code: 'not_running' | 'sample_rate' }
  | { kind: 'file_decode' }
  | { kind: 'file_open' }
  | { kind: 'sender_active' }
  | { kind: 'connect_failed'; reason: string }
  | { kind: 'waiting_previous' }
  | { kind: 'device_lost' }
  | { kind: 'mic_gone' }
  | { kind: 'mic_muted' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'session_unavailable'; reason: string }
  | { kind: 'closed_no_retry'; code: number; reason: string }
  | { kind: 'send_interrupted'; code: number; reason: string };

export function noticeText(d: ConsoleStrings, notice: CaptureNotice): string {
  switch (notice.kind) {
    case 'media':
      return d.mediaError[notice.code];
    case 'audio_context':
      return notice.code === 'sample_rate' ? d.audioContextSampleRate : d.audioContextNotRunning;
    case 'file_decode':
      return d.fileDecodeFailed;
    case 'file_open':
      return d.fileOpenFailed;
    case 'sender_active':
      return d.senderActive;
    case 'connect_failed':
      return d.connectFailed(notice.reason);
    case 'waiting_previous':
      return d.chipWaitingPrevious;
    case 'device_lost':
      return d.deviceLost;
    case 'mic_gone':
      return d.microphoneGone;
    case 'mic_muted':
      return d.microphoneMuted;
    case 'rejected':
      return d.rejected(notice.reason);
    case 'session_unavailable':
      return d.sessionUnavailable(notice.reason);
    case 'closed_no_retry':
      return d.closedNoRetry(notice.code, notice.reason);
    case 'send_interrupted':
      return d.sendInterrupted(notice.code, notice.reason);
  }
}
