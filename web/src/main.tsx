import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { RuntimeConfig } from '@nerditulos/shared';
import './styles/tokens.css';
import './styles/components.css';
import { App } from './App.js';
import { fetchConfig } from './api.js';

const root = createRoot(document.getElementById('root') as HTMLElement);

fetchConfig()
  .then((config: RuntimeConfig) => {
    if (config.eventName) document.title = `${config.eventName} · Subtítulos`;
    root.render(
      <StrictMode>
        <App config={config} />
      </StrictMode>,
    );
  })
  .catch(() => {
    root.render(
      <div className="page-loading" role="alert">
        No se pudo cargar la configuración. Recargá la página.
      </div>,
    );
  });
