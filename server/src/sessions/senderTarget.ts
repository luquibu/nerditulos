// What a sender socket attaches to: a session runtime or a source test. The socket drives either
// through this interface and never learns which one it has.
import type { AudioFrame, DetachReason, EndReason, SenderServerMessage } from '@nerditulos/shared';

export interface SenderLink {
  readonly id: number;
  send(message: SenderServerMessage): void;
  close(code: number, reason: string): void;
}

export type SenderLostReason = 'device_lost' | 'socket_closed' | 'pong_timeout' | 'auth_expired';

export interface SenderTarget {
  isSender(link: SenderLink): boolean;
  onFrame(link: SenderLink, frame: AudioFrame, receivedAt: number): void;
  onPause(link: SenderLink): void;
  onResume(link: SenderLink): void;
  onEnd(link: SenderLink, reason: EndReason): void;
  onDetach(link: SenderLink, reason: DetachReason): void;
  /** The link went away without an `end` or `detach` control (socket closed, pong missed, token expired). */
  senderLost(link: SenderLink, reason: SenderLostReason): void;
}
