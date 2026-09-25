import { describe, expect, it } from 'vitest';
import { consoleStrings } from '../consoleStrings.js';
import { consoleView, formatElapsed, formatTrackProcessing, testLanguageFor, type CaptureState } from './viewModel.js';

const es = consoleStrings('es');
const en = consoleStrings('en');

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
      const view = consoleView(es, { sessionState: row.sessionState, cause: row.cause, capture: row.capture, sourceChecked: row.sourceChecked });
      expect(view.chipText, JSON.stringify(row)).toBe(row.chip);
      expect(view.status, JSON.stringify(row)).toBe(row.status);
      expect(view.canStart, JSON.stringify(row)).toBe(row.start);
    }
  });

  it('renders the chips in English from the English table', () => {
    expect(consoleView(en, { sessionState: null, cause: null, capture: 'idle', sourceChecked: true }).chipText).toBe('No session');
    expect(consoleView(en, { sessionState: 'starting', cause: null, capture: 'waiting', sourceChecked: true }).chipText).toBe('Waiting for the previous connection to close');
    expect(consoleView(en, { sessionState: 'live', cause: null, capture: 'paused', sourceChecked: true }).chipText).toBe('Live · paused');
    expect(consoleView(en, { sessionState: 'interrupted', cause: 'sender_lost', capture: 'connecting', sourceChecked: true }).chipText).toBe('Interrupted: source lost · reconnecting');
  });

  it('enables pause, resume, finish, and reconnect only where the contract allows', () => {
    const live = consoleView(es, { sessionState: 'live', cause: null, capture: 'streaming', sourceChecked: true });
    expect([live.canPause, live.canResume, live.canFinish, live.canReconnect]).toEqual([true, false, true, false]);
    const paused = consoleView(es, { sessionState: 'live', cause: null, capture: 'paused', sourceChecked: true });
    expect([paused.canPause, paused.canResume, paused.canFinish]).toEqual([false, true, true]);
    for (const cause of ['sender_lost', 'provider_unavailable', 'storage_unavailable'] as const) {
      const v = consoleView(es, { sessionState: 'interrupted', cause, capture: 'interrupted', sourceChecked: true });
      expect(v.canReconnect, cause).toBe(true);
      expect(v.canFinish, cause).toBe(true);
    }
    expect(consoleView(es, { sessionState: 'interrupted', cause: 'provider_error', capture: 'interrupted', sourceChecked: true }).canReconnect).toBe(false);
    expect(consoleView(es, { sessionState: 'interrupted', cause: 'sender_lost', capture: 'interrupted', sourceChecked: false }).canReconnect).toBe(false);
    // `starting` offers a retry once this console's connection attempt failed, never while it is connecting.
    expect(consoleView(es, { sessionState: 'starting', cause: null, capture: 'error', sourceChecked: true }).canReconnect).toBe(true);
    expect(consoleView(es, { sessionState: 'starting', cause: null, capture: 'connecting', sourceChecked: true }).canReconnect).toBe(false);
    const finished = consoleView(es, { sessionState: 'finished', cause: null, completeness: 'incomplete', capture: 'ended', sourceChecked: true });
    expect(finished.chipText).toBe('Finalizada · contenido incompleto');
    expect([finished.canStart, finished.canFinish, finished.canReconnect]).toEqual([false, false, false]);
  });

  it('offers the source test, its stop, and monitoring only with a checked source, an idle capture, and no active session', () => {
    const idle: CaptureState[] = ['ready', 'idle', 'ended', 'error'];
    for (const capture of idle) {
      for (const sessionState of [null, 'prepared', 'finished'] as const) {
        const v = consoleView(es, { sessionState, cause: null, capture, sourceChecked: true });
        expect([v.canTest, v.canStopTest, v.canMonitor], `${capture}/${sessionState}`).toEqual([true, false, true]);
        const unchecked = consoleView(es, { sessionState, cause: null, capture, sourceChecked: false });
        expect([unchecked.canTest, unchecked.canMonitor], `${capture}/${sessionState}/unchecked`).toEqual([false, false]);
      }
      for (const sessionState of ['starting', 'live', 'interrupted', 'finishing'] as const) {
        expect(consoleView(es, { sessionState, cause: null, capture, sourceChecked: true }).canTest, `${capture}/${sessionState}`).toBe(false);
      }
    }
    for (const capture of ['checking', 'connecting', 'waiting', 'streaming', 'paused', 'ending', 'interrupted'] as CaptureState[]) {
      const v = consoleView(es, { sessionState: 'prepared', cause: null, capture, sourceChecked: true });
      expect([v.canTest, v.canStopTest, v.canMonitor], capture).toEqual([false, false, false]);
    }
    const testing = consoleView(es, { sessionState: 'prepared', cause: null, capture: 'testing', sourceChecked: true });
    expect([testing.canTest, testing.canStopTest, testing.canMonitor, testing.canStart]).toEqual([false, true, true, true]);
    expect(consoleView(es, { sessionState: null, cause: null, capture: 'testing', sourceChecked: true }).canStopTest).toBe(true);
    expect(consoleView(es, { sessionState: 'live', cause: null, capture: 'streaming', sourceChecked: true }).canMonitor).toBe(false);
  });

  it('warns next to "Iniciar" when the source had no recent signal or was never tested', () => {
    const base = { sessionState: 'prepared' as const, cause: null, capture: 'ready' as const, sourceChecked: true };
    expect(consoleView(es, { ...base, signal: 'ok', tested: true }).startWarning).toBeNull();
    expect(consoleView(es, { ...base, signal: 'ok', tested: false }).startWarning).toBe('untested');
    expect(consoleView(es, { ...base, signal: 'pending', tested: false }).startWarning).toBe('untested');
    expect(consoleView(es, { ...base, signal: 'warning', tested: true }).startWarning).toBe('no_signal');
    expect(consoleView(es, { ...base, signal: 'warning', tested: false }).startWarning).toBe('no_signal');
    expect(consoleView(es, { ...base, signal: 'error', tested: true }).startWarning).toBe('no_signal');
    // Only where "Iniciar" is offered.
    expect(consoleView(es, { ...base, sourceChecked: false, signal: 'warning' }).startWarning).toBeNull();
    expect(consoleView(es, { ...base, sessionState: 'live', capture: 'streaming', signal: 'warning' }).startWarning).toBeNull();
    expect(consoleView(es, { ...base, sessionState: null, signal: 'warning' }).startWarning).toBeNull();
    // Rows without the new inputs keep working and default to "untested".
    expect(consoleView(es, base).startWarning).toBe('untested');
  });
});

