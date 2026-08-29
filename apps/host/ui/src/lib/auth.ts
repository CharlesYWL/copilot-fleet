/**
 * The browser's half of the Host's operator session.
 *
 * A cookie the page cannot read is what actually authenticates each call, so
 * there is nothing here to store — only a way for any request that comes back
 * 401 to tell the shell around it that the session is over, wherever in the
 * component tree that request was made.
 */
import {
  AuthStatusSchema,
  parseAuthError,
  type AuthErrorCode,
  type AuthStatus,
} from "@fleet/protocol";

const SIGNED_OUT_EVENT = "fleet:signed-out";

export function announceSignedOut(): void {
  window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
}

export function onSignedOut(listener: () => void): () => void {
  window.addEventListener(SIGNED_OUT_EVENT, listener);
  return () => window.removeEventListener(SIGNED_OUT_EVENT, listener);
}

export async function signOut(): Promise<void> {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    headers: { "x-csrf-token": await csrfToken() },
  });
  if (!response.ok) throw new Error(`Could not sign out (${response.status})`);
  csrfCache = undefined;
  announceSignedOut();
}

/**
 * The proof that this request came from this page.
 *
 * The Host derives it from the session rather than storing one, so it is stable
 * for the life of a session and worth caching; a sign-out drops the cache
 * because the next session derives a different one.
 */
let csrfCache: Promise<string> | undefined;

export async function csrfToken(): Promise<string> {
  csrfCache ??= fetch("/api/auth/csrf")
    .then(async (response) => {
      if (!response.ok) throw new Error(`Could not load CSRF token (${response.status})`);
      const body = (await response.json()) as { csrfToken?: string };
      if (!body.csrfToken) throw new Error("Host returned no CSRF token");
      return body.csrfToken;
    })
    .catch((error: unknown) => {
      csrfCache = undefined;
      throw error;
    });
  return csrfCache;
}

export function forgetCsrfToken(): void {
  csrfCache = undefined;
}

/**
 * Leaving this page, as one indirection.
 *
 * A Microsoft sign-in is a full-page navigation, not a fetch, and the two
 * places that perform one — the gate and the reauth prompt — must do it the
 * same way. It is a named object rather than a bare call so tests can watch it
 * without replacing `window.location`, which jsdom will not allow.
 */
export const browserNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/**
 * The same Host under the name Entra will redirect back to, when it differs.
 *
 * The reply URL registered for the app is `http://localhost/...`, and Entra
 * matches it by name while ignoring the port. A page opened at `127.0.0.1` is
 * the same machine under a name the redirect will never use — and the Lax
 * transaction cookie set for it would not be sent to the callback — so the
 * sign-in has to start from `localhost` or it fails at the last step, after the
 * person has already authenticated.
 */
export function canonicalLoginUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.hostname !== "127.0.0.1") return undefined;
  url.hostname = "localhost";
  return url.toString();
}

export type BrowserAuthStatus = AuthStatus & {
  /** The Host did not answer at all, which is not the same as refusing us. */
  unreachable?: boolean;
};

/**
 * What the Host says about itself, or the safest reading when it says nothing.
 *
 * An unreachable Host is reported as signed out rather than as an error state
 * the gate has to invent copy for: the console is an administrative surface, so
 * "we could not confirm who you are" and "you are not signed in" have to lead
 * to the same screen.
 */
export async function fetchAuthStatus(): Promise<BrowserAuthStatus> {
  try {
    const response = await fetch("/api/auth/status");
    if (!response.ok) throw new Error(`status ${response.status}`);
    return AuthStatusSchema.parse(await response.json());
  } catch {
    return {
      state: "microsoft-only",
      authenticated: false,
      passwordEnabled: false,
      entraConfigured: false,
      deviceFlowEnabled: false,
      claimCodeRequired: false,
      canSignIn: false,
      codeLogin: { available: false, localForwardRequired: false },
      unreachable: true,
    };
  }
}

export type AuthErrorNotice = { code: AuthErrorCode; message: string | undefined };

/** The invitation this page was opened with, if it was opened by one. */
export function readInvitation(): string | undefined {
  return new URLSearchParams(window.location.search).get("invitation") ?? undefined;
}

/**
 * Reads why the last callback sent us back here, and takes it out of the URL.
 *
 * Scrubbing matters as much as reading: a refusal left in the address bar is
 * re-raised by every refresh and shared by every copied link, so the operator
 * would keep meeting a failure they had already dealt with.
 */
export function readAuthError(): AuthErrorNotice | undefined {
  const notice = parseAuthError(window.location.search);
  if (!notice) return undefined;
  const url = new URL(window.location.href);
  url.searchParams.delete("auth_error");
  url.searchParams.delete("auth_error_message");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  return notice;
}

/**
 * Starts an authorization-code sign-in and hands the browser to Microsoft.
 *
 * The Host builds the URL because it owns the state, nonce and PKCE verifier
 * the callback is checked against; the page only carries the browser there.
 */
export async function startCodeLogin(invitation?: string): Promise<void> {
  const response = await fetch("/api/auth/code/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(invitation ? { invitation } : {}),
  });
  const body = (await response.json().catch(() => ({}))) as {
    authorizationUrl?: string;
    canonicalUrl?: string;
    error?: string;
  };
  if (response.ok && body.authorizationUrl) {
    browserNavigation.assign(body.authorizationUrl);
    return;
  }
  // The Host may know a name this sign-in can complete under even when the one
  // we asked from cannot; moving there is the fix, not an error to report.
  if (body.canonicalUrl) {
    browserNavigation.assign(body.canonicalUrl);
    return;
  }
  throw new Error(body.error ?? `Could not start sign-in (${response.status})`);
}
