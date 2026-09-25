import type { OutputType } from './protocol.js';

export interface Cursor {
  sessionId: string;
  outputType: OutputType;
  language: string;
  seq: number;
}

/** Cursor and SSE event id: `<sessionId>:<outputType>:<language>:<seq>`. */
export function encodeCursor(cursor: Cursor): string {
  return `${cursor.sessionId}:${cursor.outputType}:${cursor.language}:${cursor.seq}`;
}

export function parseCursor(value: string | null | undefined): Cursor | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length !== 4) return null;
  const [sessionId, outputType, language, seqText] = parts as [string, string, string, string];
  if (!sessionId || !language) return null;
  if (outputType !== 'original' && outputType !== 'translation') return null;
  if (!/^\d{1,15}$/.test(seqText)) return null;
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  return { sessionId, outputType, language, seq };
}
