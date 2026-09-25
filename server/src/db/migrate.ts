import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';
import type { Logger } from '../log.js';

// Arbitrary constant shared by every replica so concurrent boots serialize migrations.
const MIGRATION_LOCK_KEY = 7261651;

export const defaultMigrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));

/** Applies every `*.sql` file once, in name order, each in its own transaction. */
export async function runMigrations(pool: Pool, log: Logger, dir: string = defaultMigrationsDir): Promise<string[]> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    const version = path.basename(file, '.sql');
    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      const seen = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (seen.rowCount === 0) {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        applied.push(version);
        log.info('migration applied', { version });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  log.info('migrations checked', { total: files.length, applied: applied.length });
  return applied;
}
