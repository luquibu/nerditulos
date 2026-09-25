import type { InterruptionCause, SessionState } from '@nerditulos/shared';

export type CaptureState = 'idle' | 'checking' | 'ready' | 'connecting' | 'waiting' | 'streaming' | 'paused' | 'ending' | 'ended' | 'interrupted' | 'error';
export type StatusTone = 'live' | 'ok' | 'warning' | 'error' | 'off';

export interface ConsoleView {
  chipText: string;
  status: StatusTone;
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canFinish: boolean;
  canReconnect: boolean;
  canChangeSource: boolean;
}

export interface ViewInput {
  sessionState: SessionState | null;
  cause: InterruptionCause | null;
  completeness?: 'complete' | 'incomplete' | null;
  capture: CaptureState;
  sourceChecked: boolean;
}

/** State x cause -> chip text, status token, and enabled actions. One table for the console. */
export function consoleView(input: ViewInput): ConsoleView {
  const { sessionState, cause, capture, sourceChecked } = input;
  const none: ConsoleView = { chipText: 'Sin sesión', status: 'off', canStart: false, canPause: false, canResume: false, canFinish: false, canReconnect: false, canChangeSource: true };
  if (!sessionState) return none;
  switch (sessionState) {
    case 'prepared':
      return { ...none, chipText: 'Preparada', status: 'off', canStart: sourceChecked && (capture === 'ready' || capture === 'idle' || capture === 'ended' || capture === 'error') };
    case 'starting': {
      // Retry when this console's capture is not (or no longer) connecting to the session.
      const connecting = capture === 'connecting' || capture === 'waiting' || capture === 'streaming' || capture === 'paused' || capture === 'ending';
      return {
        ...none,
        chipText: capture === 'waiting' ? 'Esperando cierre de la conexión anterior' : 'Iniciando',
        status: 'warning',
        canFinish: true,
        canReconnect: sourceChecked && !connecting,
        canChangeSource: !connecting,
      };
    }
    case 'live':
      if (capture === 'paused') return { ...none, chipText: 'En vivo · pausada', status: 'live', canResume: true, canFinish: true, canChangeSource: false };
      return { ...none, chipText: 'En vivo', status: 'live', canPause: capture === 'streaming', canFinish: true, canChangeSource: false };
    case 'interrupted': {
      const reconnectable = cause === 'sender_lost' || cause === 'provider_unavailable' || cause === 'storage_unavailable' || cause === 'interrupted_on_restart';
      const text =
        cause === 'sender_lost'
          ? 'Interrumpida: fuente perdida'
          : cause === 'provider_unavailable'
            ? 'Interrumpida: proveedor no disponible'
            : cause === 'provider_error'
              ? 'Interrumpida: error del proveedor'
              : cause === 'storage_unavailable'
                ? 'Interrumpida: almacenamiento no disponible'
                : cause === 'interrupted_on_restart'
                  ? 'Interrumpida: reinicio del servidor'
                  : 'Interrumpida';
      const reconnecting = capture === 'connecting' || capture === 'waiting';
      return {
        ...none,
        chipText: reconnecting ? `${text} · reconectando` : text,
        status: reconnecting ? 'warning' : 'error',
        canReconnect: reconnectable && sourceChecked && !reconnecting,
        canFinish: true,
        canChangeSource: !reconnecting,
      };
    }
    case 'finishing':
      return { ...none, chipText: 'Finalizando', status: 'warning', canChangeSource: false };
    case 'finished':
      return { ...none, chipText: input.completeness === 'incomplete' ? 'Finalizada · contenido incompleto' : 'Finalizada', status: 'off' };
    default:
      return none;
  }
}

export type CheckState = 'pending' | 'ok' | 'warning' | 'error';

export function checkLabel(check: CheckState): string {
  switch (check) {
    case 'ok':
      return 'comprobado';
    case 'warning':
      return 'atención';
    case 'error':
      return 'error';
    default:
      return 'pendiente';
  }
}
