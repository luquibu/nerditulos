import { describe, expect, it } from 'vitest';
import { consoleView } from './viewModel.js';

describe('consoleView', () => {
  it('maps state x cause to chip, status token, and actions', () => {
    const table = [
      { sessionState: null, cause: null, capture: 'idle', sourceChecked: true, chip: 'Sin sesión', status: 'off', start: false },
      { sessionState: 'prepared', cause: null, capture: 'ready', sourceChecked: true, chip: 'Preparada', status: 'off', start: true },
      { sessionState: 'prepared', cause: null, capture: 'ready', sourceChecked: false, chip: 'Preparada', status: 'off', start: false },
      { sessionState: 'starting', cause: null, capture: 'connecting', sourceChecked: true, chip: 'Iniciando', status: 'warning', start: false },
      { sessionState: 'starting', cause: null, capture: 'waiting', sourceChecked: true, chip: 'Esperando cierre de la conexión anterior', status: 'warning', start: false },
      { sessionState: 'live', cause: null, capture: 'streaming', sourceChecked: true, chip: 'En vivo', status: 'live', start: false },
      { sessionState: 'live', cause: null, capture: 'paused', sourceChecked: true, chip: 'En vivo · pausada', status: 'live', start: false },
      { sessionState: 'interrupted', cause: 'sender_lost', capture: 'interrupted', sourceChecked: true, chip: 'Interrumpida: fuente perdida', status: 'error', start: false },
      { sessionState: 'interrupted', cause: 'provider_unavailable', capture: 'interrupted', sourceChecked: true, chip: 'Interrumpida: proveedor no disponible', status: 'error', start: false },
      { sessionState: 'interrupted', cause: 'storage_unavailable', capture: 'interrupted', sourceChecked: true, chip: 'Interrumpida: almacenamiento no disponible', status: 'error', start: false },
      { sessionState: 'interrupted', cause: 'provider_error', capture: 'interrupted', sourceChecked: true, chip: 'Interrumpida: error del proveedor', status: 'error', start: false },
      { sessionState: 'interrupted', cause: 'sender_lost', capture: 'connecting', sourceChecked: true, chip: 'Interrumpida: fuente perdida · reconectando', status: 'warning', start: false },
      { sessionState: 'finishing', cause: null, capture: 'ending', sourceChecked: true, chip: 'Finalizando', status: 'warning', start: false },
      { sessionState: 'finished', cause: null, capture: 'ended', sourceChecked: true, chip: 'Finalizada', status: 'off', start: false },
    ] as const;
    for (const row of table) {
      const view = consoleView({ sessionState: row.sessionState, cause: row.cause, capture: row.capture, sourceChecked: row.sourceChecked });
      expect(view.chipText, JSON.stringify(row)).toBe(row.chip);
      expect(view.status, JSON.stringify(row)).toBe(row.status);
      expect(view.canStart, JSON.stringify(row)).toBe(row.start);
    }
  });

  it('enables pause, resume, finish, and reconnect only where the contract allows', () => {
    const live = consoleView({ sessionState: 'live', cause: null, capture: 'streaming', sourceChecked: true });
    expect([live.canPause, live.canResume, live.canFinish, live.canReconnect]).toEqual([true, false, true, false]);
    const paused = consoleView({ sessionState: 'live', cause: null, capture: 'paused', sourceChecked: true });
    expect([paused.canPause, paused.canResume, paused.canFinish]).toEqual([false, true, true]);
    for (const cause of ['sender_lost', 'provider_unavailable', 'storage_unavailable'] as const) {
      const v = consoleView({ sessionState: 'interrupted', cause, capture: 'interrupted', sourceChecked: true });
      expect(v.canReconnect, cause).toBe(true);
      expect(v.canFinish, cause).toBe(true);
    }
    expect(consoleView({ sessionState: 'interrupted', cause: 'provider_error', capture: 'interrupted', sourceChecked: true }).canReconnect).toBe(false);
    expect(consoleView({ sessionState: 'interrupted', cause: 'sender_lost', capture: 'interrupted', sourceChecked: false }).canReconnect).toBe(false);
    // `starting` offers a retry once this console's connection attempt failed, never while it is connecting.
    expect(consoleView({ sessionState: 'starting', cause: null, capture: 'error', sourceChecked: true }).canReconnect).toBe(true);
    expect(consoleView({ sessionState: 'starting', cause: null, capture: 'connecting', sourceChecked: true }).canReconnect).toBe(false);
    const finished = consoleView({ sessionState: 'finished', cause: null, completeness: 'incomplete', capture: 'ended', sourceChecked: true });
    expect(finished.chipText).toBe('Finalizada · contenido incompleto');
    expect([finished.canStart, finished.canFinish, finished.canReconnect]).toEqual([false, false, false]);
  });
});
