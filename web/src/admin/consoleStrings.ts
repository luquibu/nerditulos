// Interface strings of the console, the sign-in gate and the capture messages, in both languages.
// Extends the public table so the console reuses its state chips, footer and skip link. Lives in the
// console's lazy chunk: the reader never loads these texts. Pure: no DOM and no React.
import type { SourceLanguage } from '@nerditulos/shared';
import { STRINGS, type Language, type Strings } from '../i18n.js';
import type { PreviewEndReason } from './capture/preview.js';
import type { MediaErrorCode } from './capture/sources.js';
import type { CheckState, StartWarning } from './capture/viewModel.js';

export interface ConnectionStats {
  epoch: number;
  framesSent: number;
  framesDropped: number;
  discontinuities: number;
  /** Sample position of the last acknowledged frame, or null before the first acknowledgement. */
  lastAckPosition: number | null;
}

export interface ConsoleStrings extends Strings {
  // Shell and sign-in gate
  consoleTitle: string;
  signInIntro: string;
  adminKeyMissing: string;
  /** Accessible name of the account menu button. */
  accountMenu: string;
  signOut: string;
  checkingAuth: string;
  gateNotConfigured: string;
  gateForbidden: string;
  gateUnauthenticated: string;
  gateCheckFailed: string;
  /** Accessible name of the room tab list. */
  roomsTabs: string;
  noActiveSession: string;

  // Source column
  sourceHeading: string;
  useMicrophone: string;
  wavFile: string;
  device: string;
  /** Name of a microphone whose label the browser withholds. */
  microphoneFallback: string;
  microphoneN: (n: number) => string;
  sourceLine: (label: string) => string;
  processing: string;
  /** Accessible name of the check list. */
  checks: string;
  checkPermission: string;
  checkDevice: string;
  checkSignal: string;
  checkReceipt: string;
  checkLabel: Record<CheckState, string>;
  level: string;
  clipping: string;
  noSignalBanner: string;
  testMicrophone: string;
  testFile: string;
  stopTest: string;
  connectingRecognition: string;
  /** The "listen through the speakers" switch. */
  monitor: string;
  headphonesWarning: string;
  speakNow: string;
  testToSee: string;
  pause: string;
  resume: string;
  position: string;
  reconnect: string;
  finish: string;
  connectionStats: (stats: ConnectionStats) => string;

  // Chips only the console shows; the shared states come from the public table
  chipWaitingPrevious: string;
  chipLivePaused: string;
  chipInterruptedProviderError: string;
  chipInterruptedRestart: string;
  /** Appended after " · " to an interruption chip while this console reconnects. */
  chipReconnectingSuffix: string;
  startWarning: Record<StartWarning, string>;

  // Track processing
  noBrowserData: string;
  echoOn: string;
  echoOff: string;
  noiseOn: string;
  noiseOff: string;
  gainAuto: string;
  gainManual: string;
  mono: string;
  stereo: string;
  channels: (n: number) => string;

  // Source test endings; `source_changed` shows nothing
  testEnd: Record<Exclude<PreviewEndReason, 'source_changed'>, string>;

  // Capture notices (see capture/notices.ts)
  mediaError: Record<MediaErrorCode, string>;
  audioContextNotRunning: string;
  audioContextSampleRate: string;
  fileDecodeFailed: string;
  fileOpenFailed: string;
  senderActive: string;
  connectFailed: (reason: string) => string;
  deviceLost: string;
  microphoneGone: string;
  microphoneMuted: string;
  rejected: (reason: string) => string;
  sessionUnavailable: (reason: string) => string;
  closedNoRetry: (code: number, reason: string) => string;
  sendInterrupted: (code: number, reason: string) => string;

