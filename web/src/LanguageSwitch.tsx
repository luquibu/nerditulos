import { LANGUAGES, LANGUAGE_NATIVE_NAMES, strings } from './i18n.js';
import { useLanguage } from './LanguageProvider.js';

/**
 * Segmented ES | EN control for the interface language. Two native buttons: Tab reaches both, Enter or
 * Space activates, and the pressed one stays enabled. The accessible names are the endonyms whatever the
 * interface language, and the visible text is their two-letter prefix.
 */
export function LanguageSwitch() {
  const [lang, choose] = useLanguage();
  const d = strings(lang);
  return (
    <div className="lang-switch" role="group" aria-label={d.languageLabel}>
      {LANGUAGES.map((option) => (
        <button
          key={option}
          type="button"
          className="lang-switch__option"
          lang={option}
          aria-pressed={option === lang}
          aria-label={LANGUAGE_NATIVE_NAMES[option]}
          onClick={() => {
            if (option !== lang) choose(option);
          }}
        >
          {option.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
