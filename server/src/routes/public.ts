import { Router } from 'express';
import type { RuntimeConfig } from '@nerditulos/shared';
import type { AppConfig } from '../config.js';
import type { StreamHub } from '../public/streamHub.js';

export function publicRoutes(deps: { config: AppConfig; hub: StreamHub }): Router {
  const router = Router();
  const { config, hub } = deps;

  router.get('/config', (_req, res) => {
    const body: RuntimeConfig = {
      clerkPublishableKey: config.clerkPublishableKey,
      eventName: config.eventName,
      adminConfigured: config.adminUserId.length > 0,
      publicWindowSegments: config.publicWindowSegments,
      drainTimeoutMs: config.drainTimeoutMs,
    };
    res.json(body);
  });

  router.get('/time', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ serverTime: Date.now() });
  });

  router.get('/rooms', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ rooms: hub.listPublicRooms() });
  });

  router.get('/rooms/:slug', (req, res) => {
    const room = hub.getPublicRoom(String(req.params.slug));
    if (!room) {
      res.status(404).json({ error: 'room_not_found' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(room);
  });

  router.get('/rooms/:slug/stream', (req, res) => {
    const slug = String(req.params.slug);
    if (!hub.hasRoom(slug)) {
      res.status(404).json({ error: 'room_not_found' });
      return;
    }
    const lang = typeof req.query.lang === 'string' ? req.query.lang : '';
    const lastEventId = req.header('last-event-id');
    const after = typeof req.query.after === 'string' ? req.query.after : null;
    const cursor = lastEventId && lastEventId.length > 0 ? lastEventId : after;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 30000);
    hub.subscribe(slug, lang, cursor, res);
  });

  return router;
}
