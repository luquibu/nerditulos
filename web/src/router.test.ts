import { describe, expect, it } from 'vitest';
import { adminPath, matchRoute } from './router.js';

describe('matchRoute', () => {
  it('maps the public paths', () => {
    expect(matchRoute('/')).toEqual({ kind: 'rooms' });
    expect(matchRoute('')).toEqual({ kind: 'rooms' });
    expect(matchRoute('/r/sala-1')).toEqual({ kind: 'room', slug: 'sala-1' });
    expect(matchRoute('/r/sala-1/')).toEqual({ kind: 'room', slug: 'sala-1' });
    expect(matchRoute('/r/Sala 1')).toEqual({ kind: 'not_found' });
    expect(matchRoute('/other')).toEqual({ kind: 'not_found' });
  });

  it('maps the console with an optional room slug', () => {
    expect(matchRoute('/admin')).toEqual({ kind: 'admin', slug: null });
    expect(matchRoute('/admin/')).toEqual({ kind: 'admin', slug: null });
    expect(matchRoute('/admin/sala-2')).toEqual({ kind: 'admin', slug: 'sala-2' });
    expect(matchRoute('/admin/sala-2/')).toEqual({ kind: 'admin', slug: 'sala-2' });
    expect(matchRoute('/admin/sala-2/extra')).toEqual({ kind: 'not_found' });
    expect(matchRoute('/administrador')).toEqual({ kind: 'not_found' });
  });

  it('builds the console path of a room', () => {
    expect(adminPath(null)).toBe('/admin');
    expect(adminPath('sala-1')).toBe('/admin/sala-1');
  });
});
