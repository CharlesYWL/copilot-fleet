import { randomBytes, randomUUID } from "node:crypto";
import {
  MUTUAL_AUTH_PROTOCOL,
  type HostChallenge,
  type NodeClientHello,
} from "@fleet/protocol";
import {
  AuthenticatedChannel,
  CHANNEL_KEY_LABEL,
  HOST_CHALLENGE_LABEL,
  NODE_PROOF_LABEL,
  createEphemeralKeyPair,
  deriveChannelKeys,
  handshakeTranscript,
  verifyIdentitySignature,
  type HandshakeTranscriptInput,
} from "@fleet/protocol/node-auth";
import type { HostIdentity } from "@fleet/protocol";
import type { NodeLink } from "../fleet-service.js";

export type HandshakeRefusal = { ok: false; reason: string };

/**
 * The Host's side of the connection handshake.
 *
 * Split out of the socket handler because the interesting part is a state
 * machine over three frames, and a state machine buried in an event listener is
 * one nobody can test the refusals of. It holds no socket: the caller sends
 * what it returns and closes on what it refuses.
 */
export class HostChannelHandshake {
  private readonly identity: HostIdentity;
  private readonly sign: (message: Buffer) => string;
  private ephemeral = createEphemeralKeyPair();
  private transcript: HandshakeTranscriptInput | undefined;

  constructor(input: { identity: HostIdentity; sign: (message: Buffer) => string }) {
    this.identity = input.identity;
    this.sign = input.sign;
  }

  /**
   * Answers a `client_hello`, or refuses it.
   *
   * The Node's stored public key is required up front: a Host that challenged
   * first and looked the Node up afterwards would be an oracle for which node
   * ids exist, and would spend a signature on every stranger who asked.
   */
  begin(
    hello: NodeClientHello,
    nodePublicKey: string,
  ): { ok: true; challenge: HostChallenge } | HandshakeRefusal {
    if (hello.protocol !== MUTUAL_AUTH_PROTOCOL) {
      return { ok: false, reason: "unsupported protocol" };
    }
    if (hello.hostId !== this.identity.hostId) {
      // The Node believes it is dialing a different Host. Answering would be
      // this Host claiming an identity it does not have.
      return { ok: false, reason: "host identity mismatch" };
    }
    if (!nodePublicKey) return { ok: false, reason: "node has no enrolled key" };

    const connectionId = randomUUID();
    const hostNonce = randomBytes(32).toString("base64");
    const transcript: HandshakeTranscriptInput = {
      protocol: MUTUAL_AUTH_PROTOCOL,
      hostId: this.identity.hostId,
      nodeId: hello.nodeId,
      connectionId,
      hostNonce,
      nodeNonce: hello.nodeNonce,
      hostPublicKey: this.identity.publicKey,
      nodePublicKey,
      hostEphemeralPublicKey: this.ephemeral.publicKey,
      nodeEphemeralPublicKey: hello.nodeEphemeralPublicKey,
      dialedHostUrl: hello.dialedHostUrl,
    };
    /*
     * Signing is a call into the platform's crypto, and this one runs before
     * anything has authenticated — so a Host whose key file was replaced under
     * it, or a platform that refuses the algorithm, would raise here rather
     * than return. Inside a socket listener that is not a refused connection,
     * it is an unhandled exception, so the failure is turned back into the
     * refusal every other branch already speaks.
     */
    let signature: string;
    try {
      signature = this.sign(handshakeTranscript(HOST_CHALLENGE_LABEL, transcript));
    } catch (error) {
      return { ok: false, reason: `could not sign the challenge: ${detail(error)}` };
    }
    this.transcript = transcript;
    return {
      ok: true,
      challenge: {
        type: "host_challenge",
        protocol: MUTUAL_AUTH_PROTOCOL,
        hostId: this.identity.hostId,
        hostPublicKey: this.identity.publicKey,
        hostFingerprint: this.identity.fingerprint,
        hostNonce,
        connectionId,
        hostEphemeralPublicKey: this.ephemeral.publicKey,
        signature,
      },
    };
  }

  /**
   * Checks the Node's proof and derives the channel.
   *
   * The signature is over the same transcript the key derivation salts with, so
   * a relay that swapped either ephemeral key produces a proof that does not
   * verify — and a relay that did not produces keys it cannot compute.
   */
  finish(
    signature: string,
  ): { ok: true; channel: AuthenticatedChannel } | HandshakeRefusal {
    const transcript = this.transcript;
    if (!transcript) return { ok: false, reason: "no challenge was issued" };
    /*
     * Both halves are wrapped, and the reason is the same for each: this runs
     * on a frame that arrived from whoever opened the socket. A verifier can
     * throw on a malformed signature, and the key exchange throws on an
     * ephemeral key that is schema-valid base64 but not an X25519 point —
     * which is a string any stranger can send. An exception here escapes the
     * WebSocket `message` listener that called it, where nothing is positioned
     * to catch it; a refusal closes one socket and leaves the fleet alone.
     */
    try {
      if (
        !verifyIdentitySignature(
          transcript.nodePublicKey,
          handshakeTranscript(NODE_PROOF_LABEL, transcript),
          signature,
        )
      ) {
        return { ok: false, reason: "node proof did not verify" };
      }
      const keys = deriveChannelKeys({
        privateKey: this.ephemeral.privateKey,
        peerPublicKey: transcript.nodeEphemeralPublicKey,
        transcript: handshakeTranscript(CHANNEL_KEY_LABEL, transcript),
      });
      return {
        ok: true,
        channel: new AuthenticatedChannel({
          keys,
          binding: {
            protocol: MUTUAL_AUTH_PROTOCOL,
            hostId: transcript.hostId,
            nodeId: transcript.nodeId,
            connectionId: transcript.connectionId,
          },
          seals: "host-to-node",
        }),
      };
    } catch (error) {
      return { ok: false, reason: `channel could not be derived: ${detail(error)}` };
    }
  }
}

/** The message, without letting a thrown non-Error become "[object Object]". */
function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type RawSocket = {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

/**
 * A Node connection that seals everything written to it.
 *
 * The service dispatches commands, announces URLs and pushes renames through
 * one `send`, and every one of those had to become confidential and sequenced.
 * Wrapping the socket rather than teaching each caller to encrypt means a path
 * added later is protected by going through the same door, and a caller that
 * forgets is not a plaintext command on the wire.
 */
export class SealedNodeLink implements NodeLink {
  constructor(
    private readonly socket: RawSocket,
    private readonly channel: AuthenticatedChannel,
  ) {}

  /** Whether this link is the one riding on that socket, for the close handler. */
  wraps(socket: unknown): boolean {
    return this.socket === socket;
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  get OPEN(): number {
    return this.socket.OPEN;
  }

  send(data: string): void {
    this.socket.send(JSON.stringify(this.channel.seal(data)));
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}
