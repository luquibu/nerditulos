// Interface strings of the public chunk (rooms list, reader, not found, and what the app shell renders
// before the console loads). The console's own table extends this one in `admin/consoleStrings.ts`.
// Pure: no DOM and no React, so the tables and helpers are unit-testable in node.
import type { InterruptionCause, SessionState, SessionSummary } from '@nerditulos/shared';

export type Language = 'es' | 'en';

export const LANGUAGES: readonly Language[] = ['es', 'en'];

export function isLanguage(value: unknown): value is Language {
  return value === 'es' || value === 'en';
}

/** Each language named in itself, for the language switch and the session's language chip. */
export const LANGUAGE_NATIVE_NAMES: Record<Language, string> = { es: 'Español', en: 'English' };

export type StateStatus = 'live' | 'ok' | 'warning' | 'error' | 'off';

export interface StateLabel {
  text: string;
  status: StateStatus;
}

export interface Strings {
  appTitle: string;
  roomsTitle: string;
  roomsTitleFor: (event: string) => string;
  roomsIntro: string;
  roomsLoading: string;
  roomsLoadError: string;
  roomsEmpty: string;
  footer: string;
  skipToContent: string;
  /** Accessible name of the logo link on the reader page. */
  roomsLink: string;
  backToRooms: string;
  notFoundTitle: string;
  /** Heading while the room name is unknown. */
  roomFallback: string;
  roomNotFound: string;
  roomLoadError: string;
  /** Main-area text before the stream reports the room's session. */
  loadingRoom: string;
  stateConnecting: string;
  noSession: string;
  statePrepared: string;
  stateStarting: string;
  stateLive: string;
  stateFinishing: string;
  stateFinished: string;
  stateFinishedIncomplete: string;
  stateInterrupted: string;
  stateInterruptedSenderLost: string;
  stateInterruptedProvider: string;
  stateInterruptedStorage: string;
  reconnecting: string;
  storageFailing: string;
  liveNoText: string;
  finishedNoText: string;
  jumpToCurrent: string;
  languageLabel: string;
  announceToggle: string;
  /** Language names as nouns of this interface language, for the fallback notice. */
  languageName: Record<Language, string>;
  /** Shown when the session lacks the reader's language and another stream is displayed instead. */
  languageFallbackNotice: (wanted: string, shown: string) => string;
  /** Tooltip of a lost stretch; `seconds` is already formatted, or null when the extent is unknown. */
  gapTitle: (seconds: string | null) => string;
  /** Suspense fallback while the console chunk loads. */
  loadingAdmin: string;
  /** Rendered by the entry point when the runtime configuration cannot be fetched. */
  configLoadFailed: string;
  /** Header chip on every page while the server runs in demo mode. */
  demoChip: string;
  /** Link to the console, shown on public pages in demo mode. */
  adminLink: string;
}

