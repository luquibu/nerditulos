import { describe, expect, it } from 'vitest';
import { decideAfterTestActive, decideStart } from './startDecision.js';

describe('decideStart', () => {
  it('sends without confirmation when the room has no test or the test is this console\'s own', () => {
    expect(decideStart({ roomTest: null, ownTestId: null })).toEqual({ kind: 'send', confirmedTestId: null });
    expect(decideStart({ roomTest: null, ownTestId: 't1' })).toEqual({ kind: 'send', confirmedTestId: null });
    expect(decideStart({ roomTest: { id: 't1', sourceLanguage: 'es' }, ownTestId: 't1' })).toEqual({ kind: 'send', confirmedTestId: 't1' });
  });

  it('asks for confirmation bound to a foreign test', () => {
    expect(decideStart({ roomTest: { id: 't2', sourceLanguage: 'en' }, ownTestId: 't1' })).toEqual({ kind: 'confirm', testId: 't2', testSourceLanguage: 'en' });
    expect(decideStart({ roomTest: { id: 't2', sourceLanguage: 'en' }, ownTestId: null })).toEqual({ kind: 'confirm', testId: 't2', testSourceLanguage: 'en' });
  });
});

describe('decideAfterTestActive', () => {
  it('asks again for a different test, sends for an own one, and gives up on the id just confirmed', () => {
    expect(decideAfterTestActive({ refusedTestId: 't3', refusedSourceLanguage: 'es', confirmedTestId: 't2', ownTestId: null })).toEqual({ kind: 'confirm', testId: 't3', testSourceLanguage: 'es' });
    expect(decideAfterTestActive({ refusedTestId: 't3', refusedSourceLanguage: 'es', confirmedTestId: null, ownTestId: 't3' })).toEqual({ kind: 'send', confirmedTestId: 't3' });
    expect(decideAfterTestActive({ refusedTestId: 't2', refusedSourceLanguage: 'es', confirmedTestId: 't2', ownTestId: null })).toBeNull();
  });
});
