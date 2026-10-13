# Sign-in, administrators and remote access

[← README](../../README.md) · [Guide index](README.md)

Claiming a Host, Microsoft sign-in, administrators, and which tunnels may expose the operator console.

## First run: claiming a Fleet

A Fleet Host can start processes and read every transcript on every machine
enrolled in it. Microsoft sign-in is optional. After the console-code check,
**Continue without Microsoft sign-in** persists a no-auth mode: anyone who can
reach the Host can operate it. Keep `HOST=127.0.0.1` and use private Dev Tunnels
for remote access, without anonymous tunnel access. Other public tunnel providers
and direct public/LAN endpoints are refused in this mode. Host-name, browser-origin
and CSRF checks remain active; Nodes still use one-time enrollment grants and keys.

With Microsoft sign-in enabled, Entra ID plus this Host's administrator list
decides who may operate it independently of tunnel access. Existing Microsoft
and password protection cannot be skipped. Microsoft-specific administrator
operations and portable security exports still require a Microsoft administrator;
ordinary Fleet use, Node management and data backups work without sign-in.

Two proofs are needed to claim a fresh Host, and one alone is worth nothing:

1. **The console claim code.** 128 random bits, printed only to the Host's own
   stdout, valid for 30 minutes, and consumed by the first successful claim.
   Holding it proves you have access to the machine — which is the only fact a
   Host can establish about a network caller, because every supported tunnel
   relays into `http://127.0.0.1:<port>` and the source address, `Host` header
   and `x-forwarded-proto` all describe the relay rather than the browser.
2. **A Microsoft account.** Signing in proves who you are. Fleet records the
   account's immutable `(tenant id, object id)` pair and issues its own opaque
   session; no Microsoft access, refresh, or ID token is ever persisted.

The first account to present both becomes the one and only administrator.
Any other account, even one in the same tenant, is refused with a named `403`
and receives no session unless an administrator approves it.

### Microsoft sign-in: registration and account support

The public configuration supports **work/school accounts in any organizational
directory, including Microsoft corporate, and personal Microsoft accounts**.
An organization's consent and Conditional Access policies can still refuse
sign-in; Fleet does not bypass them. An enterprise configuration can instead
restrict authentication to one directory.

**To enable Microsoft sign-in, a publisher or operator must supply an approved app registration first.**
There is currently no approved Fleet-owned client ID bundled in this repository.
A fresh install without one offers setup or an explicit skip; it never silently falls back
to the borrowed Visual Studio client. Users of a distribution that supplies
legitimate configuration need no tenant setup of their own — the publisher has
already done the one-time registration work.

**New to app registrations?** The first-run page includes **First-time setup:
personal or corporate account** before you enter the claim code. Get the
registration ready first; the same help follows your account-type selection in
the configuration form, and all help links open in a new tab without losing
your entries.

