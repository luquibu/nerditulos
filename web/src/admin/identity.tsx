// Who the console acts as. The shell that mounts the console decides: nobody in particular in demo
// mode, or the Clerk-signed-in administrator. Console components never import Clerk themselves.
import { createContext, useContext } from 'react';
import type { TokenSupplier } from '../api.js';

export type AdminIdentity =
  | { kind: 'demo'; getToken: TokenSupplier }
  | { kind: 'clerk'; getToken: TokenSupplier; accountName: string | null; signOut: () => void };

const AdminIdentityContext = createContext<AdminIdentity | null>(null);

export const AdminIdentityProvider = AdminIdentityContext.Provider;

export function useAdminIdentity(): AdminIdentity {
  const identity = useContext(AdminIdentityContext);
  if (!identity) throw new Error('useAdminIdentity outside an admin shell');
  return identity;
}
