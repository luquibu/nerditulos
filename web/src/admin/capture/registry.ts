// Module-scope registry of active captures, shared by the capture runtime and the app shell.
// It survives React re-renders, route changes, and StrictMode double mounts.
type Listener = () => void;

const activeRooms = new Set<string>();
const listeners = new Set<Listener>();

export function setCaptureActive(roomSlug: string, active: boolean) {
  const before = activeRooms.size > 0;
  if (active) activeRooms.add(roomSlug);
  else activeRooms.delete(roomSlug);
  const after = activeRooms.size > 0;
  if (before !== after) for (const listener of listeners) listener();
}

export function isAnyCaptureActive(): boolean {
  return activeRooms.size > 0;
}

export function activeCaptureRooms(): string[] {
  return [...activeRooms];
}

export function subscribeCaptureActive(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// How the sender socket authenticates: with a Clerk token, or with nothing at all in demo mode.
// Set once from the runtime configuration before the first capture.
export type AuthMode = 'clerk' | 'demo';

let authMode: AuthMode = 'clerk';

export function setAuthMode(mode: AuthMode) {
  authMode = mode;
}

export function getAuthMode(): AuthMode {
  return authMode;
}

// Token supplier registered by the TokenBridge component inside ClerkProvider.
export type TokenSupplier = (options?: { skipCache?: boolean }) => Promise<string | null>;

let tokenSupplier: TokenSupplier | null = null;

export function registerTokenSupplier(supplier: TokenSupplier): () => void {
  tokenSupplier = supplier;
  return () => {
    if (tokenSupplier === supplier) tokenSupplier = null;
  };
}

export function currentTokenSupplier(): TokenSupplier | null {
  return tokenSupplier;
}

export async function getAdminToken(options?: { skipCache?: boolean }): Promise<string | null> {
  if (!tokenSupplier) return null;
  return tokenSupplier(options);
}
