// Generation counter for the capture runtime, pure. Every operation that awaits (device access,
// socket open, file play) takes the generation at its start and re-checks it after each await: a
// newer operation on the same room (another source, a stop, a finish) bumps it, and the older one
// releases whatever it acquired instead of applying it.

export interface Generation {
  /** The current generation number. */
  current(): number;
  /** Invalidates every in-flight operation and returns the new generation. */
  bump(): number;
  /** Whether an operation started at `started` is still the latest one. */
  isCurrent(started: number): boolean;
}

export function createGeneration(): Generation {
  let value = 0;
  return {
    current: () => value,
    bump: () => ++value,
    isCurrent: (started) => started === value,
  };
}
