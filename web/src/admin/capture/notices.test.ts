import { describe, expect, it } from 'vitest';
import { consoleStrings } from '../consoleStrings.js';
import { noticeText, type CaptureNotice } from './notices.js';
import { mediaErrorCode, type MediaErrorCode } from './sources.js';

const es = consoleStrings('es');
const en = consoleStrings('en');

describe('noticeText', () => {
  const notices: CaptureNotice[] = [
    { kind: 'media', code: 'permission_denied' },
    { kind: 'audio_context', code: 'not_running' },
    { kind: 'audio_context', code: 'sample_rate' },
    { kind: 'file_decode' },
    { kind: 'file_open' },
    { kind: 'sender_active' },
    { kind: 'connect_failed', reason: 'no-token' },
    { kind: 'waiting_previous' },
    { kind: 'device_lost' },
    { kind: 'mic_gone' },
    { kind: 'mic_muted' },
    { kind: 'rejected', reason: 'room-busy' },
    { kind: 'session_unavailable', reason: 'not-found' },
    { kind: 'closed_no_retry', code: 4410, reason: 'provider-error' },
    { kind: 'send_interrupted', code: 1006, reason: '' },
  ];

  it('has a translated text for every notice', () => {
    for (const notice of notices) {
      const a = noticeText(es, notice);
      const b = noticeText(en, notice);
      expect(a.length, notice.kind).toBeGreaterThan(0);
      expect(b.length, notice.kind).toBeGreaterThan(0);
      expect(a, notice.kind).not.toBe(b);
    }
  });

  it('keeps the server codes and reasons inside the text', () => {
    expect(noticeText(es, { kind: 'rejected', reason: 'room-busy' })).toBe('Rechazado: room-busy');
    expect(noticeText(en, { kind: 'connect_failed', reason: 'sender-active' })).toContain('(sender-active)');
    expect(noticeText(en, { kind: 'closed_no_retry', code: 4410, reason: 'provider-error' })).toContain('4410 provider-error');
    expect(noticeText(es, { kind: 'send_interrupted', code: 1006, reason: 'x' })).toBe('Envío interrumpido (1006 x).');
    expect(noticeText(en, { kind: 'session_unavailable', reason: 'not-found' })).toBe('Session unavailable (not-found).');
  });

  it('names every media error in both languages', () => {
    const codes: MediaErrorCode[] = ['permission_denied', 'no_device', 'device_busy', 'constraints', 'aborted', 'insecure_context', 'unsupported', 'unknown'];
    for (const code of codes) {
      expect(noticeText(es, { kind: 'media', code }), code).toBe(es.mediaError[code]);
      expect(noticeText(en, { kind: 'media', code }), code).toBe(en.mediaError[code]);
    }
  });
});

describe('mediaErrorCode', () => {
  it('maps the exception name to a code', () => {
    expect(mediaErrorCode(new DOMException('denied', 'NotAllowedError'))).toBe('permission_denied');
    expect(mediaErrorCode(new DOMException('none', 'NotFoundError'))).toBe('no_device');
    expect(mediaErrorCode(new DOMException('busy', 'NotReadableError'))).toBe('device_busy');
    expect(mediaErrorCode(new DOMException('gone', 'OverconstrainedError'))).toBe('constraints');
    expect(mediaErrorCode(new DOMException('stop', 'AbortError'))).toBe('aborted');
    expect(mediaErrorCode(new DOMException('http', 'SecurityError'))).toBe('insecure_context');
    expect(mediaErrorCode(new TypeError('getUserMedia unavailable'))).toBe('unsupported');
    expect(mediaErrorCode(new Error('other'))).toBe('unknown');
    expect(mediaErrorCode('string')).toBe('unknown');
  });
});
