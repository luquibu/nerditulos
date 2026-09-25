import { describe, expect, it } from 'vitest';
import { createSequence } from './sequence.js';

describe('createSequence', () => {
  it('applies responses in issue order and discards one that arrives after a newer response was applied', () => {
    const seq = createSequence();
    const a = seq.issue();
    const b = seq.issue();
    const c = seq.issue();
    expect(seq.accept(b)).toBe(true);
    expect(seq.accept(a)).toBe(false);
    expect(seq.accept(c)).toBe(true);
    expect(seq.accept(c)).toBe(false);
    const d = seq.issue();
    expect(seq.accept(d)).toBe(true);
  });
});
