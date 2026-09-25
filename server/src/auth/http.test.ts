import { describe, expect, it } from 'vitest';
import type { AdminVerifier } from './token.js';
import { requireAdmin, type AdminIdentity } from './http.js';

const ALLOWED = ['https://captions.example.org'];

interface Outcome {
  status: number | null;
  body: unknown;
  next: boolean;
  admin: AdminIdentity | undefined;
}

function run(handler: ReturnType<typeof requireAdmin>, input: { method: string; origin?: string | string[]; authorization?: string }): Promise<Outcome> {
  return new Promise((resolve) => {
    const out: Outcome = { status: null, body: null, next: false, admin: undefined };
    const locals: { admin?: AdminIdentity } = {};
    const req = {
      method: input.method,
      headers: { origin: input.origin },
      header: (name: string) => (name.toLowerCase() === 'authorization' ? input.authorization : undefined),
    };
    const res = {
      locals,
      status(code: number) {
        out.status = code;
        return this;
      },
      json(body: unknown) {
        out.body = body;
        resolve({ ...out, admin: locals.admin });
      },
    };
    void handler(req as never, res as never, () => {
      out.next = true;
      resolve({ ...out, admin: locals.admin });
    });
  });
}

describe('requireAdmin', () => {
  it('in demo mode grants every GET without calling the verifier, and gates mutations on an allowed Origin', async () => {
    let calls = 0;
    const verify: AdminVerifier = async () => {
      calls++;
      return { ok: false, code: 'unauthenticated' };
    };
    const handler = requireAdmin(verify, { demoMode: true, allowedOrigins: ALLOWED });
    expect(await run(handler, { method: 'GET' })).toMatchObject({ next: true, admin: { kind: 'demo' } });
    expect(await run(handler, { method: 'GET', origin: 'https://evil.example' })).toMatchObject({ next: true });
    expect(await run(handler, { method: 'POST', origin: 'https://captions.example.org' })).toMatchObject({ next: true, admin: { kind: 'demo' } });
    expect(await run(handler, { method: 'DELETE', origin: 'https://captions.example.org' })).toMatchObject({ next: true });
    const refused: Array<string | string[] | undefined> = [undefined, '', 'null', 'https://evil.example', 'https://captions.example.org, https://evil.example', ['https://captions.example.org', 'https://evil.example']];
    for (const origin of refused) {
      expect(await run(handler, { method: 'POST', origin, authorization: 'Bearer valid' }), JSON.stringify(origin)).toMatchObject({ status: 403, body: { error: 'origin_not_allowed' }, next: false });
    }
    expect(calls).toBe(0);
  });

  it('with Clerk verifies the bearer, rejects a foreign origin on mutations, and accepts a missing one with a valid token', async () => {
    const verify: AdminVerifier = async (token) => {
      if (token === 'valid') return { ok: true, userId: 'user_admin', exp: 1000 };
      if (token === 'other') return { ok: false, code: 'forbidden' };
      if (token === 'none') return { ok: false, code: 'not_configured' };
      if (token === 'boom') throw new Error('network');
      return { ok: false, code: 'unauthenticated' };
    };
    const handler = requireAdmin(verify, { demoMode: false, allowedOrigins: ALLOWED });
    expect(await run(handler, { method: 'GET', authorization: 'Bearer valid' })).toMatchObject({ next: true, admin: { kind: 'clerk', userId: 'user_admin', exp: 1000 } });
    expect(await run(handler, { method: 'GET' })).toMatchObject({ status: 401, body: { error: 'unauthenticated' } });
    expect(await run(handler, { method: 'GET', authorization: 'Bearer garbage' })).toMatchObject({ status: 401 });
    expect(await run(handler, { method: 'GET', authorization: 'Bearer other' })).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await run(handler, { method: 'GET', authorization: 'Bearer none' })).toMatchObject({ status: 503, body: { error: 'admin_not_configured' } });
    expect(await run(handler, { method: 'GET', authorization: 'Bearer boom' })).toMatchObject({ status: 503, body: { error: 'auth_unavailable' } });
    expect(await run(handler, { method: 'POST', authorization: 'Bearer valid' })).toMatchObject({ next: true });
    expect(await run(handler, { method: 'POST', origin: 'https://captions.example.org', authorization: 'Bearer valid' })).toMatchObject({ next: true });
    expect(await run(handler, { method: 'POST', origin: 'https://evil.example', authorization: 'Bearer valid' })).toMatchObject({ status: 403, body: { error: 'origin_not_allowed' } });
    expect(await run(handler, { method: 'POST', origin: 'null', authorization: 'Bearer valid' })).toMatchObject({ status: 403, body: { error: 'origin_not_allowed' } });
    // The origin is checked before the token, so a foreign page never learns whether a stolen token works.
    expect(await run(handler, { method: 'POST', origin: 'https://evil.example', authorization: 'Bearer garbage' })).toMatchObject({ status: 403, body: { error: 'origin_not_allowed' } });
    expect(await run(handler, { method: 'POST', origin: 'https://captions.example.org' })).toMatchObject({ status: 401 });
  });
});
