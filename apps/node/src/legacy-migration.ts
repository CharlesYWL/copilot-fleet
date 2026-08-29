/**
 * What this Node does when a Host offers to migrate it.
 *
 * Nothing, and the reason is not caution. A machine still on the shared secret
 * has already sent that secret to whatever terminated its connection — that is
 * what "legacy" means on a relayed tunnel — so an upgrade request proved with
 * an HMAC keyed on the digest of that same secret proves only that the asker
 * has seen it. The relay has. Answering would have this Node generate a key
 * pair and permanently pin whichever Host identity arrived, on the strength of
 * a credential it could not keep to itself.
 *
 * There is no ordering of that exchange that fixes it, because the flaw is the
 * credential rather than the protocol. So the exchange is gone and what remains
 * is an instruction: run a fresh Connect command. That carries a one-time grant
 * and the Host's fingerprint out of band, from the operator's screen rather
 * than from the wire, and enrolling under this machine's existing name reclaims
 * its row — the same id, the same placements, the same session history.
 */
export type LegacyKeyUpgradeRequest = {
  hostId: string;
  hostFingerprint: string;
};

/** Enough of the fingerprint to compare against a Connect card by eye. */
const FINGERPRINT_PREVIEW = 16;

/**
 * The line an operator sees when something asks this Node to upgrade itself.
 *
 * It names the fingerprint that was claimed, because that is the field a relay
 * would have substituted and the one the operator can check — and it says what
 * to do instead, since a refusal with no next step reads as a broken Host.
 */
export function legacyKeyUpgradeRefusal(request: LegacyKeyUpgradeRequest): string {
  const claimed = request.hostFingerprint.slice(0, FINGERPRINT_PREVIEW);
  return (
    `Refused an automatic key upgrade from Host ${request.hostId} claiming fingerprint ${claimed}…. ` +
    "This connection cannot prove which Host is on the other end, so nothing was generated. " +
    "Run a fresh Connect command from Settings → Nodes to migrate this machine; it keeps this node's name, id and history."
  );
}

/** The line for an acknowledgement of a key this Node never offered. */
export function unsolicitedKeyAcknowledgement(): string {
  return "Ignored a Node key acknowledgement: this Node offers no key over a legacy connection, so there is nothing to adopt.";
}
