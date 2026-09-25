import type { InterruptionCause, SessionState } from '@nerditulos/shared';
import type { ConsoleStrings } from '../consoleStrings.js';

export type CaptureState = 'idle' | 'checking' | 'ready' | 'testing' | 'connecting' | 'waiting' | 'streaming' | 'paused' | 'ending' | 'ended' | 'interrupted' | 'error';
export type StatusTone = 'live' | 'ok' | 'warning' | 'error' | 'off';
export type StartWarning = 'no_signal' | 'untested';

export interface ConsoleView {
  chipText: string;
  status: StatusTone;
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canFinish: boolean;
  canReconnect: boolean;
  canChangeSource: boolean;
  canTest: boolean;
  canStopTest: boolean;
  canMonitor: boolean;
  /** Shown next to "Iniciar" when it is enabled but the source gave no recent signal or was never tested. */
  startWarning: StartWarning | null;
}

export interface ViewInput {
  sessionState: SessionState | null;
  cause: InterruptionCause | null;
  completeness?: 'complete' | 'incomplete' | null;
  capture: CaptureState;
  sourceChecked: boolean;
  signal?: CheckState;
  tested?: boolean;
}

/** State x cause -> chip text (from `d`), status token, and enabled actions. One table for the console. */
export function consoleView(d: ConsoleStrings, input: ViewInput): ConsoleView {
  const { sessionState, cause, capture, sourceChecked } = input;
  const idleCapture = capture === 'ready' || capture === 'idle' || capture === 'ended' || capture === 'error';
  const noActive = sessionState === null || sessionState === 'prepared' || sessionState === 'finished';
  const none: ConsoleView = {
    chipText: d.noSession,
    status: 'off',
    canStart: false,
    canPause: false,
    canResume: false,
    canFinish: false,
    canReconnect: false,
    canChangeSource: true,
    canTest: sourceChecked && idleCapture && noActive,
    canStopTest: capture === 'testing',
    canMonitor: sourceChecked && (idleCapture || capture === 'testing'),
    startWarning: null,
  };
  const withWarning = (view: ConsoleView): ConsoleView => {
    if (!view.canStart) return view;
    const signal = input.signal ?? 'pending';
    if (signal === 'warning' || signal === 'error') return { ...view, startWarning: 'no_signal' };
    if (!input.tested) return { ...view, startWarning: 'untested' };
    return view;
  };
  if (!sessionState) return none;
  switch (sessionState) {
    case 'prepared':
      return withWarning({ ...none, chipText: d.statePrepared, status: 'off', canStart: sourceChecked && (idleCapture || capture === 'testing') });
    case 'starting': {
      // Retry when this console's capture is not (or no longer) connecting to the session.
      const connecting = capture === 'connecting' || capture === 'waiting' || capture === 'streaming' || capture === 'paused' || capture === 'ending';
      return {
        ...none,
        chipText: capture === 'waiting' ? d.chipWaitingPrevious : d.stateStarting,
        status: 'warning',
        canFinish: true,
        canReconnect: sourceChecked && !connecting,
        canChangeSource: !connecting,
      };
    }
    case 'live':
      if (capture === 'paused') return { ...none, chipText: d.chipLivePaused, status: 'live', canResume: true, canFinish: true, canChangeSource: false, canMonitor: false };
      return { ...none, chipText: d.stateLive, status: 'live', canPause: capture === 'streaming', canFinish: true, canChangeSource: false, canMonitor: false };
    case 'interrupted': {
      const reconnectable = cause === 'sender_lost' || cause === 'provider_unavailable' || cause === 'storage_unavailable' || cause === 'interrupted_on_restart';
      const text =
        cause === 'sender_lost'
          ? d.stateInterruptedSenderLost
          : cause === 'provider_unavailable'
            ? d.stateInterruptedProvider
            : cause === 'provider_error'
              ? d.chipInterruptedProviderError
              : cause === 'storage_unavailable'
                ? d.stateInterruptedStorage
                : cause === 'interrupted_on_restart'
                  ? d.chipInterruptedRestart
                  : d.stateInterrupted;
      const reconnecting = capture === 'connecting' || capture === 'waiting';
      return {
        ...none,
        chipText: reconnecting ? `${text} · ${d.chipReconnectingSuffix}` : text,
        status: reconnecting ? 'warning' : 'error',
        canReconnect: reconnectable && sourceChecked && !reconnecting,
        canFinish: true,
        canChangeSource: !reconnecting,
      };
    }
    case 'finishing':
      return { ...none, chipText: d.stateFinishing, status: 'warning', canChangeSource: false, canMonitor: false };
    case 'finished':
      return { ...none, chipText: input.completeness === 'incomplete' ? d.stateFinishedIncomplete : d.stateFinished, status: 'off' };
    default:
      return none;
  }
}

export type CheckState = 'pending' | 'ok' | 'warning' | 'error';

export function checkLabel(d: ConsoleStrings, check: CheckState): string {
  return d.checkLabel[check];
}

export function startWarningText(d: ConsoleStrings, warning: StartWarning): string {
  return d.startWarning[warning];
}

/** The processing the browser applied to the microphone track, read-only. */
export function formatTrackProcessing(d: ConsoleStrings, settings: Partial<MediaTrackSettings> | null): string {
  if (!settings) return d.noBrowserData;
  const parts: string[] = [];
  if (typeof settings.echoCancellation === 'boolean') parts.push(settings.echoCancellation ? d.echoOn : d.echoOff);
  if (typeof settings.noiseSuppression === 'boolean') parts.push(settings.noiseSuppression ? d.noiseOn : d.noiseOff);
  if (typeof settings.autoGainControl === 'boolean') parts.push(settings.autoGainControl ? d.gainAuto : d.gainManual);
  if (typeof settings.sampleRate === 'number') parts.push(`${settings.sampleRate % 1000 === 0 ? settings.sampleRate / 1000 : (settings.sampleRate / 1000).toFixed(1)} kHz`);
  if (typeof settings.channelCount === 'number') parts.push(settings.channelCount === 1 ? d.mono : settings.channelCount === 2 ? d.stereo : d.channels(settings.channelCount));
  return parts.length > 0 ? parts.join(' · ') : d.noBrowserData;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}
