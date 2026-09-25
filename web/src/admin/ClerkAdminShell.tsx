import { useEffect, useMemo } from 'react';
import { enUS } from '@clerk/localizations/en-US';
import { esES } from '@clerk/localizations/es-ES';
import { ClerkProvider, Show, SignIn, useAuth, useClerk, useUser } from '@clerk/react';
import { hrefWithLang, langFromSearch } from '../language.js';
import { useLanguage } from '../LanguageProvider.js';
import { LanguageSwitch } from '../LanguageSwitch.js';
import { onLinkClick } from '../router.js';
import type { AdminShellProps } from './AdminShell.js';
import { registerTokenSupplier } from './capture/registry.js';
import { ConsolePage } from './ConsolePage.js';
import { consoleStrings, type ConsoleStrings } from './consoleStrings.js';
import { AdminIdentityProvider, type AdminIdentity } from './identity.js';

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
        <a href={hrefWithLang('/', langFromSearch(window.location.search))} onClick={onLinkClick} aria-label={d.roomsLink}>
          <img className="console__logo" src="/brand/nerdearla-simplified.svg" alt="Nerdearla" />
        </a>
        <span className="console__spacer" />
        <LanguageSwitch />
      </header>
      <main className="console__main" id="main">
        {children}
      </main>
    </div>
  );
}

/** Console under a signed-in Clerk session: the identity the console acts as. */
function SignedInConsole({ config, roomSlug }: Pick<AdminShellProps, 'config' | 'roomSlug'>) {
  const { getToken } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const accountName = user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null;
  const identity = useMemo<AdminIdentity>(
    () => ({ kind: 'clerk', getToken: () => getToken(), accountName, signOut: () => void clerk.signOut({ redirectUrl: '/admin' }) }),
    [getToken, accountName, clerk],
  );
  return (
    <AdminIdentityProvider value={identity}>
      <ConsolePage config={config} roomSlug={roomSlug} />
    </AdminIdentityProvider>
  );
}

export default function ClerkAdminShell({ config, showConsole, roomSlug, children }: AdminShellProps) {
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
            <SignedInConsole config={config} roomSlug={roomSlug} />
          </Show>
        </>
      ) : (
        children
      )}
    </ClerkProvider>
  );
}
