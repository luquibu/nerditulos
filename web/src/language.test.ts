import { describe, expect, it } from 'vitest';
import {
  LANGUAGE_STORAGE_KEY,
  hrefWithLang,
  langFromBrowser,
  parseLanguage,
  readStoredLanguage,
  resolveLanguage,
  withLangParam,
  writeStoredLanguage,
  type StorageLike,
} from './language.js';

describe('parseLanguage', () => {
  it('accepts es and en in any case, with region subtags and surrounding spaces', () => {
    expect(parseLanguage('es')).toBe('es');
    expect(parseLanguage('EN')).toBe('en');
    expect(parseLanguage('en-US')).toBe('en');
    expect(parseLanguage('es_AR')).toBe('es');
    expect(parseLanguage(' es ')).toBe('es');
  });

  it('rejects other languages, words and empty values', () => {
    expect(parseLanguage('pt')).toBeNull();
    expect(parseLanguage('english')).toBeNull();
    expect(parseLanguage('')).toBeNull();
    expect(parseLanguage(null)).toBeNull();
    expect(parseLanguage(undefined)).toBeNull();
  });
});

describe('resolveLanguage', () => {
  it('lets a valid URL parameter win over the saved choice and the browser', () => {
    expect(resolveLanguage({ search: '?lang=en', stored: 'es', browserLanguages: ['es'] })).toBe('en');
    expect(resolveLanguage({ search: '?debug=1&lang=en', stored: null, browserLanguages: [] })).toBe('en');
  });

  it('falls back from an invalid URL parameter to the saved choice', () => {
    expect(resolveLanguage({ search: '?lang=fr', stored: 'en', browserLanguages: ['es'] })).toBe('en');
  });

  it('falls back from an unsupported saved value to the browser', () => {
    expect(resolveLanguage({ search: '', stored: 'pt', browserLanguages: ['en-US'] })).toBe('en');
  });

  it('maps regions to the base language', () => {
    expect(resolveLanguage({ search: '?lang=es-AR', stored: null, browserLanguages: [] })).toBe('es');
    expect(resolveLanguage({ search: '', stored: null, browserLanguages: ['en-US'] })).toBe('en');
  });

  it('takes the first supported browser entry, not the first entry', () => {
    expect(langFromBrowser(['pt-BR', 'en-US', 'es'])).toBe('en');
    expect(resolveLanguage({ search: '', stored: null, browserLanguages: ['pt-BR', 'en-US', 'es'] })).toBe('en');
  });

  it('defaults to Spanish when nothing applies', () => {
    expect(resolveLanguage({ search: '', stored: null, browserLanguages: ['pt-BR'] })).toBe('es');
    expect(resolveLanguage({ search: '', stored: null, browserLanguages: [] })).toBe('es');
    expect(resolveLanguage({ search: '', stored: null, browserLanguages: undefined })).toBe('es');
  });
});

describe('withLangParam', () => {
  it('adds, replaces and keeps other parameters in their order', () => {
    expect(withLangParam('', 'en')).toBe('?lang=en');
    expect(withLangParam('?lang=es', 'en')).toBe('?lang=en');
    expect(withLangParam('?debug=1&lang=es', 'en')).toBe('?debug=1&lang=en');
    expect(withLangParam('?lang=es&debug=1', 'en')).toBe('?lang=en&debug=1');
    expect(withLangParam('?debug=1', 'es')).toBe('?debug=1&lang=es');
  });

  it('builds internal links that keep only an explicit language', () => {
    expect(hrefWithLang('/r/sala-1', 'en')).toBe('/r/sala-1?lang=en');
    expect(hrefWithLang('/r/sala-1', null)).toBe('/r/sala-1');
    expect(hrefWithLang('/', 'es')).toBe('/?lang=es');
  });
});

describe('stored language', () => {
  const memory = (initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } => {
    const data = { ...initial };
    return {
      data,
      getItem: (key) => (key in data ? (data[key] as string) : null),
      setItem: (key, value) => {
        data[key] = value;
      },
    };
  };
  const throwing: StorageLike = {
    getItem: () => {
      throw new DOMException('blocked', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('full', 'QuotaExceededError');
    },
  };

  it('reads a saved choice and ignores unknown values', () => {
    expect(readStoredLanguage(memory({ [LANGUAGE_STORAGE_KEY]: 'en' }))).toBe('en');
    expect(readStoredLanguage(memory({ [LANGUAGE_STORAGE_KEY]: 'klingon' }))).toBeNull();
    expect(readStoredLanguage(memory())).toBeNull();
  });

  it('writes the choice under the storage key', () => {
    const storage = memory();
    writeStoredLanguage(storage, 'en');
    expect(storage.data[LANGUAGE_STORAGE_KEY]).toBe('en');
  });

  it('survives missing or throwing storage', () => {
    expect(readStoredLanguage(null)).toBeNull();
    expect(() => writeStoredLanguage(null, 'en')).not.toThrow();
    expect(readStoredLanguage(throwing)).toBeNull();
    expect(() => writeStoredLanguage(throwing, 'es')).not.toThrow();
  });
});
