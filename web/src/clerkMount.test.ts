import { describe, expect, it } from 'vitest';
import { shouldMountClerk } from './clerkMount.js';

describe('shouldMountClerk', () => {
  it('mounts on admin paths only', () => {
    expect(shouldMountClerk('/admin', false)).toBe(true);
    expect(shouldMountClerk('/admin/', false)).toBe(true);
    expect(shouldMountClerk('/admin/rooms', false)).toBe(true);
    expect(shouldMountClerk('/administrador', false)).toBe(false);
    expect(shouldMountClerk('/', false)).toBe(false);
    expect(shouldMountClerk('/r/sala-1', false)).toBe(false);
  });

  it('keeps Clerk mounted anywhere while a capture is active', () => {
    expect(shouldMountClerk('/', true)).toBe(true);
    expect(shouldMountClerk('/r/sala-1', true)).toBe(true);
  });
});