export const STRINGS: Record<Language, Strings> = {
  es: {
    appTitle: 'Subtítulos',
    roomsTitle: 'Salas',
    roomsTitleFor: (event) => `${event}: salas`,
    roomsIntro: 'Elegí una sala para seguir los subtítulos en tu navegador.',
    roomsLoading: 'Cargando salas…',
    roomsLoadError: 'No se pudieron cargar las salas.',
    roomsEmpty: 'No hay salas configuradas.',
    footer: 'Nerditulos · Software bajo licencia MIT',
    skipToContent: 'Ir al contenido',
    roomsLink: 'Salas',
    backToRooms: 'Volver a las salas',
    notFoundTitle: 'Página no encontrada',
    roomFallback: 'Sala',
    roomNotFound: 'Esta sala no existe.',
    roomLoadError: 'No se pudo cargar la sala.',
    loadingRoom: 'Conectando…',
    stateConnecting: 'Conectando',
    noSession: 'Sin sesión',
    statePrepared: 'Preparada',
    stateStarting: 'Iniciando',
    stateLive: 'En vivo',
    stateFinishing: 'Finalizando',
    stateFinished: 'Finalizada',
    stateFinishedIncomplete: 'Finalizada · contenido incompleto',
    stateInterrupted: 'Interrumpida',
    stateInterruptedSenderLost: 'Interrumpida: fuente perdida',
    stateInterruptedProvider: 'Interrumpida: proveedor no disponible',
    stateInterruptedStorage: 'Interrumpida: almacenamiento no disponible',
    reconnecting: 'Reconectando',
    storageFailing: 'Almacenamiento con fallas',
    liveNoText: 'En vivo · sin texto todavía',
    finishedNoText: 'Finalizada sin texto',
    jumpToCurrent: 'Ir al texto actual',
    languageLabel: 'Idioma',
    announceToggle: 'Anunciar con lector de pantalla',
    languageName: { es: 'español', en: 'inglés' },
    languageFallbackNotice: (wanted, shown) => `Esta sesión no ofrece ${wanted}; se muestra ${shown}.`,
    gapTitle: (seconds) => (seconds === null ? 'Tramo perdido de extensión desconocida' : `Tramo perdido: ${seconds} s`),
    loadingAdmin: 'Cargando administración…',
    configLoadFailed: 'No se pudo cargar la configuración. Recargá la página.',
    demoChip: 'Modo demo',
    adminLink: 'Administración',
  },
  en: {
    appTitle: 'Captions',
    roomsTitle: 'Rooms',
    roomsTitleFor: (event) => `${event}: rooms`,
    roomsIntro: 'Choose a room to follow the captions in your browser.',
    roomsLoading: 'Loading rooms…',
    roomsLoadError: 'The rooms could not be loaded.',
    roomsEmpty: 'No rooms are configured.',
    footer: 'Nerditulos · Software under the MIT license',
    skipToContent: 'Skip to content',
    roomsLink: 'Rooms',
    backToRooms: 'Back to the rooms',
    notFoundTitle: 'Page not found',
    roomFallback: 'Room',
    roomNotFound: 'This room does not exist.',
    roomLoadError: 'The room could not be loaded.',
    loadingRoom: 'Connecting…',
    stateConnecting: 'Connecting',
    noSession: 'No session',
    statePrepared: 'Prepared',
    stateStarting: 'Starting',
    stateLive: 'Live',
    stateFinishing: 'Finishing',
    stateFinished: 'Finished',
    stateFinishedIncomplete: 'Finished · incomplete content',
    stateInterrupted: 'Interrupted',
    stateInterruptedSenderLost: 'Interrupted: source lost',
    stateInterruptedProvider: 'Interrupted: provider unavailable',
    stateInterruptedStorage: 'Interrupted: storage unavailable',
    reconnecting: 'Reconnecting',
    storageFailing: 'Storage failing',
    liveNoText: 'Live · no text yet',
    finishedNoText: 'Finished without text',
    jumpToCurrent: 'Go to the current text',
    languageLabel: 'Language',
    announceToggle: 'Announce with screen reader',
    languageName: { es: 'Spanish', en: 'English' },
    languageFallbackNotice: (wanted, shown) => `This session does not offer ${wanted}; showing ${shown}.`,
    gapTitle: (seconds) => (seconds === null ? 'Lost stretch of unknown length' : `Lost stretch: ${seconds} s`),
    loadingAdmin: 'Loading administration…',
    configLoadFailed: 'The configuration could not be loaded. Reload the page.',
    demoChip: 'Demo mode',
    adminLink: 'Administration',
  },
};

export function strings(lang: Language): Strings {
  return STRINGS[lang];
}

/** Chip label for a session state, in the given strings; no state means the room has no visible session. */
export function stateLabel(d: Strings, state: SessionState | null | undefined): StateLabel {
  switch (state) {
    case 'live':
      return { text: d.stateLive, status: 'live' };
    case 'starting':
      return { text: d.stateStarting, status: 'warning' };
    case 'finishing':
      return { text: d.stateFinishing, status: 'warning' };
    case 'interrupted':
      return { text: d.stateInterrupted, status: 'error' };
    case 'finished':
      return { text: d.stateFinished, status: 'off' };
    case 'prepared':
      return { text: d.statePrepared, status: 'off' };
    default:
      return { text: d.noSession, status: 'off' };
  }
}

function interruptionText(d: Strings, cause: InterruptionCause | null): string {
  switch (cause) {
    case 'sender_lost':
      return d.stateInterruptedSenderLost;
    case 'provider_error':
    case 'provider_unavailable':
      return d.stateInterruptedProvider;
    case 'storage_unavailable':
      return d.stateInterruptedStorage;
    default:
      return d.stateInterrupted;
  }
}

/** The reader page's state text: connection first, then the visible session with its cause or completeness. */
export function readerStateText(d: Strings, session: Pick<SessionSummary, 'state' | 'cause' | 'completeness'> | null, sessionKnown: boolean): StateLabel {
  if (!sessionKnown) return { text: d.stateConnecting, status: 'off' };
  if (!session) return { text: d.noSession, status: 'off' };
  switch (session.state) {
    case 'finished':
      return { text: session.completeness === 'incomplete' ? d.stateFinishedIncomplete : d.stateFinished, status: 'off' };
    case 'interrupted':
      return { text: interruptionText(d, session.cause), status: 'error' };
    default:
      return stateLabel(d, session.state);
  }
}
