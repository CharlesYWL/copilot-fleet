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
 * A Microsoft sign-in is a navigation, not a fetch — of this page, or of a tab
 * opened for it — and every place that performs one must do it the same way.
 * It is a named object rather than a bare call so tests can watch it without
 * replacing `window.location` or `window.open`, which jsdom will not allow.
 */
export const browserNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
  openTab():
    | { readonly closed: boolean; assign: (url: string) => void; close: () => void }
    | undefined {
    const tab = window.open("about:blank", "_blank");
    if (!tab) return undefined;
    // Open during the click, then detach before any provider page can load.
    tab.opener = null;
    return {
      get closed() {
        return tab.closed;
      },
      assign: (url) => tab.location.replace(url),
      close: () => tab.close(),
    };
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

// Preserve existing callback notices; provider classifications use fixed copy so
// neither provider details nor a crafted URL can supply their explanation.
const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string | undefined> = {
  "claim-required": undefined,
  "already-claimed": undefined,
  "not-authorized": undefined,
  "pending-approval": undefined,
  "wrong-tenant": undefined,
  expired: undefined,
  "device-blocked": undefined,
  "endpoint-refused": undefined,
  "provider-unavailable": undefined,
  cancelled: undefined,
  "unsupported-account":
    "This Microsoft account is not supported by this Host's sign-in registration. Choose a supported account or ask the Host operator to check the registration's supported account types.",
  "organization-policy":
    "Your organization blocked Microsoft sign-in or requires administrator consent. Ask your organization's administrator about consent or Conditional Access; Fleet cannot bypass those policies.",
  "invalid-configuration":
    "This Host's Microsoft sign-in registration is invalid or unavailable. Ask the Host operator to check the client ID, supported account types and localhost redirect URI.",
  "invalid-identity":
    "Microsoft did not return a trusted, complete account identity. Sign-in was refused and no Fleet access was granted. Try again or contact the Host operator.",
};

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
  return { ...notice, message: AUTH_ERROR_MESSAGES[notice.code] ?? notice.message };
}

type CodeLoginStart = { authorizationUrl: string } | { canonicalUrl: string };

/**
 * Asks the Host for an authorization-code sign-in without going anywhere yet.
 *
 * The Host builds the URL because it owns the state, nonce and PKCE verifier
 * the callback is checked against; the page only decides where to carry it.
 */
async function beginCodeLogin(input: {
  invitation?: string | undefined;
  reauth?: true;
}): Promise<CodeLoginStart> {
  const response = await fetch("/api/auth/code/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(input.invitation ? { invitation: input.invitation } : {}),
      ...(input.reauth ? { reauth: true } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    authorizationUrl?: string;
    canonicalUrl?: string;
    error?: string;
  };
  if (response.ok && body.authorizationUrl)
    return { authorizationUrl: body.authorizationUrl };
  // The Host may know a name this sign-in can complete under even when the one
  // we asked from cannot; moving there is the fix, not an error to report.
  if (body.canonicalUrl) return { canonicalUrl: body.canonicalUrl };
  throw new Error(body.error ?? `Could not start sign-in (${response.status})`);
}

/** Starts an authorization-code sign-in and hands this page to Microsoft. */
export async function startCodeLogin(invitation?: string): Promise<void> {
  const started = await beginCodeLogin({ invitation });
  browserNavigation.assign(
    "authorizationUrl" in started ? started.authorizationUrl : started.canonicalUrl,
  );
}

/**
 * Confirms the signed-in administrator with Microsoft without leaving this page.
 *
 * A change the Host refused for want of a recent sign-in is still sitting in
 * this page — a half-filled form, a held request — and a full-page sign-in
 * would throw it away. So the sign-in runs in a tab of its own, which the
 * Host's callback lands on a page that hands back here (see
 * {@link announceIdentityConfirmed}).
 *
 * The tab is opened before anything is awaited, because a browser only lets a
 * page open one during the click that asked for it. If it will not open one,
 * or the sign-in can only complete under another name for this Host, the
 * whole page goes instead: losing the held change is better than no sign-in.
 *
 * @returns where the sign-in went: `"tab"` while this page stays put, or
 *   `"page"` when this page itself is on its way out.
 */
export async function confirmIdentityInNewTab(): Promise<"tab" | "page"> {
  const tab = browserNavigation.openTab();
  if (!tab) {
    await startCodeLogin();
    return "page";
  }
  let started: CodeLoginStart;
  try {
    started = await beginCodeLogin({ reauth: true });
  } catch (error) {
    tab.close();
    throw error;
  }
  if ("canonicalUrl" in started) {
    tab.close();
    browserNavigation.assign(started.canonicalUrl);
    return "page";
  }
  tab.assign(started.authorizationUrl);
  return "tab";
}

/*
 * The confirming tab and the tab that is waiting on it share an origin, so a
 * BroadcastChannel joins them without either holding a reference to the other
 * (the waiting tab cut its link to the new one before Microsoft loaded). The
 * channel only says "look again": nothing crosses it that the waiting tab
 * would trust, which re-reads its proof of session from the Host itself.
 */
const AUTH_CHANNEL = "fleet:auth";

type AuthChannelMessage =
  | { type: "identity-confirmed"; id: string }
  | { type: "identity-confirmed-ack"; id: string };

function isAuthChannelMessage(value: unknown): value is AuthChannelMessage {
  if (!value || typeof value !== "object") return false;
  const { type, id } = value as { type?: unknown; id?: unknown };
  return (
    (type === "identity-confirmed" || type === "identity-confirmed-ack") &&
    typeof id === "string"
  );
}

/**
 * Tells any tab waiting on this sign-in that it finished.
 *
 * @returns whether a waiting tab took it up within `timeoutMs`, so the page
 *   that says so can tell the person whether there is anything left to do.
 */
export function announceIdentityConfirmed(timeoutMs = 1_500): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined") return Promise.resolve(false);
  const channel = new BroadcastChannel(AUTH_CHANNEL);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const finish = (taken: boolean) => {
      clearTimeout(timer);
      channel.close();
      resolve(taken);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    channel.onmessage = (event: MessageEvent) => {
      const message: unknown = event.data;
      if (isAuthChannelMessage(message) && message.type === "identity-confirmed-ack") {
        if (message.id === id) finish(true);
      }
    };
    channel.postMessage({ type: "identity-confirmed", id } satisfies AuthChannelMessage);
  });
}

/**
 * Listens for a sign-in finished in another tab.
 *
 * @param listener returns whether this tab was waiting for it and took it up;
 *   only then is the confirming tab told it may close.
 */
export function onIdentityConfirmed(listener: () => boolean): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(AUTH_CHANNEL);
  channel.onmessage = (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isAuthChannelMessage(message) || message.type !== "identity-confirmed") return;
    if (listener()) {
      channel.postMessage({
        type: "identity-confirmed-ack",
        id: message.id,
      } satisfies AuthChannelMessage);
    }
  };
  return () => channel.close();
}
