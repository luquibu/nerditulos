export interface PgConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  appOrigin: string;
  allowedOrigins: string[];
  eventName: string;
  sonioxModel: string;
  drainTimeoutMs: number;
  publicWindowSegments: number;
  segmentMaxChars: number;
  clerkPublishableKey: string;
  clerkSecretKey: string;
  sonioxApiKey: string;
  adminUserId: string;
  /** DEMO_MODE=true: administration without identity (see the README, "Demo mode"). */
  demoMode: boolean;
  pg: PgConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function clean(value: string | undefined): string {
  // Values may carry a trailing CR when the env file was written with CRLF line endings.
  return (value ?? '').replace(/\r$/, '').trim();
}

function required(env: Env, name: string): string {
  const value = clean(env[name]);
  if (!value) throw new ConfigError(`Missing required environment variable ${name}`);
  return value;
}

function integer(env: Env, name: string, fallback: number, min: number): number {
  const raw = clean(env[name]);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (value < min) throw new ConfigError(`${name} must be at least ${min}`);
  return value;
}

function flag(env: Env, name: string): boolean {
  const raw = clean(env[name]).toLowerCase();
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new ConfigError(`${name} must be true or false`);
}

function origin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL origin`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError(`${name} must be an origin without path, query, or fragment`);
  }
  return url.origin;
}

export function loadConfig(env: Env): AppConfig {
  const nodeEnv = clean(env.NODE_ENV) || 'development';
  const port = integer(env, 'PORT', 3000, 1);
  const appOrigin = origin(required(env, 'APP_ORIGIN'), 'APP_ORIGIN');
  const allowedOrigins = [appOrigin];
  if (nodeEnv !== 'production') {
    allowedOrigins.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  }
  const pg: PgConfig = {
    host: required(env, 'PGHOST'),
    port: integer(env, 'PGPORT', 5432, 1),
    user: required(env, 'PGUSER'),
    // Passed as a discrete field: never URL-encoded, never placed in a connection string.
    password: (env.PGPASSWORD ?? '').replace(/\r$/, ''),
    database: required(env, 'PGDATABASE'),
  };
  if (!pg.password) throw new ConfigError('Missing required environment variable PGPASSWORD');
  return {
    nodeEnv,
    port,
    appOrigin,
    allowedOrigins,
    eventName: clean(env.EVENT_NAME),
    sonioxModel: clean(env.SONIOX_MODEL) || 'stt-rt-v5',
    drainTimeoutMs: integer(env, 'DRAIN_TIMEOUT_MS', 15000, 1000),
    publicWindowSegments: integer(env, 'PUBLIC_WINDOW_SEGMENTS', 20, 1),
    segmentMaxChars: integer(env, 'SEGMENT_MAX_CHARS', 400, 40),
    clerkPublishableKey: clean(env.CLERK_PUBLISHABLE_KEY),
    clerkSecretKey: clean(env.CLERK_SECRET_KEY),
    sonioxApiKey: clean(env.SONIOX_API_KEY),
    adminUserId: clean(env.ADMIN_USER_ID),
    demoMode: flag(env, 'DEMO_MODE'),
    pg,
  };
}
