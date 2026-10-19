# Corp direct private-IP access

Date: 2026-10-16. Approved by Charles in chat; default port subsequently changed to 8787. Revised 2026-10-19 at Charles's request: remove worker source lists and permit any reachable source, while retaining all existing authentication.

## Goal

Offer a Microsoft-corporate-only private-IP remote-access provider beside the existing tunnel providers. Generate interactive `npm run node -- ...` and Windows login-start `npm run service -- node ...` commands. Keep the running checkout, services, credentials, firewall and tunnels untouched during implementation; deliver a private-repository PR for manual deployment.

## Architecture and security

- Provider ID `corp-direct`, label `Corp direct (private IP)`, access class `private-network`. It is allowed only under the corporate policy, never no-auth or public-account policy. The enabling/configuring actor must be an authenticated administrator whose verified tenant and username satisfy the existing Microsoft corporate identity predicate. This software restriction does not claim organizational approval of the network configuration.
- Persist explicit Host RFC1918 IPv4 address and TCP port (default 8787). Bind HTTPS only to that address; preserve HTTP loopback and all existing tunnels. Reject address/port conflicts without selecting a different port silently. Apply no source-IP filtering. Provide a Windows Firewall command with `-RemoteAddress Any`, restricted to the selected local address, port and executable; do not automatically elevate or change firewall policy from an HTTP request. Old per-worker allowlists are discarded when reading settings or backups, without rotating existing certificate trust.
- Use Windows certificate APIs to create a durable Host-specific private CA and renewable IP-SAN server certificate. Do not install either in Windows trust stores. Protect private material like the existing Host identity; public API responses contain only public CA material. Restarts preserve trust. CA loss/expiry must fail clearly rather than silently replacing the trust anchor.
- Reuse a small Node-only HTTP/WebSocket forwarding implementation for the Host TLS edge and the Node loopback helper. The Node helper validates the remote certificate using only its configured CA and normal IP-name validation, rejects cross-origin/rebinding access, never follows redirects, and has a fixed upstream. Agent MCP calls, enrollment, API calls and the control socket all use that helper, so all off-machine traffic uses TLS without broad process or OS trust changes.
- Node flags: `--corp-direct=<https-private-ip-url>` and `--host-ca=<base64-public-CA-PEM>`. Preserve grant and application Host-key pinning. Persist a structured direct connection `{hostUrl, caCertificate}` independently of the ephemeral loopback forwarding address. Recreate the helper on login, reconnect and restart. Reject conflicting explicit tunnel-mode flags. Do not save enrollment secrets in scheduled tasks.
- Do not broadcast this endpoint to existing Nodes automatically: the new trust configuration must be adopted explicitly via a generated command. A changed Host address requires an explicit update/new command; central IP discovery and automatic reboots are outside scope.
- Browser access through an untrusted private CA is not silently enabled. Keep the existing Host-local UI available; document optional explicit browser trust separately. No inbound Node firewall rule is required.

## Interfaces

`CorpDirectConfigSchema`: `{hostIp: RFC1918 IPv4, port: integer 1..65535 default 8787}`. Legacy `allowedSources` fields are ignored.

`CorpDirectConnectionSchema`: `{hostUrl: HTTPS private-IP origin, caCertificate: public certificate PEM}`.

`TunnelInfo.corpDirect`: optional `{supported, addresses, configuration: config|null, caCertificate?, firewallCommand?}`.

`UpdateTunnelSchema.corpDirect`: optional configuration. `ConnectCommand.corpDirectCa`: optional public PEM.

`@fleet/protocol/http-relay` exports `createHttpRelay({upstream, caCertificate?, tls?: {pfx, passphrase?}, rewriteHost?, allowPeer?, allowRequest?})`, returning `{server, close}`. It is Node-only and not imported through the browser protocol entry point.

## Acceptance

Corporate-only UI and server controls; strict assigned private-Host-address validation; no worker source list and a firewall rule accepting any reachable source; persistent CA and leaf renewal; concurrent explicit loopback/private bindings on 8787; trusted HTTPS and WSS plus negative certificate and authentication tests; generated commands for both launch modes; no Dev Tunnels dependency in direct mode; persisted service configuration without enrollment-secret persistence; agent MCP transport through the same verified helper; no private-key disclosure in public/legacy backups; safe portable-backup handling and legacy allowlist removal without trust rotation; regression coverage for existing providers; successful lint, formatting, type checks, tests and production build. Real-box reboot, cross-region and long-duration validation remain manual and must be identified as such in the PR.
