// Response ordering for polled requests, pure. Each request takes a number when issued; its response
// is applied only when no later-issued request has already been applied, so a slow old poll never
// overwrites fresher state.

export interface Sequence {
  /** Number of the request about to be sent. */
  issue(): number;
  /** Whether the response of request `n` may be applied; records it when it may. */
  accept(n: number): boolean;
}

export function createSequence(): Sequence {
  let issued = 0;
  let applied = 0;
  return {
    issue: () => ++issued,
    accept: (n) => {
      if (n <= applied) return false;
      applied = n;
      return true;
    },
  };
}
