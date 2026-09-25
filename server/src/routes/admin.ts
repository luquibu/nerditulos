import { Router, type RequestHandler } from 'express';
import type { AdminIdentity } from '../auth/http.js';
import { ManagerError, type SessionManager } from '../sessions/SessionManager.js';

function handleError(res: import('express').Response, error: unknown) {
  if (error instanceof ManagerError) {
    res.status(error.status).json({ error: error.code, ...error.detail });
    return;
  }
  res.status(500).json({ error: 'internal_error' });
}

export function adminRoutes(deps: { requireAdmin: RequestHandler; manager: SessionManager }): Router {
  const router = Router();
  router.use(deps.requireAdmin);

  router.get('/me', (_req, res) => {
    const admin = res.locals.admin as AdminIdentity;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ userId: admin.userId, exp: admin.exp });
  });

  router.get('/rooms', async (_req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ rooms: await deps.manager.listAdminRooms() });
    } catch (error) {
      handleError(res, error);
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
      const session = await deps.manager.prepare(String(req.params.slug), { title, sourceLanguage });
      res.status(201).json({ session });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/sessions/:id/start', async (req, res) => {
    try {
      res.json({ session: await deps.manager.start(String(req.params.id)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post('/sessions/:id/finish', async (req, res) => {
    try {
      res.json({ session: await deps.manager.finish(String(req.params.id)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
