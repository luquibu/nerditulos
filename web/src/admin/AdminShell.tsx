import { Suspense, lazy } from 'react';
import type { RuntimeConfig } from '@nerditulos/shared';
import { strings } from '../i18n.js';
import { useLanguage } from '../LanguageProvider.js';
import { ConsolePage } from './ConsolePage.js';
import { AdminIdentityProvider, type AdminIdentity } from './identity.js';

// Clerk lives in its own chunk: a demo installation never downloads it.
const ClerkAdminShell = lazy(() => import('./ClerkAdminShell.js'));

const DEMO_IDENTITY: AdminIdentity = { kind: 'demo', getToken: async () => null };

export interface AdminShellProps {
  config: RuntimeConfig;
  showConsole: boolean;
  /** Room slug from the console path, null at `/admin`. */
  roomSlug: string | null;
  children: React.ReactNode;
}

/** The admin shell: identity comes from Clerk, or from nobody in demo mode. */
export default function AdminShell(props: AdminShellProps) {
  const [lang] = useLanguage();
  if (props.config.demoMode) {
    return <AdminIdentityProvider value={DEMO_IDENTITY}>{props.showConsole ? <ConsolePage config={props.config} roomSlug={props.roomSlug} /> : props.children}</AdminIdentityProvider>;
  }
  return (
    <Suspense fallback={<div className="page-loading">{strings(lang).loadingAdmin}</div>}>
      <ClerkAdminShell {...props} />
    </Suspense>
  );
}
