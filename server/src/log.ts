// Structured JSON lines on stdout. Callers are responsible for never passing secrets or text.
export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function write(level: Level, base: Record<string, unknown>, msg: string, fields?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...base, ...(fields ?? {}) });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export function createLogger(base: Record<string, unknown> = {}): Logger {
  return {
    debug: (msg, fields) => write('debug', base, msg, fields),
    info: (msg, fields) => write('info', base, msg, fields),
    warn: (msg, fields) => write('warn', base, msg, fields),
    error: (msg, fields) => write('error', base, msg, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
