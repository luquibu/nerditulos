import { useEffect } from 'react';
import { enUS } from '@clerk/localizations/en-US';
import { esES } from '@clerk/localizations/es-ES';
import { ClerkProvider, Show, SignIn, useAuth } from '@clerk/react';
import type { RuntimeConfig } from '@nerditulos/shared';
import { useLanguage } from '../LanguageProvider.js';
import { LanguageSwitch } from '../LanguageSwitch.js';
import { registerTokenSupplier } from './capture/registry.js';
import { ConsolePage } from './ConsolePage.js';
import { consoleStrings, type ConsoleStrings } from './consoleStrings.js';

/** Registers Clerk's `getToken` into the capture runtime's token supplier while mounted. */
function TokenBridge() {
  const { getToken } = useAuth();
  useEffect(() => registerTokenSupplier((options) => getToken({ skipCache: options?.skipCache ?? false })), [getToken]);
  return null;
}

function ConsoleFrame({ d, children }: { d: ConsoleStrings; children: React.ReactNode }) {
  return (
    <div className="console">
      <a className="skip-link" href="#main">
        {d.skipToContent}
      </a>
      <header className="console__header">
        <img className="console__logo" src="/brand/nerdearla-simplified.svg" alt="Nerdearla" />
        <span className="console__spacer" />
        <LanguageSwitch />
      </header>
      <main className="console__main" id="main">
        {children}
      </main>
    </div>
  );
}

export default function AdminShell({
  config,
  showConsole,
  children,
}: {
  config: RuntimeConfig;
  showConsole: boolean;
  children: React.ReactNode;
}) {
  const [lang] = useLanguage();
  const d = consoleStrings(lang);
  if (!config.clerkPublishableKey) {
    if (!showConsole) return <>{children}</>;
    return (
      <ConsoleFrame d={d}>
        <div className="banner banner--error" role="alert">
          {d.adminKeyMissing}
        </div>
      </ConsoleFrame>
    );
  }
  // English is passed explicitly so that switching back from Spanish reapplies the full resource.
  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey} afterSignOutUrl="/admin" localization={lang === 'es' ? esES : enUS}>
      <TokenBridge />
      {showConsole ? (
        <>
          <Show when="signed-out">
            <ConsoleFrame d={d}>
              <h1 className="section-title">{d.consoleTitle}</h1>
              <p className="card__meta">{d.signInIntro}</p>
              <div>
                <SignIn routing="hash" />
              </div>
            </ConsoleFrame>
          </Show>
          <Show when="signed-in">
            <ConsolePage config={config} />
          </Show>
        </>
      ) : (
        children
      )}
    </ClerkProvider>
  );
}
