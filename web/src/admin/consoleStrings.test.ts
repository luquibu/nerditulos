import { describe, expect, it } from 'vitest';
import { STRINGS } from '../i18n.js';
import { CONSOLE_ONLY, consoleStrings } from './consoleStrings.js';

type Table = Record<string, unknown>;

/** Flattens nested records (`checkLabel.ok`) so nested keys are compared one by one. */
function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Table).reduce<Record<string, unknown>>((acc, [key, inner]) => Object.assign(acc, flatten(inner, prefix ? `${prefix}.${key}` : key)), {});
  }
  return { [prefix]: value };
}

/** Text that is legitimately the same in both languages: units, brand words, shared vocabulary. */
const SAME_IN_BOTH = new Set(['checkLabel.error', 'mono', 'visible']);

/** Calls a parameterized string with a probe so its template text can be compared across languages. */
function probe(value: unknown): unknown {
  if (typeof value !== 'function') return value;
  try {
    return (value as (...args: unknown[]) => unknown)('probe', 'probe');
  } catch {
    return undefined;
  }
}

describe('console strings', () => {
  const es = flatten(CONSOLE_ONLY.es);
  const en = flatten(CONSOLE_ONLY.en);

  it('has the same keys in both languages, nested records included', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
  });

  it('does not override a public key', () => {
    const base = new Set(Object.keys(STRINGS.es));
    for (const key of Object.keys(CONSOLE_ONLY.es)) expect(base.has(key), key).toBe(false);
  });

  it('translates every text except the listed shared words', () => {
    for (const key of Object.keys(es)) {
      const a = probe(es[key]);
      const b = probe(en[key]);
      expect(typeof a, key).toBe('string');
      expect((a as string).length, key).toBeGreaterThan(0);
      if (SAME_IN_BOTH.has(key)) expect(a, key).toBe(b);
      else expect(a, key).not.toBe(b);
    }
  });

  it('merges the public table into each language', () => {
    const merged = consoleStrings('en');
    expect(merged.appTitle).toBe(STRINGS.en.appTitle);
    expect(merged.stateLive).toBe('Live');
    expect(merged.consoleTitle).toBe('Console');
    expect(consoleStrings('es').stateLive).toBe('En vivo');
    expect(consoleStrings('es')).toBe(consoleStrings('es'));
  });

  it('formats the parameterized texts with their arguments', () => {
    const es = consoleStrings('es');
    const en = consoleStrings('en');
    expect(es.prepareFailed('room_busy')).toBe('No se pudo preparar la sesión (room_busy).');
    expect(es.prepareFailed(null)).toBe('No se pudo preparar la sesión.');
    expect(en.startFailed(null)).toBe('The session could not be started.');
    expect(en.roomBusy('Keynote')).toContain('(Keynote)');
    expect(es.finishDialogBody(20)).toContain('20 segundos');
    expect(en.finishedSessions(3)).toBe('Finished sessions (3)');
    expect(en.connectionStats({ epoch: 2, framesSent: 10, framesDropped: 1, discontinuities: 0, lastAckPosition: null })).toBe('Connection 2 · frames sent 10 · dropped 1 · discontinuities 0');
    expect(es.connectionStats({ epoch: 2, framesSent: 10, framesDropped: 1, discontinuities: 0, lastAckPosition: 16000 })).toContain(' · última recepción pos. 16000');
  });
});
