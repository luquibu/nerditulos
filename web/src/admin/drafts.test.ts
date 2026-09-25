import { describe, expect, it } from 'vitest';
import { createDraftStore, EMPTY_DRAFT } from './drafts.js';

describe('createDraftStore', () => {
  it('keeps one draft per room and notifies only that room', () => {
    const store = createDraftStore();
    const notified: string[] = [];
    const off1 = store.subscribe('sala-1', () => notified.push('sala-1'));
    store.subscribe('sala-2', () => notified.push('sala-2'));
    expect(store.get('sala-1')).toBe(EMPTY_DRAFT);
    store.set('sala-1', { title: 'Keynote' });
    store.set('sala-2', { language: 'en' });
    expect(store.get('sala-1')).toEqual({ title: 'Keynote', language: 'es' });
    expect(store.get('sala-2')).toEqual({ title: '', language: 'en' });
    expect(notified).toEqual(['sala-1', 'sala-2']);
    // An unchanged patch is silent.
    store.set('sala-1', { title: 'Keynote' });
    expect(notified).toEqual(['sala-1', 'sala-2']);
    off1();
    store.set('sala-1', { title: 'Other' });
    expect(notified).toEqual(['sala-1', 'sala-2']);
  });

  it('clears the submitted title only while the draft still holds it', () => {
    const store = createDraftStore();
    store.set('sala-1', { title: 'Keynote', language: 'en' });
    store.clearTitleIf('sala-1', 'Something else');
    expect(store.get('sala-1').title).toBe('Keynote');
    // The administrator kept typing while the request ran: the newer text survives.
    store.set('sala-1', { title: 'Keynote 2' });
    store.clearTitleIf('sala-1', 'Keynote');
    expect(store.get('sala-1').title).toBe('Keynote 2');
    store.clearTitleIf('sala-1', 'Keynote 2');
    expect(store.get('sala-1')).toEqual({ title: '', language: 'en' });
    // A room without a draft is left alone.
    store.clearTitleIf('sala-9', '');
    expect(store.get('sala-9')).toBe(EMPTY_DRAFT);
  });
});
