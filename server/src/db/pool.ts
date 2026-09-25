import pg from 'pg';
import type { PgConfig } from '../config.js';
import type { Logger } from '../log.js';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(config: PgConfig, log: Logger): pg.Pool {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: 10,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  pool.on('error', (error) => {
    log.error('pg pool error', { error: error.message });
  });
  return pool;
}
