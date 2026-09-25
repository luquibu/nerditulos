import { describe, expect, it } from 'vitest';
import {
  READER_LANGUAGE_STORAGE_KEY,
  hrefWithLang,
  langFromBrowser,
  parseReaderLanguage,
  readStoredLanguage,
  resolveReaderLanguage,
  withLangParam,
  writeStoredLanguage,
  type StorageLike,
} from './readerLanguage.js';

describe('parseReaderLanguage', () => {
  it('accepts es and en in any case, with region subtags and surrounding spaces', () => {
    expect(parseReaderLanguage('es')).toBe('es');
    expect(parseReaderLanguage('EN')).toBe('en');
    expect(parseReaderLanguage('en-US')).toBe('en');
    expect(parseReaderLanguage('es_AR')).toBe('es');
    expect(parseReaderLanguage(' es ')).toBe('es');
  });

  it('rejects other languages, words and empty values', () => {
    expect(parseReaderLanguage('pt')).toBeNull();
    expect(parseReaderLanguage('english')).toBeNull();
    expect(parseReaderLanguage('')).toBeNull();
    expect(parseReaderLanguage(null)).toBeNull();
    expect(parseReaderLanguage(undefined)).toBeNull();
  });
});

describe('resolveReaderLanguage', () => {
  it('lets a valid URL parameter win over the saved choice and the browser', () => {
    expect(resolveReaderLanguage({ search: '?lang=en', stored: 'es', browserLanguages: ['es'] })).toBe('en');
    expect(resolveReaderLanguage({ search: '?debug=1&lang=en', stored: null, browserLanguages: [] })).toBe('en');
  });

  it('falls back from an invalid URL parameter to the saved choice', () => {
    expect(resolveReaderLanguage({ search: '?lang=fr', stored: 'en', browserLanguages: ['es'] })).toBe('en');
  });

  it('falls back from an unsupported saved value to the browser', () => {
    expect(resolveReaderLanguage({ search: '', stored: 'pt', browserLanguages: ['en-US'] })).toBe('en');
  });

  it('maps regions to the base language', () => {
    expect(resolveReaderLanguage({ search: '?lang=es-AR', stored: null, browserLanguages: [] })).toBe('es');
    expect(resolveReaderLanguage({ search: '', stored: null, browserLanguages: ['en-US'] })).toBe('en');
  });

  it('takes the first supported browser entry, not the first entry', () => {
    expect(langFromBrowser(['pt-BR', 'en-US', 'es'])).toBe('en');
    expect(resolveReaderLanguage({ search: '', stored: null, browserLanguages: ['pt-BR', 'en-US', 'es'] })).toBe('en');
  });

  it('defaults to Spanish when nothing applies', () => {
    expect(resolveReaderLanguage({ search: '', stored: null, browserLanguages: ['pt-BR'] })).toBe('es');
    expect(resolveReaderLanguage({ search: '', stored: null, browserLanguages: [] })).toBe('es');
    expect(resolveReaderLanguage({ search: '', stored: null, browserLanguages: undefined })).toBe('es');
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
    expect(readStoredLanguage(memory({ [READER_LANGUAGE_STORAGE_KEY]: 'en' }))).toBe('en');
    expect(readStoredLanguage(memory({ [READER_LANGUAGE_STORAGE_KEY]: 'klingon' }))).toBeNull();
    expect(readStoredLanguage(memory())).toBeNull();
  });

  it('writes the choice under the storage key', () => {
    const storage = memory();
    writeStoredLanguage(storage, 'en');
    expect(storage.data[READER_LANGUAGE_STORAGE_KEY]).toBe('en');
  });

  it('survives missing or throwing storage', () => {
    expect(readStoredLanguage(null)).toBeNull();
    expect(() => writeStoredLanguage(null, 'en')).not.toThrow();
    expect(readStoredLanguage(throwing)).toBeNull();
    expect(() => writeStoredLanguage(throwing, 'es')).not.toThrow();
  });
});
