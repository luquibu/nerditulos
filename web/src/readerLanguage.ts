// The reader language decides the interface and the caption stream of the public pages.
// Resolution order: `?lang` in the URL, the choice saved in this browser, the browser's languages, Spanish.
import { useCallback, useEffect, useState } from 'react';
import { isReaderLanguage, type ReaderLanguage } from './i18n.js';

export const LANG_PARAM = 'lang';
export const READER_LANGUAGE_STORAGE_KEY = 'nerditulos.readerLanguage';
export const DEFAULT_READER_LANGUAGE: ReaderLanguage = 'es';

/** Accepts `es`/`en` in any case, with a region subtag (`en-US`) and surrounding spaces; anything else is null. */
export function parseReaderLanguage(value: string | null | undefined): ReaderLanguage | null {
  if (typeof value !== 'string') return null;
  const primary = value.trim().toLowerCase().split(/[-_]/, 1)[0] ?? '';
  return isReaderLanguage(primary) ? primary : null;
}

export function langFromSearch(search: string): ReaderLanguage | null {
  return parseReaderLanguage(new URLSearchParams(search).get(LANG_PARAM));
}

/** First supported entry of the browser's preference list (`navigator.languages` semantics). */
export function langFromBrowser(languages: readonly string[] | null | undefined): ReaderLanguage | null {
  for (const entry of languages ?? []) {
    const parsed = parseReaderLanguage(entry);
    if (parsed) return parsed;
  }
  return null;
}

export function resolveReaderLanguage(input: { search: string; stored: string | null; browserLanguages: readonly string[] | null | undefined }): ReaderLanguage {
  return langFromSearch(input.search) ?? parseReaderLanguage(input.stored) ?? langFromBrowser(input.browserLanguages) ?? DEFAULT_READER_LANGUAGE;
}

/** The query string with `lang` set, keeping the other parameters (such as `debug=1`) and their order. */
export function withLangParam(search: string, lang: ReaderLanguage): string {
  const params = new URLSearchParams(search);
  params.set(LANG_PARAM, lang);
  return `?${params.toString()}`;
}

/** An internal path with `?lang` appended when the current URL carries an explicit one, so a shared link keeps its language. */
export function hrefWithLang(path: string, explicit: ReaderLanguage | null): string {
  return explicit ? path + withLangParam('', explicit) : path;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** `window.localStorage` when usable; the getter itself throws when storage is disabled. */
export function browserStorage(): StorageLike | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredLanguage(storage: StorageLike | null): ReaderLanguage | null {
  if (!storage) return null;
  try {
    return parseReaderLanguage(storage.getItem(READER_LANGUAGE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeStoredLanguage(storage: StorageLike | null, lang: ReaderLanguage): void {
  if (!storage) return;
  try {
    storage.setItem(READER_LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // Quota or private mode: the choice still applies to this page through the URL and state.
  }
}

/**
 * Reader language of the public pages and its setter. Choosing a language saves it, rewrites the URL's
 * `lang` in place (no navigation, no popstate) and updates `<html lang>`; unmounting restores Spanish for the console.
 * A history navigation that restores a URL with a valid `lang` adopts it without saving it.
 */
export function useReaderLanguage(): [ReaderLanguage, (next: ReaderLanguage) => void] {
  const [lang, setLang] = useState<ReaderLanguage>(() =>
    resolveReaderLanguage({
      search: window.location.search,
      stored: readStoredLanguage(browserStorage()),
      browserLanguages: navigator.languages ?? (navigator.language ? [navigator.language] : []),
    }),
  );

  const choose = useCallback((next: ReaderLanguage) => {
    writeStoredLanguage(browserStorage(), next);
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, '', pathname + withLangParam(search, next) + hash);
    setLang(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    return () => {
      document.documentElement.lang = DEFAULT_READER_LANGUAGE;
    };
  }, [lang]);

  useEffect(() => {
    const onPop = () => {
      const fromUrl = langFromSearch(window.location.search);
      if (fromUrl) setLang(fromUrl);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return [lang, choose];
}
