// tsc does not copy .sql files; keep migrations next to the compiled migrate module.
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));
const dest = fileURLToPath(new URL('../dist/db/migrations/', import.meta.url));
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true, filter: (p) => p.endsWith('.sql') || !p.includes('.') });
