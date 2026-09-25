import { useEffect } from 'react';
import { ClerkProvider, Show, SignIn, useAuth } from '@clerk/react';
import type { RuntimeConfig } from '@nerditulos/shared';
import { registerTokenSupplier } from './capture/registry.js';
import { ConsolePage } from './ConsolePage.js';

/** Registers Clerk's `getToken` into the capture runtime's token supplier while mounted. */
function TokenBridge() {
  const { getToken } = useAuth();
  useEffect(() => registerTokenSupplier((options) => getToken({ skipCache: options?.skipCache ?? false })), [getToken]);
  return null;
}

function ConsoleFrame({ config, children }: { config: RuntimeConfig; children: React.ReactNode }) {
  return (
    <div className="console">
      <a className="skip-link" href="#main">
        Ir al contenido
      </a>
      <header className="console__header">
        <img className="console__logo" src="/brand/nerdearla-simplified.svg" alt="Nerdearla" />
        <span className="console__spacer" />
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
  if (!config.clerkPublishableKey) {
    if (!showConsole) return <>{children}</>;
    return (
      <ConsoleFrame config={config}>
        <div className="banner banner--error" role="alert">
          Administración no configurada: falta la clave publicable de Clerk en el servidor.
        </div>
      </ConsoleFrame>
    );
  }
  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey} afterSignOutUrl="/admin">
      <TokenBridge />
      {showConsole ? (
        <>
          <Show when="signed-out">
            <ConsoleFrame config={config}>
              <h1 className="section-title">Consola</h1>
              <p className="card__meta">Iniciá sesión con la cuenta administradora para preparar y supervisar sesiones.</p>
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