Start in the [Microsoft Entra admin center](https://entra.microsoft.com), and
check which directory is selected before registering anything:

| Sign-in you want                                                         | Setup links                                                                                                                                                                                                                                                                                                                                                         | IDs to copy into Fleet                                                                                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal Outlook/Hotmail/Live, or both personal and work/school accounts | [Create the application/client ID](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app) in a directory you own or may manage. Choose **Any Entra ID Tenant + Personal Microsoft accounts** (also labeled **Accounts in any organizational directory and personal Microsoft accounts**).                                               | From the app's **Overview**, copy **Application (client) ID**. Select **Work/school and personal Microsoft accounts** in Fleet; it uses `common` automatically, with no tenant ID field.        |
| Corporate/work/school accounts restricted to one directory               | [Create an approved corporate application/client ID](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app) and [find the directory/tenant ID](https://learn.microsoft.com/en-us/entra/fundamentals/how-to-find-tenant). Choose **Single tenant only - your tenant** (also labeled **Accounts in this organizational directory only**). | Copy **Directory (tenant) ID** and **Application (client) ID** from the app's **Overview**. Select **One organization (fixed directory)** and paste both GUIDs, not a domain name or Object ID. |

A personal Microsoft account alone is not an Entra directory and does not
automatically grant registration permissions. See Microsoft's
[directory setup and eligibility guide](https://learn.microsoft.com/en-us/entra/fundamentals/create-new-tenant)
if you need one; tenant creation has subscription and permission requirements.
Alternatively, ask the Fleet publisher/operator for an approved client ID.
Do not register a private Fleet in your employer's directory. For a
company-owned Fleet, follow the organization's app-registration process; if it
asks for a Service Tree ID or other ownership metadata, ask the owning team or
tenant administrator. A corporate account can also use the public option when
the registration and organization policies allow it.

The publisher/operator registers once in a directory they legitimately control:

1. Register an application with supported account types **Accounts in any
   organizational directory and personal Microsoft accounts** for public use.
2. Under **Mobile and desktop applications**, register the native/public-client
   redirect `http://localhost:<port>/api/auth/entra/callback`, for example
   `http://localhost:8787/api/auth/entra/callback`. Use **neither Web nor SPA**.
   Use the **Host API port** (8787 by default), not the Vite UI port (5173).
   The localhost name and callback path must match; native localhost redirects
   allow the local listener port to vary.
3. Use authorization code with PKCE, **without a client secret**. Fleet requests
   `openid`, `profile`, and `email`; MSAL also adds `offline_access`. No Graph API
   access is needed, and Microsoft access, refresh, and ID tokens are not
   persisted. Device sign-in is optional and separately verified, not a
   prerequisite for PKCE.
4. Maintain registration ownership and recovery, provide appropriate publisher
   support information, and test with authorized personal and organizational
   accounts before distributing the configuration or migrating production.
   Only the public client ID and authority belong in Fleet configuration.

For public account support, replace the placeholder with the approved
Application (client) GUID:

```bash
FLEET_ENTRA_CLIENT_ID=<approved-application-client-guid>
FLEET_ENTRA_TENANT_ID=common
```

With a client ID, omitting `FLEET_ENTRA_TENANT_ID` also selects `common`; blank
or invalid values are rejected. `common` is an **authority selector**, never an
administrator's tenant identity. Fleet still identifies every administrator by
their validated directory and object IDs, not by email.

For a fixed-directory enterprise deployment, use the directory GUID and a
compatible approved registration:

```bash
FLEET_ENTRA_TENANT_ID=<directory-tenant-guid>
FLEET_ENTRA_CLIENT_ID=<approved-enterprise-application-client-guid>
```

Replace both placeholders with GUIDs from the registration. Existing GUID/client
pairs retain their enterprise meaning. The borrowed Visual Studio client cannot
be used with `common`; changing its authority is not a public registration.

Microsoft sign-in only controls access to this Fleet Host. It is separate from
GitHub Copilot credentials and subscription on each Node, and from the tunnel
provider's own authentication. A personal Fleet account does not establish
eligibility or authentication for either of those services.

### The claim itself

1. Start the Host. It attempts to copy the claim code to the local clipboard
   (Windows, macOS, or Linux with `wl-copy`/`xclip`); if unavailable, copy it
   from the console manually. The printed claim link opens the Vite UI at
   `http://localhost:5173` during `npm run dev`, or the Host URL in production.
2. Open `http://localhost:5173` for development, or `http://localhost:8787`
   for production (default port) — use `localhost`, not `127.0.0.1`; the UI
   redirects if you get it wrong, because the registered reply URL is matched by
   name and the transaction cookie follows it.
3. Enter the claim code. If setup is required, supply the approved Application
   (client) ID; **Work/school and personal Microsoft accounts** is the default
   and asks for no tenant ID. Choose the fixed-directory option explicitly for
   enterprise use. Then **Claim with Microsoft**.
4. You are now this Fleet's administrator. Enrol machines from
   **Settings → Nodes**.

The setup authorization lasts ten minutes. If **Save and continue** asks for the
claim code again, use **Unlock setup again** on the same page; your client ID and
account-type selection are retained. Then save again. The console code itself
expires after thirty minutes; restart the unclaimed Host for a new one if needed.
There is no need to delete the database or recreate the app registration.

### Reset Host sign-in without deleting Nodes

Stop the Host, then run:

```bash
npm run host:fresh
```

This rebuilds and starts **only the Host**, using the existing `DATABASE_PATH`
and serving the built UI on the Host port. It clears the Microsoft client/tenant
configuration, administrators, administrator invitations, browser sessions,
password/recovery settings, device-flow setting and browser authentication keys.
The new console claim code lets you configure sign-in and claim the Host again.

**Nodes and connection data are retained:** Node IDs, keys and legacy credentials,
the Host signing identity/fingerprint, enrollment data, saved URL/tunnel settings,
orchestrator keys, workspaces, placements and agent sessions. The security audit
is retained and records the reset. Nodes reconnect normally without re-enrollment;
their processes and Copilot/tunnel login credentials are not reset.

The command refuses to reset a database already in use. It is intentionally
destructive to **browser authentication only** and runs without a file watcher,
so edits cannot repeatedly erase a newly claimed administrator. For this run it
ignores `FLEET_ENTRA_TENANT_ID`, `FLEET_ENTRA_CLIENT_ID` and
`FLEET_OPERATOR_PASSWORD`, without editing `.env`. A later normal startup can use
the Microsoft registration environment settings again if you have not saved a
replacement configuration; password sign-in remains disabled until explicitly enabled.

For the same reset **without restarting the Host or Nodes**, use **Erase auth
settings** at the bottom of **Settings → Security**. It requires a current
Microsoft administrator, authorization-code reauthentication within ten minutes,
and typing `ERASE AUTH` in the confirmation dialog. Have access to the Host
console first: all browsers are signed out, and the new claim code is printed
only there, never returned to the browser. Pending Microsoft/device/bootstrap
transactions are retired and browser authentication keys are rotated. Live Node
connections and their keys, settings and working data are untouched. Close any
other Host instance or database viewer using the same database before erasing;
the running Host acquires exclusive database access and keeps it until shutdown.

### Signing in from somewhere else

Authorization code with PKCE and a loopback callback is the primary flow, so a
remote browser has two options. Public account support does **not** make a
browser-only public tunnel login work: localhost in a callback means the
browser's machine, not the remote Host.

- **Forward the Host to your own machine** and use `http://localhost:<port>`:

  ```bash
  devtunnel connect <tunnel-id>
  ```

  Use SSH `-L` or your provider's client to reach the Host's localhost callback
  on the forwarded port. This is the recommended path when you can establish
  that forward; the existing Vite UI/API port split still applies in development.

- **Device sign-in**, if your organization permits it. Microsoft recommends blocking
  the device code flow by default and Conditional Access commonly does, so
  Fleet keeps it **off** until it has watched one complete. An administrator
  turns it on from **Settings → Security → Verify device sign-in**: the check
  runs whatever the setting currently says, and only a completed flow writes
  it. Enabling it means the Host offers a flow after one successful verification,
  not that every organization's policy is known to allow it. A refused
  verification does not enable it, and another organization can still block a
  later sign-in.

  A device code is the one credential an attacker can ask _you_ to enter on
  their behalf. Only ever enter a code the Fleet page in front of you is
  showing. Fleet additionally requires a fresh authorization-code sign-in — not
  a device sign-in — before removing an administrator, disabling the password,
  changing Microsoft sign-in configuration, or exporting a portable backup.

Fleet sessions are per-origin. A session issued on `localhost` authorises that
forwarded UI and does not set a cookie for a public tunnel domain.

### Adding and removing administrators

Fleet asks for no Graph permission to search your directory. There are two ways
to add an administrator, depending on who will sign in.

**Another account you control:** choose **Settings → Security → Add another
account**, then **Choose account in new tab**. This explicitly authorizes the
account you select to become a full administrator, with no separate approval.
Microsoft's account picker opens in a normal new tab; no private window or
logout is needed. Your original Fleet session stays signed in. After success,
close the new tab and return to Security; the administrator list refreshes.
If popups are blocked, allow them for this Host and retry.

This flow requires a recent Microsoft authorization-code sign-in by an existing
administrator, plus that administrator's still-live session when the new account
finishes signing in. It is a short-lived, single-use, browser-bound operation,
not a link to share. Both accounts must be supported by the Host's registration;
organization consent and Conditional Access still apply.

**Someone else's account:** use an invitation with explicit approval:

1. **Settings → Security → Invite someone else** mints a single-use link that
   expires in 15 minutes.
2. The recipient opens it and signs in with Microsoft.
3. That records them as a **candidate** — it grants nothing. The exact account
   that turned up is shown, with its object and tenant id.
4. An existing administrator approves or rejects that identity.

A leaked link is therefore not an escalation: the wrong person redeeming it
appears in the pending list and is rejected.

Removing an administrator revokes every session they hold and closes their open
browser connections in the same operation, mid-transcript if necessary. The last
active administrator cannot be removed, and removal needs a Microsoft
authorization-code sign-in from the last ten minutes.
You cannot remove your own currently signed-in administrator account: its Remove
button is disabled, and the API refuses self-removal too. Another administrator
can remove that account while signed in as themselves.

### Changing Microsoft sign-in configuration

Upgrades conservatively pin existing claimed Hosts to their prior configuration,
including legacy fixed-directory corporate configurations. Changing environment
variables alone does not switch a claimed Host or broaden its account audience.

1. Keep console access and record the current client ID and directory/authority.
   Export a passphrase-encrypted portable backup from **Settings → Security →
   Move this Host** before switching. The General tab's data-only export does
   not back up the security configuration. Protect the portable backup and keep
   its passphrase separately; never commit or attach either to an issue.
2. Test the proposed registration on a separate fresh Host first. Make sure the
   current administrator can authenticate through both registrations with the
   **same `(tenant ID, object ID)`**. A guest identity and its home identity can
   differ even with the same email. If continuity cannot be proved, keep the
   old configuration; other identities must be added separately by an existing
   administrator, not by automatic migration or edits to the administrator table.
3. As an existing Microsoft administrator, use localhost or a local forward and
   open **Settings → Security → Change Microsoft sign-in configuration**.
   Choose the supported accounts and approved client ID, then **Verify new
   configuration with Microsoft**. This requires an authorization-code sign-in
   from the last ten minutes. If prompted, **Confirm with Microsoft** opens the
   sign-in under the current configuration in a new tab; finish it there, return
   to Security, and retry.
4. Sign in through the proposed registration as that same administrator. The
   new configuration is saved **only after successful identity verification**.
   Failure, cancellation, or a different identity leaves the old configuration
   intact. Success clears pending sign-in/device transactions, turns device
   sign-in off until reverified, revokes old sessions, and gives the migrating
   administrator a fresh session. Other administrators remain on the list, but
   the new registration must support their accounts. Narrowing back to a fixed
   directory can prevent administrators from other directories from signing in,
   even though their records are retained. Node identities and placements are
   unchanged.

**Rollback:** if the previous registration still accepts the same administrator,
switch back using this same verified Settings flow. An environment edit is not
a rollback. Retain the portable backup and console access for the documented
[portable restore procedure](operations.md#moving-a-host-or-a-node-to-another-machine) if
normal sign-in cannot be recovered. Do not run two Hosts with the same restored
identity at once.

### Migrating off the shared password

Hosts that predate Microsoft identity keep working long enough to migrate.
`FLEET_OPERATOR_PASSWORD` is an explicit, warned-about escape hatch — a fresh
Host without one generates nothing.

1. Sign in with the password the Host already has. Because nobody administers it
   yet, the console shows a migration checkpoint rather than the fleet.
2. If no approved Microsoft registration is configured, complete its setup first.
   **Claim with Microsoft.** The account you sign in with becomes this Fleet's
   first administrator, the shared password is deleted automatically, its
   sessions are revoked, and the console appears.

Microsoft-only is the secure default after claim. An administrator who
explicitly needs both methods can go to **Settings → Security → Enable password
sign-in** and choose a new password of at least **12 characters**, including an
**uppercase letter** and a **special character** (punctuation or a symbol, not
just whitespace). Longer passwords remain supported. The UI and API enforce
the same rule for newly configured passwords; existing passwords and the
environment-based migration path remain compatible.

The console claim code is not needed for any of that: proving the existing
password proves the same thing it stands for, so the Host trades that session
for the same short, browser-bound bootstrap grant and audits it as
`bootstrap_password_granted`. A Host that never had a password, and a portable
restore onto a rebuilt machine, still take the printed code.

Disabling deletes the stored verifier, records the choice so a stale
`FLEET_OPERATOR_PASSWORD` left in a shell profile cannot re-enable it, and
revokes every password session. If you lock yourself out, a local recovery
command on the Host console issues a temporary password and writes an audit
event; disable it again once you are back in.

### Tunnels and who can reach the sign-in page

| Provider                             | Reachability                             | Operator console                    |
| ------------------------------------ | ---------------------------------------- | ----------------------------------- |
| Direct `localhost`                   | This machine only                        | Always allowed                      |
| Dev Tunnels (creator-private)        | Microsoft login at the tunnel            | **Default and recommended**         |
| Dev Tunnels (tenant / anonymous)     | Wider, by your `devtunnel access` policy | Allowed, with a warning             |
| Cloudflare / ngrok / Tailscale HTTPS | Anyone with the URL                      | Allowed after claim, with a warning |
| `bore` and any plain-HTTP relay      | Anyone with the URL, in clear text       | **Refused**                         |

A fresh Host defaults to Dev Tunnels because its URL alone reaches nothing: the
provider demands a Microsoft login before Fleet's own claim screen is even
visible. A public HTTPS provider is fine after the Host is claimed — the sign-in
page grants nothing on its own — but a stranger can at least see it. A Host a
Microsoft corporate account administers does not offer public providers at all;
see below.

`bore` is refused for the operator console by the Host itself, not merely greyed
out in the panel: it relays plain TCP, so the session cookie and every
transcript behind it would cross it readable. The refusal holds for any client,
including one that never renders the UI.

#### Microsoft corporate accounts: Dev Tunnels only

Once any administrator of the Host is a Microsoft corporate account — an
`alias@microsoft.com` sign-in in Microsoft's corporate tenant, checked the same
way as [Agency mode](mcp-and-agency.md#agency-mode) — the Host only runs Microsoft-approved
remote access, which today is Dev Tunnels. **Settings → Tunnel** hides
Cloudflare, Tailscale Funnel, ngrok and bore, and the Host itself refuses to
start them, whether asked through the API, by a saved setting replayed at boot,
or by a restored backup. A corp machine is not published to the internet by
somebody trying the switches.

The rule belongs to the Host, not to one browser session: a tunnel runs for the
machine, so a co-administrator from another tenant or a recovery-password
session sees the same Dev Tunnels-only panel. A public tunnel that was already
running when a corporate account took over stops being trusted at once and is
stopped within a minute. One started in another terminal (`npm run tunnel`) is
shown as refused so you can stop it there. Hosts administered only by other
accounts — personal Microsoft accounts, other work tenants — keep every
provider.

Direct endpoints (`FLEET_PUBLIC_URL` on the Host, `--url` on a Node) are not
tunnels and are unaffected. That is the route planned for Dev Boxes on corpnet
to reach each other by internal address with no tunnel at all; it is intended to
join Dev Tunnels as another approved option under this same policy.
