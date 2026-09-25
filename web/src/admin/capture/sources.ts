// Capture sources: microphone (MediaStream) or WAV file (media element, real time by construction).

export type SourceKind = 'microphone' | 'file';

export interface DeviceOption {
  deviceId: string;
  /** The browser's label; empty until permission is granted, in which case the console names the device by position. */
  label: string;
}

export type MediaErrorCode = 'permission_denied' | 'no_device' | 'device_busy' | 'constraints' | 'aborted' | 'insecure_context' | 'unsupported' | 'unknown';

/** The reason `getUserMedia` failed, by exception name; the console translates it. */
export function mediaErrorCode(error: unknown): MediaErrorCode {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'permission_denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'no_device';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'device_busy';
    case 'OverconstrainedError':
      return 'constraints';
    case 'AbortError':
      return 'aborted';
    case 'SecurityError':
      return 'insecure_context';
    case 'TypeError':
      return 'unsupported';
    default:
      return 'unknown';
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
  return devices.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label }));
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
