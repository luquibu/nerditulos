import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const base = {
  APP_ORIGIN: 'https://captions.example.org',
  PGHOST: 'db',
  PGUSER: 'app',
  PGPASSWORD: 'secret',
  PGDATABASE: 'app',
};

describe('loadConfig', () => {
  it('requires APP_ORIGIN and the PG fields', () => {
    for (const name of ['APP_ORIGIN', 'PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) {
      const env: Record<string, string | undefined> = { ...base };
      delete env[name];
      expect(() => loadConfig(env), name).toThrow(ConfigError);
    }
  });

  it('passes PG fields through discretely, including reserved characters in the password', () => {
    const config = loadConfig({ ...base, PGPORT: '5433', PGPASSWORD: 'p@/#?%:$w' });
    expect(config.pg).toEqual({ host: 'db', port: 5433, user: 'app', password: 'p@/#?%:$w', database: 'app' });
  });

  it('strips a trailing CR from values written with CRLF endings', () => {
    const config = loadConfig({ ...base, ADMIN_USER_ID: 'user_123\r', EVENT_NAME: 'Nerdearla\r' });
    expect(config.adminUserId).toBe('user_123');
    expect(config.eventName).toBe('Nerdearla');
  });

  it('applies defaults and validates numeric limits', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(3000);
    expect(config.sonioxModel).toBe('stt-rt-v5');
    expect(config.drainTimeoutMs).toBe(15000);
    expect(config.publicWindowSegments).toBe(20);
    expect(config.segmentMaxChars).toBe(400);
    expect(() => loadConfig({ ...base, DRAIN_TIMEOUT_MS: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PUBLIC_WINDOW_SEGMENTS: '0' })).toThrow(ConfigError);
  });

  it('reads DEMO_MODE as a strict flag: unset and false are off, true is on, anything else is an error', () => {
    expect(loadConfig(base).demoMode).toBe(false);
    expect(loadConfig({ ...base, DEMO_MODE: '' }).demoMode).toBe(false);
    expect(loadConfig({ ...base, DEMO_MODE: 'false' }).demoMode).toBe(false);
    expect(loadConfig({ ...base, DEMO_MODE: 'true' }).demoMode).toBe(true);
    expect(loadConfig({ ...base, DEMO_MODE: 'True\r' }).demoMode).toBe(true);
    expect(() => loadConfig({ ...base, DEMO_MODE: '1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, DEMO_MODE: 'yes' })).toThrow(ConfigError);
  });

  it('rejects an APP_ORIGIN with a path and adds localhost origins outside production', () => {
    expect(() => loadConfig({ ...base, APP_ORIGIN: 'https://captions.example.org/app' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).allowedOrigins).toEqual(['https://captions.example.org']);
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).allowedOrigins).toEqual([
      'https://captions.example.org',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ]);
  });
});
