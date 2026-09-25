import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { SourceLanguage } from '@nerditulos/shared';

export const SONIOX_ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket';

export interface SonioxToken {
  text: string;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  is_final?: boolean;
  language?: string;
  source_language?: string;
  translation_status?: 'original' | 'translation' | 'none';
  speaker?: string;
}

export interface SonioxResponse {
  tokens?: SonioxToken[];
  final_audio_proc_ms?: number;
  total_audio_proc_ms?: number;
  finished?: boolean;
  error_code?: number;
  error_message?: string;
}

export interface ProviderConfigInput {
  model: string;
  sourceLanguage: SourceLanguage;
  /**
   * Language of the session's translation stream, or null for a session without one. When set, the
   * provider translates every detected language into it (`one_way`).
   */
  translationTarget: SourceLanguage | null;
  clientReferenceId: string;
}

/** Provider request body without the key; the key is injected only inside `send()`. */
export function providerConfig(input: ProviderConfigInput): Record<string, unknown> {
  return {
    model: input.model,
    audio_format: 'pcm_s16le',
    sample_rate: 16000,
    num_channels: 1,
    language_hints: [input.sourceLanguage],
    enable_language_identification: true,
    enable_endpoint_detection: true,
    client_reference_id: input.clientReferenceId,
    ...(input.translationTarget ? { translation: { type: 'one_way', target_language: input.translationTarget } } : {}),
  };
}

export interface ProviderConnection extends EventEmitter {
  /** Resolves once the socket is open and the configuration has been sent. */
  open(): Promise<void>;
  sendAudio(pcm: Buffer): void;
  /** Empty frame: end of audio. The provider finalizes pending text, then reports `finished`. */
  endAudio(): void;
  keepalive(): void;
  terminate(): void;
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
  on(event: 'response', listener: (response: SonioxResponse) => void): this;
  on(event: 'close', listener: (code: number, reason: string) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export type ProviderFactory = (input: ProviderConfigInput) => ProviderConnection;

export class SonioxConnection extends EventEmitter implements ProviderConnection {
  private ws: WebSocket | null = null;
  private closed = false;

  constructor(
    private readonly apiKey: string,
    private readonly input: ProviderConfigInput,
    private readonly endpoint: string = SONIOX_ENDPOINT,
  ) {
    super();
  }

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.endpoint, { handshakeTimeout: 10000, perMessageDeflate: false });
      this.ws = ws;
      let settled = false;
      ws.on('open', () => {
        // The API key exists only here, never in the logged configuration.
        ws.send(JSON.stringify({ ...providerConfig(this.input), api_key: this.apiKey }));
        settled = true;
        resolve();
      });
      ws.on('message', (data) => {
        let parsed: SonioxResponse;
        try {
          parsed = JSON.parse(data.toString()) as SonioxResponse;
        } catch {
          this.emit('error', new Error('provider sent invalid JSON'));
          return;
        }
        this.emit('response', parsed);
      });
      ws.on('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.emit('error', error);
      });
      ws.on('close', (code, reason) => {
        this.closed = true;
        if (!settled) {
          settled = true;
          reject(new Error(`provider closed before open (${code})`));
        }
        this.emit('close', code, reason.toString());
      });
    });
  }

  sendAudio(pcm: Buffer): void {
    if (!this.isOpen) return;
    this.ws?.send(pcm, { binary: true });
  }

  endAudio(): void {
    if (!this.isOpen) return;
    this.ws?.send('');
  }

  keepalive(): void {
    if (!this.isOpen) return;
    this.ws?.send(JSON.stringify({ type: 'keepalive' }));
  }

  terminate(): void {
    if (this.closed) return;
    this.ws?.terminate();
  }
}

export function sonioxFactory(apiKey: string): ProviderFactory {
  return (input) => new SonioxConnection(apiKey, input);
}
