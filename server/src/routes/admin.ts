import { Router, type RequestHandler } from 'express';
import type { FinishSessionResponse } from '@nerditulos/shared';
import type { AdminIdentity } from '../auth/http.js';
import type { Logger } from '../log.js';
import { ManagerError, type SessionManager } from '../sessions/SessionManager.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleError(res: import('express').Response, error: unknown, log: Logger | undefined, where: string) {
  if (error instanceof ManagerError) {
    res.status(error.status).json({ error: error.code, ...error.detail });
    return;
  }
  log?.error('admin request failed', { where, error: error instanceof Error ? error.message : String(error) });
  res.status(500).json({ error: 'internal_error' });
}

/** The `:id` parameter as a session id, or null (400 `invalid_id` already sent). */
function sessionId(req: import('express').Request, res: import('express').Response): string | null {
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(400).json({ error: 'invalid_id' });
    return null;
  }
  return id.toLowerCase();
}

export function adminRoutes(deps: { requireAdmin: RequestHandler; manager: SessionManager; log?: Logger }): Router {
  const router = Router();
  const { manager, log } = deps;
  router.use(deps.requireAdmin);

  router.get('/me', (_req, res) => {
    const admin = res.locals.admin as AdminIdentity;
    res.setHeader('Cache-Control', 'no-store');
    if (admin.kind === 'demo') res.json({ mode: 'demo' });
    else res.json({ mode: 'clerk', userId: admin.userId, exp: admin.exp });
  });

  router.get('/rooms', async (_req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ rooms: await manager.listAdminRooms() });
    } catch (error) {
      handleError(res, error, log, 'rooms');
    }
  });

  router.post('/rooms/:slug/sessions', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { title?: unknown; sourceLanguage?: unknown };
      const title = typeof body.title === 'string' ? body.title : '';
      const sourceLanguage = body.sourceLanguage === 'en' ? 'en' : body.sourceLanguage === 'es' ? 'es' : null;
      if (!sourceLanguage) {
        res.status(400).json({ error: 'invalid_language' });
        return;
      }
      const session = await manager.prepare(String(req.params.slug), { title, sourceLanguage });
      res.status(201).json({ session });
    } catch (error) {
      handleError(res, error, log, 'prepare');
    }
  });

  router.get('/sessions/:id', async (req, res) => {
    const id = sessionId(req, res);
    if (!id) return;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const session = await manager.getSession(id);
      if (!session) {
        res.status(404).json({ error: 'session_not_found' });
        return;
      }
      res.json({ session });
    } catch (error) {
      handleError(res, error, log, 'session');
    }
  });

  router.post('/sessions/:id/start', async (req, res) => {
    const id = sessionId(req, res);
    if (!id) return;
    try {
      const body = (req.body ?? {}) as { confirmedTestId?: unknown };
      const confirmedTestId = typeof body.confirmedTestId === 'string' && body.confirmedTestId.length > 0 && body.confirmedTestId.length <= 64 ? body.confirmedTestId : null;
      res.json({ session: await manager.start(id, { confirmedTestId }) });
    } catch (error) {
      handleError(res, error, log, 'start');
    }
  });

  router.post('/sessions/:id/finish', async (req, res) => {
    const id = sessionId(req, res);
    if (!id) return;
    try {
      const result = await manager.finish(id);
      const body: FinishSessionResponse = { session: result.session, alreadyFinished: result.alreadyFinished };
      res.json(body);
    } catch (error) {
      handleError(res, error, log, 'finish');
    }
  });

  router.delete('/sessions/:id', async (req, res) => {
    const id = sessionId(req, res);
    if (!id) return;
    try {
      await manager.delete(id);
      res.status(204).end();
    } catch (error) {
      handleError(res, error, log, 'delete');
    }
  });

  return router;
}
