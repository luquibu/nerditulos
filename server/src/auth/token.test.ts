import { describe, expect, it } from 'vitest';
import { createAdminVerifier, type RawVerifyResult } from './token.js';

const ADMIN = 'user_admin_1';

function fakeVerifier(table: Record<string, RawVerifyResult>) {
  return async (token: string): Promise<RawVerifyResult> => table[token] ?? { errors: [{ reason: 'token-invalid' }] };
}

const table: Record<string, RawVerifyResult> = {
  valid: { data: { sub: ADMIN, exp: 1_800_000_000 } },
  other: { data: { sub: 'user_other', exp: 1_800_000_000 } },
  expired: { errors: [{ reason: 'token-expired' }] },
  errorsAndData: { data: { sub: ADMIN, exp: 1_800_000_000 }, errors: [{ reason: 'token-invalid-authorized-parties' }] },
  noSub: { data: { exp: 1_800_000_000 } },
  emptySub: { data: { sub: '', exp: 1_800_000_000 } },
  noExp: { data: { sub: ADMIN } },
};

describe('createAdminVerifier', () => {
  const verify = createAdminVerifier({ adminUserId: ADMIN, verify: fakeVerifier(table) });

  it('authorizes only the configured administrator', async () => {
    await expect(verify('valid')).resolves.toEqual({ ok: true, userId: ADMIN, exp: 1_800_000_000_000 });
    await expect(verify('other')).resolves.toEqual({ ok: false, code: 'forbidden' });
  });

  it('rejects garbage, verification errors, and expired tokens as unauthenticated', async () => {
    await expect(verify('garbage')).resolves.toEqual({ ok: false, code: 'unauthenticated' });
    await expect(verify('')).resolves.toEqual({ ok: false, code: 'unauthenticated' });
    await expect(verify('expired')).resolves.toEqual({ ok: false, code: 'unauthenticated' });
    await expect(verify('errorsAndData')).resolves.toEqual({ ok: false, code: 'unauthenticated' });
    await expect(verify('noSub')).resolves.toEqual({ ok: false, code: 'unauthenticated' });
    await expect(verify('emptySub')).resolves.toEqual({ ok: false, code: 'unauthenticated' });
    await expect(verify('noExp')).resolves.toEqual({ ok: false, code: 'unauthenticated' });
  });

  it('grants nothing when ADMIN_USER_ID is empty, even to a valid token', async () => {
    const unconfigured = createAdminVerifier({ adminUserId: '  ', verify: fakeVerifier(table) });
    await expect(unconfigured('valid')).resolves.toEqual({ ok: false, code: 'not_configured' });
    await expect(unconfigured('other')).resolves.toEqual({ ok: false, code: 'not_configured' });
    await expect(unconfigured('garbage')).resolves.toEqual({ ok: false, code: 'unauthenticated' });
  });

  it('treats a throwing raw verifier as unauthenticated', async () => {
    const throwing = createAdminVerifier({
      adminUserId: ADMIN,
      verify: async () => {
        throw new Error('network');
      },
    });
    await expect(throwing('valid')).rejects.toThrow('network');
  });
});
