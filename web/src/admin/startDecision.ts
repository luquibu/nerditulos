// What "Iniciar" does about the room's source test, pure. A start over the console's own test just
// confirms it (its audio continues into the session); a start over someone else's test asks first,
// bound to that test's id, so a confirmation never ends a newer test.
import type { AdminSourceTest, SourceLanguage } from '@nerditulos/shared';

export type StartDecision =
  | { kind: 'send'; confirmedTestId: string | null }
  | { kind: 'confirm'; testId: string; testSourceLanguage: SourceLanguage };

export function decideStart(input: { roomTest: Pick<AdminSourceTest, 'id' | 'sourceLanguage'> | null; ownTestId: string | null }): StartDecision {
  const { roomTest, ownTestId } = input;
  if (!roomTest) return { kind: 'send', confirmedTestId: null };
  if (ownTestId !== null && roomTest.id === ownTestId) return { kind: 'send', confirmedTestId: roomTest.id };
  return { kind: 'confirm', testId: roomTest.id, testSourceLanguage: roomTest.sourceLanguage };
}

/**
 * The server refused with `test_active {testId}`: the confirmation to ask for, or none when the
 * refused id is the one already confirmed (the console then reports the failure instead of looping).
 */
export function decideAfterTestActive(input: { refusedTestId: string; refusedSourceLanguage: SourceLanguage; confirmedTestId: string | null; ownTestId: string | null }): StartDecision | null {
  if (input.refusedTestId === input.confirmedTestId) return null;
  return decideStart({ roomTest: { id: input.refusedTestId, sourceLanguage: input.refusedSourceLanguage }, ownTestId: input.ownTestId });
}
