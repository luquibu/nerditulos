import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { RuntimeConfig } from '@nerditulos/shared';
import './styles/tokens.css';
import './styles/components.css';
import { App } from './App.js';
import { fetchConfig } from './api.js';
import { strings } from './i18n.js';
import { browserLanguages, browserStorage, readStoredLanguage, resolveLanguage } from './language.js';
import { LanguageProvider } from './LanguageProvider.js';

const root = createRoot(document.getElementById('root') as HTMLElement);

// Resolved once before the first render, so the title and the configuration error already use the right language.
const lang = resolveLanguage({ search: window.location.search, stored: readStoredLanguage(browserStorage()), browserLanguages: browserLanguages() });
document.documentElement.lang = lang;
const d = strings(lang);

fetchConfig()
  .then((config: RuntimeConfig) => {
    document.title = config.eventName ? `${config.eventName} · ${d.appTitle}` : d.appTitle;
    root.render(
      <StrictMode>
        <LanguageProvider initial={lang}>
          <App config={config} />
        </LanguageProvider>
      </StrictMode>,
    );
  })
  .catch(() => {
    root.render(
      <div className="page-loading" role="alert">
        {d.configLoadFailed}
      </div>,
    );
  });
