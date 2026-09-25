import { useEffect, useState } from 'react';

export type Route = { kind: 'rooms' } | { kind: 'room'; slug: string } | { kind: 'admin' } | { kind: 'not_found' };

export function matchRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { kind: 'rooms' };
  const room = /^\/r\/([a-z0-9-]+)\/?$/.exec(pathname);
  if (room) return { kind: 'room', slug: room[1] as string };
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return { kind: 'admin' };
  return { kind: 'not_found' };
}

export function navigate(path: string) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePathname(): string {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return pathname;
}

/** Internal link handler: same-origin navigation without a full reload. */
export function onLinkClick(event: React.MouseEvent<HTMLAnchorElement>) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = event.currentTarget.getAttribute('href');
  if (!href || !href.startsWith('/')) return;
  event.preventDefault();
  navigate(href);
}

export function debugEnabled(): boolean {
  return new URLSearchParams(window.location.search).get('debug') === '1';
}
