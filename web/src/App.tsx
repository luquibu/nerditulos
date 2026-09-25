import { Suspense, lazy, useEffect, useState, useSyncExternalStore } from 'react';
import type { RuntimeConfig } from '@nerditulos/shared';
import { shouldMountClerk } from './clerkMount.js';
import { RoomsPage } from './RoomsPage.js';
import { RoomPage } from './attendee/RoomPage.js';
import { isAnyCaptureActive, subscribeCaptureActive } from './admin/capture/registry.js';
import { strings } from './i18n.js';
import { hrefWithLang, langFromSearch } from './language.js';
import { useLanguage } from './LanguageProvider.js';
import { LanguageSwitch } from './LanguageSwitch.js';
import { matchRoute, usePathname } from './router.js';

// The admin shell (ClerkProvider, console, capture) is a separate chunk that attendee pages never load.
const AdminShell = lazy(() => import('./admin/AdminShell.js'));

function useCaptureActive(): boolean {
  return useSyncExternalStore(subscribeCaptureActive, isAnyCaptureActive, () => false);
}

export function App({ config }: { config: RuntimeConfig }) {
  const pathname = usePathname();
  const route = matchRoute(pathname);
  const captureActive = useCaptureActive();
  const mountClerk = shouldMountClerk(pathname, captureActive);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (isAnyCaptureActive()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  let page: React.ReactNode;
  switch (route.kind) {
    case 'rooms':
      page = <RoomsPage config={config} />;
      break;
    case 'room':
      page = <RoomPage config={config} slug={route.slug} />;
      break;
    case 'admin':
      page = null;
      break;
    default:
      page = <NotFound eventName={config.eventName} />;
  }

  if (!mountClerk) return <>{page}</>;

  // While Clerk is mounted (admin path or active capture) the admin shell stays mounted so the
  // capture runtime keeps its token supplier; other pages render inside it as a child.
  return (
    <Suspense fallback={<LoadingAdmin />}>
      <AdminShell config={config} showConsole={route.kind === 'admin'}>
        {page}
      </AdminShell>
    </Suspense>
  );
}

function LoadingAdmin() {
  const [lang] = useLanguage();
  return <div className="page-loading">{strings(lang).loadingAdmin}</div>;
}

function NotFound({ eventName }: { eventName: string }) {
  const [lang] = useLanguage();
  const d = strings(lang);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  useEffect(() => {
    document.title = [eventName, d.notFoundTitle].filter(Boolean).join(' · ');
  }, [eventName, d.notFoundTitle]);
  return (
    <main className="rooms">
      <LanguageSwitch />
      <h1 className="rooms__title">{d.notFoundTitle}</h1>
      {ready && (
        <p>
          <a href={hrefWithLang('/', langFromSearch(window.location.search))}>{d.backToRooms}</a>
        </p>
      )}
    </main>
  );
}
