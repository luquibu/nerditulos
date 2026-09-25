// One language for the whole application. `main.tsx` resolves the initial value and mounts the provider
// above every page, so the console, the sign-in gate, the reader and the rooms list share the same choice.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Language } from './i18n.js';
import { browserStorage, langFromSearch, withLangParam, writeStoredLanguage } from './language.js';

type LanguageContextValue = [Language, (next: Language) => void];

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ initial, children }: { initial: Language; children: React.ReactNode }) {
  const [lang, setLang] = useState<Language>(initial);

  // Choosing saves the language, rewrites the URL's `lang` in place (no navigation, no popstate) and re-renders.
  const choose = useCallback((next: Language) => {
    writeStoredLanguage(browserStorage(), next);
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, '', pathname + withLangParam(search, next) + hash);
    setLang(next);
  }, []);

  // No cleanup: the provider lives as long as the app, and there is no page left in another language.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // A history navigation that restores a URL with a valid `lang` adopts it without saving it.
  useEffect(() => {
    const onPop = () => {
      const fromUrl = langFromSearch(window.location.search);
      if (fromUrl) setLang(fromUrl);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const value = useMemo<LanguageContextValue>(() => [lang, choose], [lang, choose]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

/** The current interface language and its setter; the shape of a `useState` pair. */
export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('useLanguage requires a LanguageProvider');
  return value;
}
