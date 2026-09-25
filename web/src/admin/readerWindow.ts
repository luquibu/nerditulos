/** One reader window per room: named targets let the browser reuse the window it already opened. */
export function readerWindowName(slug: string): string {
  return `nerditulos-reader-${slug}`;
}

export function readerPath(slug: string): string {
  return `/r/${slug}`;
}

/**
 * Brings the room's reader window to the front, loading `href` only when that window is new or was
 * navigated elsewhere. Returns false when the browser blocked the window, so the caller can let the
 * anchor's own named target take over.
 */
export function openReaderWindow(slug: string, href: string): boolean {
  // An empty URL returns the existing window with this name without navigating it, or creates a blank
  // one. The window must keep its opener (no `noopener`): only then can the next click find it by name.
  const w = window.open('', readerWindowName(slug));
  if (!w) return false;
  if (w.location.pathname !== readerPath(slug)) w.location.href = href;
  w.focus();
  return true;
}
