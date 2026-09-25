import { createServer } from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './log.js';
import { StreamHub } from './public/streamHub.js';
import { publicRoutes } from './routes/public.js';
import { adminRoutes } from './routes/admin.js';
import { requireAdmin } from './auth/http.js';
import { clerkVerifier, createAdminVerifier } from './auth/token.js';
import { PgSessionStore } from './sessions/SessionStore.js';
import { RuntimeSessionManager } from './sessions/SessionManager.js';
import { warmHubSession } from './sessions/recovery.js';
import { sonioxFactory } from './provider/soniox.js';
import { attachSenderServer } from './ws/sender.js';

export const ROOM_SEED: Array<{ slug: string; name: string }> = [
  { slug: 'sala-1', name: 'Sala 1' },
  { slug: 'sala-2', name: 'Sala 2' },
];

async function main() {
  const log = createLogger({ service: 'nerditulos' });
  const config = loadConfig(process.env);
  const pool = createPool(config.pg, log);
  await runMigrations(pool, log);
  const store = new PgSessionStore(pool);

  const hub = new StreamHub({ publicWindowSegments: config.publicWindowSegments, log });
  const rooms = [];
  for (const [index, seed] of ROOM_SEED.entries()) {
    const room = await store.upsertRoom(seed.slug, seed.name);
    rooms.push(room);
    hub.setRoom({ slug: room.slug, name: room.name, index: index + 1 });
  }

  const manager = new RuntimeSessionManager({
    store,
    rooms,
    hub,
    providerFactory: sonioxFactory(config.sonioxApiKey),
    log,
    config: {
      drainTimeoutMs: config.drainTimeoutMs,
      segmentMaxChars: config.segmentMaxChars,
      sonioxModel: config.sonioxModel,
      publicWindowSegments: config.publicWindowSegments,
      statementTimeoutMs: 5000,
    },
  });
  await manager.boot();

  // Ring warm-up for every room's visible session, after recovery and before listen().
  for (const room of await store.listRooms()) {
    const seeded = rooms.find((r) => r.id === room.id);
    if (!seeded) continue;
    seeded.visibleSessionId = room.visibleSessionId;
    if (!room.visibleSessionId) continue;
    const session = await store.getSession(room.visibleSessionId);
    if (!session) continue;
    const runtime = manager.getRuntime(session.id);
    const row = runtime ? { ...session, state: runtime.state, cause: runtime.cause, completeness: runtime.completeness } : session;
    const streams = await store.loadStreams(session.id);
    hub.installSession(room.slug, await warmHubSession(store, row, streams, config.publicWindowSegments));
  }

  const verifyAdmin = createAdminVerifier({
    adminUserId: config.adminUserId,
    // The reason is a Clerk error code and message; the token itself is never logged.
    verify: clerkVerifier(config.clerkSecretKey, config.allowedOrigins, (reason) => log.warn('token verification failed', { reason })),
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    const started = Date.now();
    // Captured before routing: routers rewrite req.url while they handle the request.
    const path = (req.originalUrl.split('?')[0] ?? '').slice(0, 200);
    res.on('finish', () => {
      // Request logs never include headers; Authorization stays out by construction.
      if (path.startsWith('/api/')) {
        log.info('http', { method: req.method, path, status: res.statusCode, ms: Date.now() - started });
      }
    });
    next();
  });

  app.use('/api', publicRoutes({ config, hub }));
  app.use('/api/admin', adminRoutes({ requireAdmin: requireAdmin(verifyAdmin), manager }));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  const indexHtml = path.join(webDist, 'index.html');
  if (!existsSync(indexHtml)) log.warn('web/dist not found; only the API is served', { webDist });
  app.use(express.static(webDist, { index: false, maxAge: '1h', etag: true }));
  app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/ws/')) {
      res.status(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });

  const server = createServer(app);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  const wss = attachSenderServer(server, { allowedOrigins: config.allowedOrigins, verifyAdmin, manager, log });

  await new Promise<void>((resolve) => server.listen(config.port, '0.0.0.0', resolve));
  log.info('listening', {
    port: config.port,
    appOrigin: config.appOrigin,
    rooms: rooms.map((r) => r.slug),
    adminConfigured: config.adminUserId.length > 0,
    providerConfigured: config.sonioxApiKey.length > 0,
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown', { signal });
    manager.dispose();
    hub.close();
    wss.close();
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: 'fatal', error: message }) + '\n');
  process.exit(1);
});