  // Sessions column
  sessionsHeading: string;
  talkTitle: string;
  talkTitlePlaceholder: string;
  sourceLanguage: string;
  sourceOption: Record<SourceLanguage, string>;
  prepareSession: string;
  sessionsOf: (room: string) => string;
  finishedSessionsOf: (room: string) => string;
  finishedSessions: (n: number) => string;
  noPrepared: string;
  visible: string;
  start: string;
  finishDialogTitle: string;
  finishDialogBody: (seconds: number) => string;
  cancel: string;
  finishSession: string;
  /** Action failures carry the server's error code when the request got an answer. */
  prepareFailed: (code: string | null) => string;
  startFailed: (code: string | null) => string;
  finishFailed: (code: string | null) => string;
  roomBusy: (blockingTitle: string) => string;
  /** Stands in for the blocking session's title when the server did not send it. */
  otherSession: string;
}

export type ConsoleOnlyStrings = Omit<ConsoleStrings, keyof Strings>;

export const CONSOLE_ONLY: Record<Language, ConsoleOnlyStrings> = {
  es: {
    consoleTitle: 'Consola',
    signInIntro: 'Iniciá sesión con la cuenta administradora para preparar y supervisar sesiones.',
    adminKeyMissing: 'Administración no configurada: falta la clave publicable de Clerk en el servidor.',
    accountMenu: 'Cuenta',
    signOut: 'Cerrar sesión',
    checkingAuth: 'Verificando autorización…',
    gateNotConfigured: 'Administración no configurada: el servidor no tiene un usuario administrador asignado.',
    gateForbidden: 'Esta cuenta no tiene permisos de administración.',
    gateUnauthenticated: 'La sesión de identidad expiró. Volvé a iniciar sesión.',
    gateCheckFailed: 'No se pudo verificar la autorización. Reintentá en unos segundos.',
    roomsTabs: 'Salas',
    noActiveSession: 'Sin sesión activa',

    sourceHeading: 'Fuente de audio',
    useMicrophone: 'Usar micrófono',
    wavFile: 'Archivo WAV',
    device: 'Dispositivo',
    microphoneFallback: 'Micrófono',
    microphoneN: (n) => `Micrófono ${n}`,
    sourceLine: (label) => `Fuente: ${label}`,
    processing: 'Procesamiento',
    checks: 'Comprobaciones',
    checkPermission: 'Permiso',
    checkDevice: 'Dispositivo',
    checkSignal: 'Señal',
    checkReceipt: 'Recepción en el servidor',
    checkLabel: { pending: 'pendiente', ok: 'comprobado', warning: 'atención', error: 'error' },
    level: 'Nivel',
    clipping: 'Saturación',
    noSignalBanner: 'Sin señal: no se detecta audio desde hace más de 3 segundos.',
    testMicrophone: 'Probar micrófono',
    testFile: 'Probar archivo',
    stopTest: 'Detener prueba',
    connectingRecognition: 'Conectando con el reconocimiento…',
    monitor: 'Escuchar',
    headphonesWarning: 'Usá auriculares: con parlantes, el micrófono capta su propia salida.',
    speakNow: 'Hablá ahora para ver el texto reconocido.',
    testToSee: 'Probá la fuente para ver el texto reconocido.',
    pause: 'Pausar',
    resume: 'Reanudar',
    position: 'Posición (s)',
    reconnect: 'Reconectar',
    finish: 'Finalizar',
    connectionStats: (s) =>
      `Conexión ${s.epoch} · tramas enviadas ${s.framesSent} · descartadas ${s.framesDropped} · discontinuidades ${s.discontinuities}` +
      (s.lastAckPosition === null ? '' : ` · última recepción pos. ${s.lastAckPosition}`),

    chipWaitingPrevious: 'Esperando cierre de la conexión anterior',
    chipLivePaused: 'En vivo · pausada',
    chipInterruptedProviderError: 'Interrumpida: error del proveedor',
    chipInterruptedRestart: 'Interrumpida: reinicio del servidor',
    chipReconnectingSuffix: 'reconectando',
    startWarning: { no_signal: 'Sin señal reciente en la fuente.', untested: 'Todavía no probaste la fuente.' },

    noBrowserData: 'sin datos del navegador',
    echoOn: 'Eco: cancelado',
    echoOff: 'Eco: sin cancelar',
    noiseOn: 'Ruido: suprimido',
    noiseOff: 'Ruido: sin suprimir',
    gainAuto: 'Ganancia: automática',
    gainManual: 'Ganancia: manual',
    mono: 'mono',
    stereo: 'estéreo',
    channels: (n) => `${n} canales`,

    testEnd: {
      stopped: 'Prueba detenida.',
      file_end: 'Prueba terminada: el archivo llegó al final.',
      session_started: 'Prueba terminada: se inició una sesión en esta sala.',
      time_limit: 'Prueba cerrada por el servidor: se alcanzó el límite de 5 minutos. Podés volver a probar.',
      provider_closed: 'Prueba cerrada: el reconocimiento cerró la conexión. Podés volver a probar.',
      provider_error: 'Prueba cerrada: el reconocimiento devolvió un error. Revisá la configuración del servidor y volvé a probar.',
      device_lost: 'Prueba terminada: se perdió el dispositivo de audio.',
      room_busy: 'No se puede probar: la sala tiene una sesión activa. Finalizala antes de probar.',
      test_active: 'Ya hay una prueba en curso en esta sala (¿otra pestaña?). Detenela antes de probar acá.',
      auth: 'No se pudo probar: la sesión de identidad no es válida. Volvé a iniciar sesión.',
      connection_lost: 'Prueba interrumpida: se perdió la conexión con el servidor.',
      connect_failed: 'No se pudo conectar con el servidor para probar.',
    },

    mediaError: {
      permission_denied: 'Permiso de micrófono denegado. Habilitalo en el navegador y volvé a intentar.',
      no_device: 'No se encontró ningún micrófono.',
      device_busy: 'El micrófono está en uso por otra aplicación o no responde.',
      constraints: 'El dispositivo elegido ya no está disponible. Elegí otro.',
      aborted: 'La captura se interrumpió antes de empezar.',
      insecure_context: 'El navegador bloqueó el micrófono en este contexto (se requiere HTTPS).',
      unsupported: 'Este navegador no admite la captura de audio necesaria.',
      unknown: 'No se pudo acceder al micrófono.',
    },
    audioContextNotRunning: 'El contexto de audio no se pudo activar. Hacé clic de nuevo.',
    audioContextSampleRate: 'El navegador no permite capturar a 16 kHz.',
    fileDecodeFailed: 'No se pudo decodificar el archivo de audio.',
    fileOpenFailed: 'No se pudo abrir el archivo WAV.',
    senderActive: 'Otra fuente ya está enviando audio a esta sesión. No se reemplaza la fuente activa.',
    connectFailed: (reason) => `No se pudo conectar el envío de audio (${reason}).`,
    deviceLost: 'Se perdió el dispositivo de audio.',
    microphoneGone: 'El micrófono anterior ya no está disponible. Elegí una fuente de nuevo.',
    microphoneMuted: 'Sin señal: el micrófono está silenciado por el sistema.',
    rejected: (reason) => `Rechazado: ${reason}`,
    sessionUnavailable: (reason) => `Sesión no disponible (${reason}).`,
    closedNoRetry: (code, reason) => `Conexión cerrada por el servidor (${code} ${reason}). No se reintenta.`,
    sendInterrupted: (code, reason) => `Envío interrumpido (${code} ${reason}).`,

    sessionsHeading: 'Sesiones',
    talkTitle: 'Título de la charla',
    talkTitlePlaceholder: 'Nombre de la charla',
    sourceLanguage: 'Idioma de origen',
    sourceOption: { es: 'Español (con traducción al inglés)', en: 'English (con traducción al español)' },
    prepareSession: 'Preparar sesión',
    sessionsOf: (room) => `Sesiones de ${room}`,
    finishedSessionsOf: (room) => `Sesiones finalizadas de ${room}`,
    finishedSessions: (n) => `Sesiones finalizadas (${n})`,
    noPrepared: 'Sin sesiones preparadas.',
    visible: 'Visible',
    start: 'Iniciar',
    finishDialogTitle: 'Finalizar la sesión',
    finishDialogBody: (seconds) => `Se detiene el envío de audio y se espera hasta ${seconds} segundos a que el proveedor entregue el texto pendiente. El texto ya publicado queda visible.`,
    cancel: 'Cancelar',
    finishSession: 'Finalizar sesión',
    prepareFailed: (code) => (code ? `No se pudo preparar la sesión (${code}).` : 'No se pudo preparar la sesión.'),
    startFailed: (code) => (code ? `No se pudo iniciar (${code}).` : 'No se pudo iniciar la sesión.'),
    finishFailed: (code) => (code ? `No se pudo finalizar (${code}).` : 'No se pudo finalizar la sesión.'),
    roomBusy: (blocking) => `La sala ya tiene una sesión activa (${blocking}). Finalizala antes de iniciar otra.`,
    otherSession: 'otra sesión',
  },
  en: {
    consoleTitle: 'Console',
    signInIntro: 'Sign in with the administrator account to prepare and supervise sessions.',
    adminKeyMissing: 'Administration not configured: the server is missing the Clerk publishable key.',
    accountMenu: 'Account',
    signOut: 'Sign out',
    checkingAuth: 'Checking authorization…',
    gateNotConfigured: 'Administration not configured: the server has no administrator user assigned.',
    gateForbidden: 'This account has no administration permissions.',
    gateUnauthenticated: 'The identity session expired. Sign in again.',
    gateCheckFailed: 'The authorization could not be checked. Try again in a few seconds.',
    roomsTabs: 'Rooms',
    noActiveSession: 'No active session',

    sourceHeading: 'Audio source',
    useMicrophone: 'Use microphone',
    wavFile: 'WAV file',
    device: 'Device',
    microphoneFallback: 'Microphone',
    microphoneN: (n) => `Microphone ${n}`,
    sourceLine: (label) => `Source: ${label}`,
    processing: 'Processing',
    checks: 'Checks',
    checkPermission: 'Permission',
    checkDevice: 'Device',
    checkSignal: 'Signal',
    checkReceipt: 'Receipt at the server',
    checkLabel: { pending: 'pending', ok: 'checked', warning: 'attention', error: 'error' },
    level: 'Level',
    clipping: 'Clipping',
    noSignalBanner: 'No signal: no audio has been detected for more than 3 seconds.',
    testMicrophone: 'Test microphone',
    testFile: 'Test file',
    stopTest: 'Stop test',
    connectingRecognition: 'Connecting to recognition…',
    monitor: 'Listen',
    headphonesWarning: 'Use headphones: with speakers, the microphone picks up its own output.',
    speakNow: 'Speak now to see the recognized text.',
    testToSee: 'Test the source to see the recognized text.',
    pause: 'Pause',
    resume: 'Resume',
    position: 'Position (s)',
    reconnect: 'Reconnect',
    finish: 'Finish',
    connectionStats: (s) =>
      `Connection ${s.epoch} · frames sent ${s.framesSent} · dropped ${s.framesDropped} · discontinuities ${s.discontinuities}` +
      (s.lastAckPosition === null ? '' : ` · last receipt pos. ${s.lastAckPosition}`),

    chipWaitingPrevious: 'Waiting for the previous connection to close',
    chipLivePaused: 'Live · paused',
    chipInterruptedProviderError: 'Interrupted: provider error',
    chipInterruptedRestart: 'Interrupted: server restart',
    chipReconnectingSuffix: 'reconnecting',
    startWarning: { no_signal: 'No recent signal from the source.', untested: 'You have not tested the source yet.' },

    noBrowserData: 'no data from the browser',
    echoOn: 'Echo: cancelled',
    echoOff: 'Echo: not cancelled',
    noiseOn: 'Noise: suppressed',
    noiseOff: 'Noise: not suppressed',
    gainAuto: 'Gain: automatic',
    gainManual: 'Gain: manual',
    mono: 'mono',
    stereo: 'stereo',
    channels: (n) => `${n} channels`,

    testEnd: {
      stopped: 'Test stopped.',
      file_end: 'Test finished: the file reached its end.',
      session_started: 'Test finished: a session started in this room.',
      time_limit: 'Test closed by the server: the 5-minute limit was reached. You can test again.',
      provider_closed: 'Test closed: recognition closed the connection. You can test again.',
      provider_error: 'Test closed: recognition returned an error. Check the server configuration and test again.',
      device_lost: 'Test finished: the audio device was lost.',
      room_busy: 'Cannot test: the room has an active session. Finish it before testing.',
      test_active: 'A test is already running in this room (another tab?). Stop it before testing here.',
      auth: 'Could not test: the identity session is not valid. Sign in again.',
      connection_lost: 'Test interrupted: the connection to the server was lost.',
      connect_failed: 'Could not connect to the server to test.',
    },

    mediaError: {
      permission_denied: 'Microphone permission denied. Allow it in the browser and try again.',
      no_device: 'No microphone was found.',
      device_busy: 'The microphone is in use by another application or is not responding.',
      constraints: 'The chosen device is no longer available. Choose another one.',
      aborted: 'The capture was interrupted before it started.',
      insecure_context: 'The browser blocked the microphone in this context (HTTPS is required).',
      unsupported: 'This browser does not support the required audio capture.',
      unknown: 'The microphone could not be accessed.',
    },
    audioContextNotRunning: 'The audio context could not be activated. Click again.',
    audioContextSampleRate: 'The browser does not allow capturing at 16 kHz.',
    fileDecodeFailed: 'The audio file could not be decoded.',
    fileOpenFailed: 'The WAV file could not be opened.',
    senderActive: 'Another source is already sending audio to this session. The active source is not replaced.',
    connectFailed: (reason) => `The audio upload could not connect (${reason}).`,
    deviceLost: 'The audio device was lost.',
    microphoneGone: 'The previous microphone is no longer available. Choose a source again.',
    microphoneMuted: 'No signal: the microphone is muted by the system.',
    rejected: (reason) => `Rejected: ${reason}`,
    sessionUnavailable: (reason) => `Session unavailable (${reason}).`,
    closedNoRetry: (code, reason) => `Connection closed by the server (${code} ${reason}). Not retrying.`,
    sendInterrupted: (code, reason) => `Upload interrupted (${code} ${reason}).`,

    sessionsHeading: 'Sessions',
    talkTitle: 'Talk title',
    talkTitlePlaceholder: 'Name of the talk',
    sourceLanguage: 'Source language',
    sourceOption: { es: 'Spanish (with English translation)', en: 'English (with Spanish translation)' },
    prepareSession: 'Prepare session',
    sessionsOf: (room) => `Sessions of ${room}`,
    finishedSessionsOf: (room) => `Finished sessions of ${room}`,
    finishedSessions: (n) => `Finished sessions (${n})`,
    noPrepared: 'No prepared sessions.',
    visible: 'Visible',
    start: 'Start',
    finishDialogTitle: 'Finish the session',
    finishDialogBody: (seconds) => `Audio upload stops and the provider gets up to ${seconds} seconds to deliver the pending text. The text already published stays visible.`,
    cancel: 'Cancel',
    finishSession: 'Finish session',
    prepareFailed: (code) => (code ? `The session could not be prepared (${code}).` : 'The session could not be prepared.'),
    startFailed: (code) => (code ? `Could not start (${code}).` : 'The session could not be started.'),
    finishFailed: (code) => (code ? `Could not finish (${code}).` : 'The session could not be finished.'),
    roomBusy: (blocking) => `The room already has an active session (${blocking}). Finish it before starting another.`,
    otherSession: 'another session',
  },
};

const TABLES: Record<Language, ConsoleStrings> = {
  es: { ...STRINGS.es, ...CONSOLE_ONLY.es },
  en: { ...STRINGS.en, ...CONSOLE_ONLY.en },
};

export function consoleStrings(lang: Language): ConsoleStrings {
  return TABLES[lang];
}
