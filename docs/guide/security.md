# Security model

[← README](../../README.md) · [Guide index](README.md)

The trust boundaries and controls behind sign-in, enrollment, the Node channel, and permissions.

## Security notes

- In explicit no-auth mode, local access or a private Dev Tunnel replaces Fleet
  login. All reachable operators have control; keep the listener on loopback and
  never enable anonymous tunnel access. Skipping requires a browser-bound console
  grant, cannot downgrade an existing protected Host, and never borrows another
  application's client/tenant ID.
- With Microsoft sign-in enabled, the operator UI and API require a Fleet session belonging to a
  live administrator. A Fleet session is issued only after Microsoft Entra ID
  has authenticated the person **and** this Host's own administrator table has
  authorized them: a supported Microsoft account that nobody added is
  refused with a named `403` and gets no session. Sessions are opaque 256-bit
  values stored as SHA-256 digests, `HttpOnly`, `SameSite=Strict`, `Secure` on a
  configured HTTPS endpoint, with a seven-day idle and 30-day absolute life. No
  Microsoft access, refresh, ID or device token is ever persisted.
  `/api/health` and `/api/auth/status` stay unauthenticated so a tunnel URL can
  be probed without becoming an administrator.
- Claiming a fresh Host takes two independent proofs: a 128-bit one-time code
  printed only to the Host's console, and a Microsoft sign-in. Neither is
  sufficient alone, the claim is a single atomic transaction, and a second
  identity racing it gets `409` rather than a second administrator. Request IP,
  apparent loopback, `x-forwarded-proto` and caller-supplied `Host` values are
  not security inputs — every supported tunnel relays into loopback, so all of
  them describe the relay.
- State-changing operator requests carry an `X-CSRF-Token` derived with an HMAC
  from the session, or the no-auth principal in skipped mode. Host and origin
  checks apply in both modes.
- High-impact changes — removing an administrator, disabling the password,
  changing Microsoft sign-in configuration, exporting a portable backup —
  additionally require an **authorization-code** sign-in from the last ten minutes. A device
  sign-in does not satisfy it, because an attacker can start a device flow and
  have an administrator finish it. Settings opens that sign-in in a new tab, so
  the page and anything typed into it survive; it falls back to the same tab only
  when the browser blocks the new one. Turning the local agent API on or changing
  its scope is then finished automatically, because that request is repeated
  exactly and still checks the revision it was made from. Every other change
  waits for the administrator to retry it.
- In Microsoft mode, generating a connect command requires a live Microsoft administrator session
  and CSRF protection, but no recent reauthentication. Authorization-code and
  device sign-ins both work for this operation. In no-auth mode, a reachable
  operator with CSRF proof can generate the same single-use grant.
- Removing an administrator revokes their sessions and closes their live browser
  sockets in the same operation; a 60-second sweep re-checks every open socket
  against the live session and administrator rows.
- The opt-in [local agent API](orchestration.md#local-agents-handing-work-to-an-orchestrator-from-this-machine)
  is a separate listener on literal `127.0.0.1`, unauthenticated by design. It
  reaches only the orchestrators and workspaces an operator exposed, never the
  main `/api`, `/ws` or lead `/mcp`, and refuses browser, proxy and credential
  headers. Fleet's own tunnel refuses to forward its port. Restore and Host
  sign-in reset turn it off.
- Legacy password sign-in is opt-in, off on a fresh Host, and retired
  automatically by the first Microsoft claim. Disabling it
  deletes the verifier and records the choice, so a stale
  `FLEET_OPERATOR_PASSWORD` cannot re-enable it.
- The Host answers only to names it knows: loopback, `FLEET_PUBLIC_URL`, the
  live tunnel URL, and anything listed in `FLEET_ALLOWED_HOSTS`. Requests
  arriving under any other `Host`, or from another `Origin`, are refused —
  which is what keeps a page the operator happens to visit from reaching the
  fleet through a rebound DNS name. `FLEET_ALLOWED_HOSTS=*` disables the check.
- A session or bootstrap grant is issued only over loopback or an endpoint this
  Host itself published as HTTPS. A plain-HTTP relay such as `bore` is refused
  for the operator console by the Host, not merely disabled in the UI.
- `/mcp` is a separate machine principal, not an operator-cookie exception. It
  accepts only a signed lead token bound to a live lead session, run and node,
  rejects browser `Origin` headers, and audits every refusal without recording
  the bearer value.
- A node's own credentials reach only the workspace and placement endpoints its
  config page relays through, and a node can only create or repoint placements
  on itself.
- Session file downloads cross only a mutually authenticated Node channel. The
  Node reads only inside the session's own folders, never Fleet's configuration
  directory, Copilot's configuration or the Host's data directory, and the Host
  serves every file as an `application/octet-stream` attachment so nothing an
  agent wrote renders on the operator's origin.
- New enrollment sends no reusable credential to an unauthenticated Host. A
  one-time grant authorises exactly one Node public key for fifteen minutes;
  the node pins the Host fingerprint before it completes, both ends sign the
  whole handshake, and the connection derives per-direction AES-256-GCM keys
  with sequenced frames — so a relay can carry the traffic without reading,
  forging, or replaying it.
- The legacy fleet-wide enrollment token exists only for machines that predate
  Node keys. A fresh Host never has one, does not persist one, and refuses token
  registration; Settings shows how many machines are left, and enforcement —
  which deletes the stored secrets and retires the token — is refused while any
  node still needs one. There is no automatic upgrade off a shared secret: that
  secret has already reached whatever relays the connection, so a machine
  migrates by running a fresh Connect command, which reclaims its own node row
  against a key.
- Copilot authentication and tokens remain on the Node and are never included
  in Fleet messages.
- Session requests reference preconfigured placement IDs. Nodes also require an
  existing absolute directory and resolve it before process creation.
- Copilot is spawned directly with argument arrays, `shell: false`, and the
  selected placement as `cwd`.
- Permissions are explicit and auditable in the UI (allow-once / deny only).
  YOLO is off by default for new sessions. Turn it on from **Settings →
  General** or in the **Start a session** dialog when you deliberately want the
  Host to start Copilot with `--allow-all` (tools, paths, and URLs) for that
  session. Unanswered and disconnected requests still fail closed when YOLO is
  off.
- Security-relevant decisions are recorded in a local audit kept to the newest
  10,000 rows, readable from Settings → Security. Claim codes, authorization
  codes, device codes, Microsoft tokens, Fleet cookies, invitations, enrollment
  grants, lead tokens and private keys are never logged.
- The node's local config page is bound to loopback and additionally refuses
  requests that do not name `127.0.0.1` (or `localhost`) on its own port, come
  from another origin, or write without `content-type: application/json`. It
  does not defend against another user signed in to the same machine, or against
  the node's own agents, which run as its user; the identity address they are
  given saves them a search, and grants nothing they could not already reach.
- An internet-exposed Host should still use HTTPS/WSS, and putting one behind
  an authenticated reverse proxy or access policy (for example Cloudflare
  Access) remains a good second layer.
