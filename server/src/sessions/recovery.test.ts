import { describe, expect, it, vi } from 'vitest';
import { defaultLanguage } from '@nerditulos/shared';
import { silentLogger, type Logger } from '../log.js';
import { summaryOf, translationTargetOf } from './recovery.js';
import type { StreamSpec } from './SessionStore.js';

const ORIGINAL_ES: StreamSpec = { outputType: 'original', language: 'es' };
const TRANSLATION_EN: StreamSpec = { outputType: 'translation', language: 'en' };
const ORIGINAL_EN: StreamSpec = { outputType: 'original', language: 'en' };
const TRANSLATION_ES: StreamSpec = { outputType: 'translation', language: 'es' };

const session = { id: 's1', title: 'T', sourceLanguage: 'es' as const, state: 'live' as const, cause: null, completeness: null };

describe('summaryOf', () => {
  it('offers one labelled language per stream, originals first regardless of row order', () => {
    expect(summaryOf(session, [ORIGINAL_ES]).availableLanguages).toEqual([{ lang: 'es', outputType: 'original', label: 'Español (original)' }]);
    expect(summaryOf(session, [TRANSLATION_EN, ORIGINAL_ES]).availableLanguages).toEqual([
      { lang: 'es', outputType: 'original', label: 'Español (original)' },
      { lang: 'en', outputType: 'translation', label: 'English (translation)' },
    ]);
    expect(summaryOf({ ...session, sourceLanguage: 'en' }, [ORIGINAL_EN, TRANSLATION_ES]).availableLanguages).toEqual([
      { lang: 'en', outputType: 'original', label: 'English (original)' },
      { lang: 'es', outputType: 'translation', label: 'Español (traducción)' },
    ]);
  });

  it('copies the session fields and derives nothing from the source language', () => {
    expect(summaryOf({ ...session, state: 'interrupted', cause: 'sender_lost' }, [ORIGINAL_ES])).toEqual({
      sessionId: 's1',
      title: 'T',
      sourceLanguage: 'es',
      state: 'interrupted',
      cause: 'sender_lost',
      completeness: null,
      availableLanguages: [{ lang: 'es', outputType: 'original', label: 'Español (original)' }],
    });
    // A Spanish session prepared with one stream offers Spanish only, whatever the policy is today.
    expect(summaryOf(session, []).availableLanguages).toEqual([]);
  });
});

describe('translationTargetOf', () => {
  it('is the translation stream language, or null for a session without one', () => {
    expect(translationTargetOf([ORIGINAL_ES, TRANSLATION_EN], silentLogger)).toBe('en');
    expect(translationTargetOf([ORIGINAL_EN, TRANSLATION_ES], silentLogger)).toBe('es');
    expect(translationTargetOf([ORIGINAL_ES], silentLogger)).toBeNull();
  });

  it('refuses a target outside the provider contract and logs an error', () => {
    const error = vi.fn();
    const log: Logger = { ...silentLogger, error };
    expect(translationTargetOf([ORIGINAL_ES, { outputType: 'translation', language: 'fr' }], log)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toEqual({ language: 'fr' });
  });
});

describe('defaultLanguage', () => {
  it('prefers Spanish in either direction and falls back to the first offered language', () => {
    expect(defaultLanguage(summaryOf(session, [ORIGINAL_ES, TRANSLATION_EN]).availableLanguages)).toBe('es');
    expect(defaultLanguage(summaryOf({ ...session, sourceLanguage: 'en' }, [ORIGINAL_EN, TRANSLATION_ES]).availableLanguages)).toBe('es');
    expect(defaultLanguage([{ lang: 'en', outputType: 'translation', label: 'English (translation)' }])).toBe('en');
    expect(defaultLanguage([])).toBeNull();
  });
});
