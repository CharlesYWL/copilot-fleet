/**
 * The browser's half of the Host's operator session.
 *
 * A cookie the page cannot read is what actually authenticates each call, so
 * there is nothing here to store — only a way for any request that comes back
 * 401 to tell the shell around it that the session is over, wherever in the
 * component tree that request was made.
 */
const SIGNED_OUT_EVENT = "fleet:signed-out";

export function announceSignedOut(): void {
  window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
}

export function onSignedOut(listener: () => void): () => void {
  window.addEventListener(SIGNED_OUT_EVENT, listener);
  return () => window.removeEventListener(SIGNED_OUT_EVENT, listener);
}

export async function signOut(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    announceSignedOut();
  }
}
