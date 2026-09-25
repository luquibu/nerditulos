import type { RequestHandler } from 'express';
import type { AdminVerifier } from './token.js';

export interface AdminIdentity {
  userId: string;
  exp: number;
}

/**
 * Verifies `Authorization: Bearer <token>` on every request. 401 for missing, invalid, or expired
 * tokens; 403 for any other account; 503 while no administrator is configured.
 */
export function requireAdmin(verify: AdminVerifier): RequestHandler {
  return async (req, res, next) => {
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
    res.locals.admin = { userId: result.userId, exp: result.exp } satisfies AdminIdentity;
    next();
  };
}
