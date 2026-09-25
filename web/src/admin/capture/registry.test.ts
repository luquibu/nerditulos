import { describe, expect, it } from 'vitest';
import { getAdminToken, isAnyCaptureActive, registerTokenSupplier, setCaptureActive, subscribeCaptureActive } from './registry.js';

describe('token supplier registry', () => {
  it('serves a renewal from the bridge mounted at that moment; a stale cleanup never clears a newer bridge', async () => {
    const calls: string[] = [];
    const bridgeA = async (options?: { skipCache?: boolean }) => {
      calls.push('a:' + String(options?.skipCache));
      return 'token-a';
    };
    const bridgeB = async (options?: { skipCache?: boolean }) => {
      calls.push('b:' + String(options?.skipCache));
      return 'token-b';
    };
    const unregisterA = registerTokenSupplier(bridgeA);
    expect(await getAdminToken({ skipCache: true })).toBe('token-a');
    // Navigation re-renders the bridge: the new registration can land before the old cleanup runs.
    const unregisterB = registerTokenSupplier(bridgeB);
    unregisterA();
    expect(await getAdminToken({ skipCache: true })).toBe('token-b');
    unregisterB();
    expect(await getAdminToken({ skipCache: true })).toBeNull();
    expect(calls).toEqual(['a:true', 'b:true']);
  });
});

describe('capture-active registry', () => {
  it('notifies only when the first capture starts and the last one stops', () => {
    let notified = 0;
    const unsubscribe = subscribeCaptureActive(() => notified++);
    setCaptureActive('sala-1', true);
    setCaptureActive('sala-2', true);
    setCaptureActive('sala-1', false);
    expect([isAnyCaptureActive(), notified]).toEqual([true, 1]);
    setCaptureActive('sala-2', false);
    expect([isAnyCaptureActive(), notified]).toEqual([false, 2]);
    unsubscribe();
  });
});
