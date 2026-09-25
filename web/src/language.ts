// The interface language of the whole application; on the reader it also picks the caption stream.
// Resolution order: `?lang` in the URL, the choice saved in this browser, the browser's languages, Spanish.
// Pure: no DOM and no React. The provider that holds the live value is `LanguageProvider.tsx`.
import { isLanguage, type Language } from './i18n.js';

export const LANG_PARAM = 'lang';
/** Historical value from when only the reader had a language; kept so choices already saved keep applying. */
export const LANGUAGE_STORAGE_KEY = 'nerditulos.readerLanguage';
export const DEFAULT_LANGUAGE: Language = 'es';

/** Accepts `es`/`en` in any case, with a region subtag (`en-US`) and surrounding spaces; anything else is null. */
export function parseLanguage(value: string | null | undefined): Language | null {
  if (typeof value !== 'string') return null;
  const primary = value.trim().toLowerCase().split(/[-_]/, 1)[0] ?? '';
  return isLanguage(primary) ? primary : null;
}

export function langFromSearch(search: string): Language | null {
  return parseLanguage(new URLSearchParams(search).get(LANG_PARAM));
}

/** First supported entry of the browser's preference list (`navigator.languages` semantics). */
export function langFromBrowser(languages: readonly string[] | null | undefined): Language | null {
  for (const entry of languages ?? []) {
    const parsed = parseLanguage(entry);
    if (parsed) return parsed;
  }
  return null;
}

/** The browser's preference list, falling back to its single language where the list is missing. */
export function browserLanguages(): readonly string[] {
  return navigator.languages ?? (navigator.language ? [navigator.language] : []);
}

export function resolveLanguage(input: { search: string; stored: string | null; browserLanguages: readonly string[] | null | undefined }): Language {
  return langFromSearch(input.search) ?? parseLanguage(input.stored) ?? langFromBrowser(input.browserLanguages) ?? DEFAULT_LANGUAGE;
}

/** The query string with `lang` set, keeping the other parameters (such as `debug=1`) and their order. */
export function withLangParam(search: string, lang: Language): string {
  const params = new URLSearchParams(search);
  params.set(LANG_PARAM, lang);
  return `?${params.toString()}`;
}

/** An internal path with `?lang` appended when the current URL carries an explicit one, so a shared link keeps its language. */
export function hrefWithLang(path: string, explicit: Language | null): string {
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

export function readStoredLanguage(storage: StorageLike | null): Language | null {
  if (!storage) return null;
  try {
    return parseLanguage(storage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeStoredLanguage(storage: StorageLike | null, lang: Language): void {
  if (!storage) return;
  try {
    storage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // Quota or private mode: the choice still applies to this page through the URL and state.
  }
}
