// The "prepare a session" form values per room, kept outside React so they survive navigating
// away from the console and back, tab switches, and re-renders. One store per page; pure.
import type { SourceLanguage } from '@nerditulos/shared';

export interface Draft {
  title: string;
  language: SourceLanguage;
}

export const EMPTY_DRAFT: Draft = { title: '', language: 'es' };

export interface DraftStore {
  get(slug: string): Draft;
  set(slug: string, patch: Partial<Draft>): void;
  /** Clears the title only when it still equals `submitted`: a title typed meanwhile stays. */
  clearTitleIf(slug: string, submitted: string): void;
  subscribe(slug: string, listener: () => void): () => void;
}

export function createDraftStore(): DraftStore {
  const drafts = new Map<string, Draft>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (slug: string) => {
    for (const listener of listeners.get(slug) ?? []) listener();
  };
  return {
    get: (slug) => drafts.get(slug) ?? EMPTY_DRAFT,
    set: (slug, patch) => {
      const current = drafts.get(slug) ?? EMPTY_DRAFT;
      const next = { ...current, ...patch };
      if (next.title === current.title && next.language === current.language) return;
      drafts.set(slug, next);
      notify(slug);
    },
    clearTitleIf: (slug, submitted) => {
      const current = drafts.get(slug);
      if (!current || current.title !== submitted) return;
      drafts.set(slug, { ...current, title: '' });
      notify(slug);
    },
    subscribe: (slug, listener) => {
      let set = listeners.get(slug);
      if (!set) {
        set = new Set();
        listeners.set(slug, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
  };
}

/** The page's store. */
export const drafts: DraftStore = createDraftStore();
