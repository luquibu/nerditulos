import { describe, expect, it } from 'vitest';
import { consoleStrings } from '../consoleStrings.js';
import { appendPreview, emptyPreview, testEndFromClose, testEndFromConnectError, testEndMessage, type PreviewEndReason } from './preview.js';

const es = consoleStrings('es');
const en = consoleStrings('en');

describe('appendPreview', () => {
  it('concatenates finals as sent and replaces the partial', () => {
    let p = appendPreview(emptyPreview('listening'), { final: 'Hola', partial: ' mun' });
    expect(p).toMatchObject({ text: 'Hola', partial: ' mun', state: 'listening' });
    p = appendPreview(p, { final: '', partial: ' mundo' });
    expect(p).toMatchObject({ text: 'Hola', partial: ' mundo' });
    p = appendPreview(p, { final: ' mundo', partial: '' });
    expect(p).toMatchObject({ text: 'Hola mundo', partial: '' });
  });

  it('trims from the start at a word boundary once the text exceeds the limit', () => {
    let p = appendPreview(emptyPreview('listening'), { final: 'uno dos tres', partial: '' }, 10);
    expect(p.text).toBe('dos tres');
    p = appendPreview(p, { final: ' cuatro', partial: '' }, 10);
    expect(p.text).toBe('cuatro');
    // No boundary past the cut: a hard cut keeps the last `max` characters.
    p = appendPreview(emptyPreview('listening'), { final: 'abcdefghijklmnop', partial: '' }, 6);
    expect(p.text).toBe('klmnop');
  });
});

describe('end reasons', () => {
  it('maps close codes and reasons', () => {
    expect(testEndFromClose(4410, 'provider-error')).toBe('provider_error');
    expect(testEndFromClose(4410, 'provider-closed')).toBe('provider_closed');
    expect(testEndFromClose(4410, 'time-limit')).toBe('time_limit');
    expect(testEndFromClose(4410, 'session-started')).toBe('session_started');
    expect(testEndFromClose(4410, 'other')).toBe('connection_lost');
    expect(testEndFromClose(4401, 'auth-expired')).toBe('auth');
    expect(testEndFromClose(4403, 'forbidden')).toBe('auth');
    expect(testEndFromClose(4409, 'room-busy')).toBe('room_busy');
    expect(testEndFromClose(4409, 'test-active')).toBe('test_active');
    expect(testEndFromClose(4409, 'sender-active')).toBe('connection_lost');
    expect(testEndFromClose(1006, '')).toBe('connection_lost');
  });

  it('maps connect() rejections', () => {
    expect(testEndFromConnectError('rejected:room-busy')).toBe('room_busy');
    expect(testEndFromConnectError('rejected:test-active')).toBe('test_active');
    expect(testEndFromConnectError('rejected:unauthenticated')).toBe('auth');
    expect(testEndFromConnectError('rejected:invalid-language')).toBe('connect_failed');
    expect(testEndFromConnectError('closed:4409:room-busy')).toBe('room_busy');
    expect(testEndFromConnectError('closed:1006:')).toBe('connect_failed');
    expect(testEndFromConnectError('no-token')).toBe('auth');
    expect(testEndFromConnectError('socket-error')).toBe('connect_failed');
  });

  it('has a message for every reason except a source change', () => {
    const reasons: PreviewEndReason[] = ['stopped', 'file_end', 'session_started', 'time_limit', 'provider_closed', 'provider_error', 'device_lost', 'room_busy', 'test_active', 'auth', 'connection_lost', 'connect_failed'];
    for (const reason of reasons) {
      for (const d of [es, en]) {
        const m = testEndMessage(d, reason);
        expect(m, reason).not.toBeNull();
        expect(m!.text.length, reason).toBeGreaterThan(10);
      }
      // The tone is the same whatever the language.
      expect(testEndMessage(en, reason)?.tone, reason).toBe(testEndMessage(es, reason)?.tone);
    }
    expect(testEndMessage(es, 'stopped')).toEqual({ text: 'Prueba detenida.', tone: 'ok' });
    expect(testEndMessage(en, 'stopped')).toEqual({ text: 'Test stopped.', tone: 'ok' });
    expect(testEndMessage(es, 'time_limit')?.text).toContain('5 minutos');
    expect(testEndMessage(es, 'room_busy')?.text).toContain('sesión activa');
    expect(testEndMessage(es, 'test_active')?.text).toContain('otra pestaña');
    expect(testEndMessage(es, 'provider_error')?.tone).toBe('error');
    expect(testEndMessage(es, 'source_changed')).toBeNull();
  });
});
