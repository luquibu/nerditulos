// Source-test preview state, pure: what the server recognized, why the test ended, and the tone and
// text (from the strings table) the console shows for each ending.
import { SENDER_CLOSE, type SourceTestEndReason } from '@nerditulos/shared';
import type { ConsoleStrings } from '../consoleStrings.js';

export type PreviewEndReason = SourceTestEndReason | 'file_end' | 'device_lost' | 'source_changed' | 'test_active' | 'room_busy' | 'auth' | 'connection_lost' | 'connect_failed';

export interface PreviewState {
  /** Finalized text, trimmed from the start at a word boundary past `PREVIEW_MAX_CHARS`. */
  text: string;
  partial: string;
  state: 'connecting' | 'listening' | 'ended';
  endedReason: PreviewEndReason | null;
}

export const PREVIEW_MAX_CHARS = 600;

export function emptyPreview(state: PreviewState['state'] = 'connecting'): PreviewState {
  return { text: '', partial: '', state, endedReason: null };
}

/** Appends a preview message: finals concatenate as sent (no spaces inserted), the partial replaces the previous one. */
export function appendPreview(prev: PreviewState, message: { final: string; partial: string }, max: number = PREVIEW_MAX_CHARS): PreviewState {
  let text = prev.text + message.final;
  if (text.length > max) {
    const from = text.length - max;
    const boundary = text.indexOf(' ', from);
    text = boundary >= 0 ? text.slice(boundary + 1) : text.slice(from);
  }
  return { ...prev, text, partial: message.partial };
}

/** Why a test socket closed without a `test ended` message. */
export function testEndFromClose(code: number, reason: string): PreviewEndReason {
  if (code === SENDER_CLOSE.DETACHED) {
    switch (reason) {
      case 'provider-error':
        return 'provider_error';
      case 'provider-closed':
        return 'provider_closed';
      case 'time-limit':
        return 'time_limit';
      case 'session-started':
        return 'session_started';
      default:
        return 'connection_lost';
    }
  }
  if (code === SENDER_CLOSE.UNAUTHENTICATED || code === SENDER_CLOSE.FORBIDDEN) return 'auth';
  if (code === SENDER_CLOSE.SENDER_ACTIVE) {
    if (reason === 'room-busy') return 'room_busy';
    if (reason === 'test-active') return 'test_active';
  }
  return 'connection_lost';
}

/** Why `connect()` rejected: `rejected:<reason>`, `closed:<code>:<reason>`, `no-token`, or `socket-error`. */
export function testEndFromConnectError(message: string): PreviewEndReason {
  if (message.startsWith('rejected:')) {
    const reason = message.slice('rejected:'.length);
    if (reason === 'room-busy') return 'room_busy';
    if (reason === 'test-active') return 'test_active';
    if (reason === 'unauthenticated' || reason === 'forbidden' || reason === 'admin-not-configured') return 'auth';
    return 'connect_failed';
  }
  if (message.startsWith('closed:')) {
    const [, code, reason = ''] = message.split(':', 3);
    const mapped = testEndFromClose(Number(code), reason);
    return mapped === 'connection_lost' ? 'connect_failed' : mapped;
  }
  if (message === 'no-token') return 'auth';
  return 'connect_failed';
}

export function testEndMessage(d: ConsoleStrings, reason: PreviewEndReason): { text: string; tone: 'ok' | 'warning' | 'error' } | null {
  if (reason === 'source_changed') return null;
  return { text: d.testEnd[reason], tone: testEndTone(reason) };
}

/** The tone does not depend on the language: routine endings are ok, server limits warn, failures err. */
function testEndTone(reason: Exclude<PreviewEndReason, 'source_changed'>): 'ok' | 'warning' | 'error' {
  switch (reason) {
    case 'stopped':
    case 'file_end':
    case 'session_started':
      return 'ok';
    case 'time_limit':
    case 'provider_closed':
    case 'room_busy':
    case 'test_active':
      return 'warning';
    case 'provider_error':
    case 'device_lost':
    case 'auth':
    case 'connection_lost':
    case 'connect_failed':
      return 'error';
  }
}
