import { describe, expect, it } from 'vitest';
import { checkOrigin } from './origin.js';

const ALLOWED = ['https://captions.example.org', 'http://localhost:3000'];

describe('checkOrigin', () => {
  it('reports an absent or empty header as missing', () => {
    expect(checkOrigin(undefined, ALLOWED)).toBe('missing');
    expect(checkOrigin('', ALLOWED)).toBe('missing');
    expect(checkOrigin('   ', ALLOWED)).toBe('missing');
    expect(checkOrigin([], ALLOWED)).toBe('missing');
  });

  it('accepts a single allowed origin, normalized', () => {
    expect(checkOrigin('https://captions.example.org', ALLOWED)).toBe('ok');
    expect(checkOrigin('https://CAPTIONS.example.org', ALLOWED)).toBe('ok');
    expect(checkOrigin('https://captions.example.org/', ALLOWED)).toBe('ok');
    expect(checkOrigin(['http://localhost:3000'], ALLOWED)).toBe('ok');
  });

  it('rejects null, multiple values, malformed values, paths, and foreign origins', () => {
    expect(checkOrigin('null', ALLOWED)).toBe('invalid');
    expect(checkOrigin('https://captions.example.org, https://evil.example', ALLOWED)).toBe('invalid');
    expect(checkOrigin(['https://captions.example.org', 'https://evil.example'], ALLOWED)).toBe('invalid');
    expect(checkOrigin('captions.example.org', ALLOWED)).toBe('invalid');
    expect(checkOrigin('https://captions.example.org/admin', ALLOWED)).toBe('invalid');
    expect(checkOrigin('https://captions.example.org?x=1', ALLOWED)).toBe('invalid');
    expect(checkOrigin('https://evil.example', ALLOWED)).toBe('invalid');
    expect(checkOrigin('http://captions.example.org', ALLOWED)).toBe('invalid');
    expect(checkOrigin('https://captions.example.org:444', ALLOWED)).toBe('invalid');
  });
});
