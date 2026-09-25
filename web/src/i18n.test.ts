import { describe, expect, it } from 'vitest';
import type { InterruptionCause, SessionState } from '@nerditulos/shared';
import { LANGUAGES, LANGUAGE_NATIVE_NAMES, STRINGS, isLanguage, readerStateText, stateLabel, strings } from './i18n.js';

const es = strings('es');
const en = strings('en');

describe('strings', () => {
  it('has the same keys in both languages', () => {
    expect(Object.keys(STRINGS.en).sort()).toEqual(Object.keys(STRINGS.es).sort());
    expect(LANGUAGES).toEqual(['es', 'en']);
    expect(isLanguage('en')).toBe(true);
    expect(isLanguage('pt')).toBe(false);
  });

  it('names each language in itself and has the shell strings in both languages', () => {
    expect(Object.keys(LANGUAGE_NATIVE_NAMES).sort()).toEqual([...LANGUAGES].sort());
    expect(LANGUAGE_NATIVE_NAMES).toEqual({ es: 'Español', en: 'English' });
    expect(es.loadingAdmin).not.toBe(en.loadingAdmin);
    expect(es.configLoadFailed).not.toBe(en.configLoadFailed);
  });

  it('composes the fallback notice from language names of the interface language', () => {
    expect(en.languageFallbackNotice(en.languageName.en, en.languageName.es)).toBe('This session does not offer English; showing Spanish.');
    expect(es.languageFallbackNotice(es.languageName.es, es.languageName.en)).toBe('Esta sesión no ofrece español; se muestra inglés.');
  });

  it('describes gaps with or without a known length', () => {
    expect(es.gapTitle('1.6')).toBe('Tramo perdido: 1.6 s');
    expect(es.gapTitle(null)).toBe('Tramo perdido de extensión desconocida');
    expect(en.gapTitle('0.5')).toBe('Lost stretch: 0.5 s');
    expect(en.gapTitle(null)).toBe('Lost stretch of unknown length');
  });
});

describe('stateLabel', () => {
  const cases: Array<[SessionState | undefined, string, string, string]> = [
    ['live', 'En vivo', 'Live', 'live'],
    ['starting', 'Iniciando', 'Starting', 'warning'],
    ['finishing', 'Finalizando', 'Finishing', 'warning'],
    ['interrupted', 'Interrumpida', 'Interrupted', 'error'],
    ['finished', 'Finalizada', 'Finished', 'off'],
    ['prepared', 'Preparada', 'Prepared', 'off'],
    [undefined, 'Sin sesión', 'No session', 'off'],
  ];

  it.each(cases)('labels %s in both languages with its status', (state, spanish, english, status) => {
    expect(stateLabel(es, state)).toEqual({ text: spanish, status });
    expect(stateLabel(en, state)).toEqual({ text: english, status });
  });
});

describe('readerStateText', () => {
  const live = { state: 'live' as const, cause: null, completeness: null };

  it('reports the connection before the session is known, then the missing session', () => {
    expect(readerStateText(es, null, false)).toEqual({ text: 'Conectando', status: 'off' });
    expect(readerStateText(en, live, false)).toEqual({ text: 'Connecting', status: 'off' });
    expect(readerStateText(es, null, true)).toEqual({ text: 'Sin sesión', status: 'off' });
    expect(readerStateText(en, null, true)).toEqual({ text: 'No session', status: 'off' });
  });

  it.each<[InterruptionCause, string, string]>([
    ['sender_lost', 'Interrumpida: fuente perdida', 'Interrupted: source lost'],
    ['provider_error', 'Interrumpida: proveedor no disponible', 'Interrupted: provider unavailable'],
    ['provider_unavailable', 'Interrumpida: proveedor no disponible', 'Interrupted: provider unavailable'],
    ['storage_unavailable', 'Interrumpida: almacenamiento no disponible', 'Interrupted: storage unavailable'],
    ['interrupted_on_restart', 'Interrumpida', 'Interrupted'],
  ])('names the interruption cause %s', (cause, spanish, english) => {
    const session = { state: 'interrupted' as const, cause, completeness: null };
    expect(readerStateText(es, session, true)).toEqual({ text: spanish, status: 'error' });
    expect(readerStateText(en, session, true)).toEqual({ text: english, status: 'error' });
  });

  it('marks an incomplete finish and delegates the other states', () => {
    const incomplete = { state: 'finished' as const, cause: null, completeness: 'incomplete' as const };
    const complete = { state: 'finished' as const, cause: null, completeness: 'complete' as const };
    expect(readerStateText(es, incomplete, true)).toEqual({ text: 'Finalizada · contenido incompleto', status: 'off' });
    expect(readerStateText(en, incomplete, true)).toEqual({ text: 'Finished · incomplete content', status: 'off' });
    expect(readerStateText(en, complete, true)).toEqual({ text: 'Finished', status: 'off' });
    expect(readerStateText(es, { ...live, state: 'prepared' }, true)).toEqual({ text: 'Preparada', status: 'off' });
    expect(readerStateText(en, live, true)).toEqual({ text: 'Live', status: 'live' });
  });
});
