import type { RequestHandler } from 'express';
import { checkOrigin } from './origin.js';
import type { AdminVerifier } from './token.js';

/** Who the request acts as: nobody in particular in demo mode, or the Clerk-authenticated administrator. */
export type AdminIdentity = { kind: 'demo' } | { kind: 'clerk'; userId: string; exp: number };

export interface RequireAdminOptions {
  /** Grants every request administrative access without identity; the origin check still applies to mutations. */
  demoMode: boolean;
  allowedOrigins: string[];
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Admin gate. Mutations (POST/DELETE) must carry an `Origin` that is listed in `allowedOrigins`:
 * in demo mode a missing one is refused too (403 `origin_not_allowed`), because the origin is the
 * only thing tying the request to this installation's own pages; with Clerk a missing origin is
 * accepted when the bearer token is valid, a foreign one never is. GET requests skip the check.
 *
 * With Clerk, `Authorization: Bearer <token>` is verified on every request: 401 for missing,
 * invalid, or expired tokens; 403 for any other account; 503 while no administrator is configured.
 * In demo mode the verifier is never called.
 */
export function requireAdmin(verify: AdminVerifier, opts: RequireAdminOptions): RequestHandler {
  return async (req, res, next) => {
    if (MUTATING.has(req.method)) {
      const origin = checkOrigin(req.headers.origin, opts.allowedOrigins);
      if (origin === 'invalid' || (origin === 'missing' && opts.demoMode)) {
        res.status(403).json({ error: 'origin_not_allowed' });
        return;
      }
    }
    if (opts.demoMode) {
      res.locals.admin = { kind: 'demo' } satisfies AdminIdentity;
      next();
      return;
    }
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    let result: Awaited<ReturnType<AdminVerifier>>;
    try {
      result = await verify(match[1] as string);
    } catch {
      res.status(503).json({ error: 'auth_unavailable' });
      return;
    }
    if (!result.ok) {
      if (result.code === 'not_configured') res.status(503).json({ error: 'admin_not_configured' });
      else if (result.code === 'forbidden') res.status(403).json({ error: 'forbidden' });
      else res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    res.locals.admin = { kind: 'clerk', userId: result.userId, exp: result.exp } satisfies AdminIdentity;
    next();
  };
}
