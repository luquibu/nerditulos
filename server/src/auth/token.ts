import { verifyToken } from '@clerk/backend';

export type AdminVerifyResult =
  | { ok: true; userId: string; exp: number }
  | { ok: false; code: 'unauthenticated' | 'forbidden' | 'not_configured' };

/** Shape of `@clerk/backend`'s `verifyToken` result that the admin verifier depends on. */
export interface RawVerifyResult {
  data?: { sub?: unknown; exp?: unknown } | null | undefined;
  errors?: unknown[] | null | undefined;
}

export type RawVerifier = (token: string) => Promise<RawVerifyResult>;
export type AdminVerifier = (token: string) => Promise<AdminVerifyResult>;

/** Clerk-backed verifier. Clock skew tolerance is Clerk's default (5000 ms) and applies to validation only. */
export function clerkVerifier(secretKey: string, authorizedParties: string[], onFailure?: (reason: string) => void): RawVerifier {
  const describe = (error: unknown): string => {
    if (error && typeof error === 'object') {
      const e = error as { reason?: unknown; message?: unknown };
      return `${typeof e.reason === 'string' ? e.reason : 'error'}: ${typeof e.message === 'string' ? e.message : ''}`.slice(0, 200);
    }
    return String(error).slice(0, 200);
  };
  return async (token) => {
    try {
      // The package root exports verifyToken wrapped to resolve with the JWT payload and throw on
      // any failure (its internal { data, errors } result never reaches callers).
      const payload = await verifyToken(token, { secretKey, authorizedParties });
      return { data: payload as RawVerifyResult['data'] };
    } catch (error) {
      onFailure?.(describe(error));
      return { errors: [error] };
    }
  };
}

/**
 * Authorizes only the user whose `sub` equals a non-empty `adminUserId`. Any verification error,
 * missing subject, or other account grants nothing. `exp` is returned in milliseconds.
 */
export function createAdminVerifier(opts: { adminUserId: string; verify: RawVerifier }): AdminVerifier {
  const adminUserId = opts.adminUserId.trim();
  return async (token) => {
    if (typeof token !== 'string' || token.length === 0 || token.length > 8192) return { ok: false, code: 'unauthenticated' };
    const result = await opts.verify(token);
    if (result.errors && result.errors.length > 0) return { ok: false, code: 'unauthenticated' };
    const sub = result.data?.sub;
    const expSeconds = result.data?.exp;
    if (typeof sub !== 'string' || sub.length === 0) return { ok: false, code: 'unauthenticated' };
    if (typeof expSeconds !== 'number' || !Number.isFinite(expSeconds)) return { ok: false, code: 'unauthenticated' };
    if (!adminUserId) return { ok: false, code: 'not_configured' };
    if (sub !== adminUserId) return { ok: false, code: 'forbidden' };
    return { ok: true, userId: sub, exp: expSeconds * 1000 };
  };
}
