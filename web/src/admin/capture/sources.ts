// Capture sources: microphone (MediaStream) or WAV file (media element, real time by construction).

export type SourceKind = 'microphone' | 'file';

export interface DeviceOption {
  deviceId: string;
  label: string;
}

export type MediaErrorCode = 'permission_denied' | 'no_device' | 'device_busy' | 'constraints' | 'aborted' | 'insecure_context' | 'unsupported' | 'unknown';

export function mapMediaError(error: unknown): { code: MediaErrorCode; message: string } {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return { code: 'permission_denied', message: 'Permiso de micrófono denegado. Habilitalo en el navegador y volvé a intentar.' };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { code: 'no_device', message: 'No se encontró ningún micrófono.' };
    case 'NotReadableError':
    case 'TrackStartError':
      return { code: 'device_busy', message: 'El micrófono está en uso por otra aplicación o no responde.' };
    case 'OverconstrainedError':
      return { code: 'constraints', message: 'El dispositivo elegido ya no está disponible. Elegí otro.' };
    case 'AbortError':
      return { code: 'aborted', message: 'La captura se interrumpió antes de empezar.' };
    case 'SecurityError':
      return { code: 'insecure_context', message: 'El navegador bloqueó el micrófono en este contexto (se requiere HTTPS).' };
    case 'TypeError':
      return { code: 'unsupported', message: 'Este navegador no admite la captura de audio necesaria.' };
    default:
      return { code: 'unknown', message: 'No se pudo acceder al micrófono.' };
  }
}

export interface MicrophoneSource {
  kind: 'microphone';
  stream: MediaStream;
  track: MediaStreamTrack;
  settings: MediaTrackSettings;
  node: MediaStreamAudioSourceNode;
}

export interface FileSource {
  kind: 'file';
  file: File;
  element: HTMLAudioElement;
  objectUrl: string;
  node: MediaElementAudioSourceNode;
}

export type CaptureSource = MicrophoneSource | FileSource;

export async function requestMicrophone(context: AudioContext, deviceId?: string): Promise<MicrophoneSource> {
  if (!navigator.mediaDevices?.getUserMedia) throw new TypeError('getUserMedia unavailable');
  const constraints: MediaStreamConstraints = {
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    video: false,
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new DOMException('no audio track', 'NotFoundError');
  }
  const node = context.createMediaStreamSource(stream);
  return { kind: 'microphone', stream, track, settings: track.getSettings(), node };
}

export async function listMicrophones(): Promise<DeviceOption[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Micrófono ${i + 1}` }));
}

export function openFile(context: AudioContext, file: File): FileSource {
  const objectUrl = URL.createObjectURL(file);
  const element = new Audio();
  element.preload = 'auto';
  element.src = objectUrl;
  element.crossOrigin = null;
  const node = context.createMediaElementSource(element);
  return { kind: 'file', file, element, objectUrl, node };
}

export function releaseSource(source: CaptureSource) {
  try {
    source.node.disconnect();
  } catch {
    // already disconnected
  }
  if (source.kind === 'microphone') {
    source.stream.getTracks().forEach((t) => t.stop());
  } else {
    source.element.pause();
    source.element.removeAttribute('src');
    source.element.load();
    URL.revokeObjectURL(source.objectUrl);
  }
}

/** RMS of an Int16 chunk in [0, 1]. */
export function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = (pcm[i] as number) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
}
