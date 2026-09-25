/**
 * Clerk is mounted only where administrative identity is needed: on `/admin` paths, or while
 * any room capture is active (the sender socket renews its token through Clerk). Attendee
 * pages with no capture never load Clerk.
 */
export function shouldMountClerk(pathname: string, captureActive: boolean): boolean {
  if (captureActive) return true;
  return pathname === '/admin' || pathname.startsWith('/admin/');
}
