import { describe, expect, it } from 'vitest';
import { createGeneration } from './generation.js';

describe('createGeneration', () => {
  it('keeps an operation current until a newer one bumps the counter', () => {
    const g = createGeneration();
    const first = g.current();
    expect(g.isCurrent(first)).toBe(true);
    const second = g.bump();
    expect(second).toBe(first + 1);
    expect(g.isCurrent(first)).toBe(false);
    expect(g.isCurrent(second)).toBe(true);
    g.bump();
    expect(g.isCurrent(second)).toBe(false);
    expect(g.current()).toBe(first + 2);
  });
});