describe('console helpers', () => {
  it('picks the test language from the most recently prepared session, or Spanish', () => {
    expect(testLanguageFor([])).toBe('es');
    expect(testLanguageFor([{ state: 'finished', sourceLanguage: 'en', createdAt: '2026-09-25T10:00:00.000Z' }])).toBe('es');
    expect(
      testLanguageFor([
        { state: 'prepared', sourceLanguage: 'en', createdAt: '2026-09-25T10:00:00.000Z' },
        { state: 'prepared', sourceLanguage: 'es', createdAt: '2026-09-25T09:00:00.000Z' },
        { state: 'live', sourceLanguage: 'es', createdAt: '2026-09-25T11:00:00.000Z' },
      ]),
    ).toBe('en');
  });

  it('formats the track processing and the elapsed time', () => {
    expect(formatTrackProcessing(es, { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 1 })).toBe('Eco: cancelado · Ruido: suprimido · Ganancia: automática · 48 kHz · mono');
    expect(formatTrackProcessing(es, { echoCancellation: false, sampleRate: 44100, channelCount: 2 })).toBe('Eco: sin cancelar · 44.1 kHz · estéreo');
    expect(formatTrackProcessing(es, {})).toBe('sin datos del navegador');
    expect(formatTrackProcessing(es, null)).toBe('sin datos del navegador');
    expect(formatTrackProcessing(en, { echoCancellation: true, noiseSuppression: false, autoGainControl: false, sampleRate: 16000, channelCount: 3 })).toBe('Echo: cancelled · Noise: not suppressed · Gain: manual · 16 kHz · 3 channels');
    expect(formatTrackProcessing(en, null)).toBe('no data from the browser');
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(999)).toBe('0:00');
    expect(formatElapsed(1000)).toBe('0:01');
    expect(formatElapsed(61500)).toBe('1:01');
    expect(formatElapsed(600000)).toBe('10:00');
  });
});
