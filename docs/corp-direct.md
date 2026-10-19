# Corp direct: private-IP access between Microsoft Dev Boxes

Corp direct connects enrolled Nodes to the Host over private-IP HTTPS and secure WebSockets, without a Dev Tunnels process, tunnel login or external relay. It is an opt-in remote-access provider for verified Microsoft corporate administrators. It does not establish that your organization has approved a particular network or firewall configuration.

The default port is **8787**. Fleet keeps its existing HTTP listener on `127.0.0.1:8787` for local use and existing tunnel targets, and binds a separate HTTPS listener to the selected private IPv4 address on the same port. These are different local addresses. Fleet refuses conflicts rather than silently choosing another port. Leave `HOST` unset or set it to `127.0.0.1`; wildcard or external plain-HTTP Host bindings are refused for this mode.

## Prerequisites

- Use the same updated Fleet revision on the Host and Nodes, with the repository's documented Node.js prerequisites.
- Automatic Host certificate generation requires Windows. It uses the built-in Windows PowerShell/.NET certificate APIs, with no additional certificate package or trust-store installation.
- The Host must already be claimed, Microsoft sign-in must be enabled, and the operator must be a verified `@microsoft.com` administrator in Microsoft's corporate tenant. An email-looking display name alone does not qualify. Public Microsoft accounts, other tenants, password-only sessions and no-auth mode cannot enable or configure Corp direct.
- Verify direct private-network reachability for the actual pair. Matching project names do not guarantee routing; the initial Dev Box test was between one specific pair. Cross-region, cross-pool, laptop and long-duration access must be validated separately.
- Worker IP addresses do not need to be discovered or listed. The Host firewall rule permits any reachable source on the selected private Host IP and port; network reachability alone grants no Fleet access. Confirm that your network policy permits this configuration.

## Host setup

1. Build and run the PR revision using your existing Host startup method. Stop the previous instance normally first; do not run two Hosts against the same database. Existing tunnel modes remain available.
2. Sign in as the Microsoft corporate administrator. In **Settings → Tunnel / Remote access**, choose **Corp direct (private IP)**.
3. Review the detected Host IPv4 address and HTTPS port (8787 by default). The Host address must be currently assigned and RFC1918. There is no worker IP/CIDR field or source-IP filter.
4. Enable the provider. Fleet creates and protects a persistent Host-specific private certificate authority and an IP-name server certificate. It starts the listener under the normal user account; no firewall rule is installed automatically.
5. If your network policy permits it, copy the generated **Host firewall command** into Administrator PowerShell on the Host. The rule names the exact local address/port and Node executable, with `-RemoteAddress Any`; any source that can route to that endpoint may attempt a connection, and Fleet's existing authentication still controls access. This is a one-time setup operation; Fleet itself remains unelevated. Review effective Windows Firewall policy because other allow/block rules can still apply.
6. The **Default for enrollment** provider supplies the single default address used by older tools. Under **Nodes → Connect a machine**, each online, permitted provider has its own command section, so you can choose Corp direct without changing that default. Enabling Corp direct does not move existing Nodes or disable Dev Tunnels.

Only the public CA certificate is included in API responses and connect commands. Private CA and server material remain in the protected Host database. Native issuance uses a separately access-restricted temporary directory, removes it after the helper exits, and never writes private bundles to PowerShell output streams or command-line arguments. The CA survives ordinary restarts, and server certificates renew using that same CA so renewal does not require copying a new trust anchor to every Node.

## Connect a Node

On the Host, open **Nodes → Connect a machine**, choose the **Corp direct (private IP)** section, and generate a fresh command. A grant is single-use and expires after fifteen minutes. Copy **one** launch method, not both. Each other online, permitted provider has its own section and independent grant; choosing one does not change the Host default.

### Mixed private-IP and tunnel workers

Keep Corp direct enabled for workers with a verified private-network path. Enable **Dev Tunnels** alongside it for workers that cannot reach that address, then generate their commands from the Dev Tunnels section. This does not change the route used by existing Corp direct Nodes. Each Node runs one selected connection mode; it does not need both helpers.

Cross-region private-IP access is **not guaranteed**. Our West US 3 to West US 2 test failed even though basic TCP probes succeeded; that does not establish a platform-wide restriction, and a matching region alone does not guarantee connectivity. Routing, pool/network isolation and network policy require separate validation. Corporate laptop browser access is a separate network/trust question; use the Host-local browser until it is approved and configured.

Microsoft corporate Hosts retain their existing Corp direct/Dev Tunnels restriction. Noncorporate Hosts can expose command sections for multiple permitted HTTPS providers at once. The default provider remains available for older single-address callers; there is no need to switch it to generate a provider-specific command.

Stop a worker's existing process or task before deliberately changing its mode. Use the full newly generated command for that provider. A Dev Tunnels worker needs `devtunnel user login` in its own user context; the explicit `--devtunnel` mode clears a previously saved Corp direct route. Existing Host-key pinning, Node identity and the normal enrollment/reuse checks remain enforced.

The Nodes table's **Connection** column shows reported or recognized connection methods, with **Last known** for offline values and **Unknown** when an older Node's route cannot be identified reliably. Update/reconnect workers for full reporting; these optional inventory fields do not require re-enrollment. The metadata is runtime-only and resets on Host restart or identity replacement.

### Foreground

The Corp direct foreground command installs dependencies, builds the Node and runs `npm run node -- ...`. Keep that terminal open. The flags include:

- `--corp-direct`: the selected HTTPS private-IP origin.
- `--host-ca`: the base64 public CA certificate, copied out of band in the same command.
- The existing Host ID, application-key fingerprint and one-time enrollment grant.

There is no `--devtunnel` flag or Dev Tunnels login step. Explicit `--url`/`--devtunnel` and `--corp-direct` connection modes cannot be combined.

### Windows login-start service

Choose the generated **npm service** command, which runs `npm run service -- node ...`. Use your normal Windows account. It builds, verifies the existing same-user GitHub/Copilot authentication context, enrolls and starts the Node, and registers the existing per-user login-start task.

Stop a running manual Node or existing Node task before installing/reconfiguring the service. Setup deliberately refuses to race another Node instance or replace a task pointing at a different checkout.

The Node persists the private Host origin and public CA in its connection settings. Enrollment grants are not saved in task arguments or manifests. Future service starts, self-updates and Windows sign-ins reuse the Node identity and saved trust; the original grant is not needed again.

After an interactive Node has already enrolled, the existing service command can adopt its saved state:

```powershell
npm run service -- node install --existing-node
```

Useful existing task controls:

```powershell
npm run service -- node status
npm run service -- node restart
npm run service -- node logs
npm run service -- node stop
```

Startup is **after Windows user sign-in**, not while the machine is signed out. GitHub/Copilot credentials still belong to that user and retain their existing authentication requirements.

## How transport trust works

The Node starts a built-in helper bound only to an ephemeral `127.0.0.1` port. The helper has one fixed private HTTPS upstream and explicitly verifies its certificate with the configured public CA and normal certificate-name checks. Existing enrollment, API, control-socket and agent MCP clients use this loopback endpoint; the only off-machine connection is the direct TLS hop to the Host.

This helper is part of the Node process, not an external tunnel or another manually managed service. It rejects foreign Host/Origin headers and does not follow redirects or choose upstreams from incoming URLs. Host announcements cannot move a Corp direct Node off the configured verified route. The Node keeps the canonical private origin and trust separately from the helper's temporary port and recreates the helper on each startup.

The public CA verifies the Host's TLS certificate; possession of it does not authorize a Node. Worker authorization still requires the one-use enrollment grant and the enrolled Node's private key. Operator access still requires Microsoft sign-in and the Host administrator allowlist.

No `NODE_TLS_REJECT_UNAUTHORIZED=0`, process-wide CA environment override, Windows root import or inbound worker firewall rule is required. Application Host-key pinning and key-based Node authentication remain in place on top of TLS.

## Browser access

Continue using the Host-local browser UI during the initial rollout. A CA copied only into a Node connection is not automatically trusted by Edge or another browser. This feature does not install browser trust or change your Entra redirect-URI configuration. If private-IP browser access is required, arrange explicit approved browser trust and applicable sign-in configuration separately; do not dismiss certificate warnings as a deployment step.

## Address changes, renewal and migration

Ordinary Azure private addresses are associated with network interfaces and are normally retained across an OS reboot while the interface remains intact. That is not a Dev Box-specific guarantee for repair, reprovisioning, restore or other managed operations. Windows reporting DHCP does not by itself establish Azure's allocation mode.

If the configured Host address is unavailable, Fleet fails closed and reports the mismatch. It does not bind a wildcard or guess a different address. Turn Corp direct off, explicitly update the assigned private IP or HTTPS port, enable it and run the appropriate firewall command. Generate a new Node command to update the saved remote address. An IP change also requires the correct IP-name server certificate; the Host renews the leaf under the existing CA.

Node connection fields are read-only in the ordinary settings form while Corp direct is active. Use a new generated startup command rather than editing only the ephemeral loopback URL.

Portable **encrypted security backups** carry the CA, server material and private-listener configuration. The older unencrypted data backup does not carry private TLS keys and preserves the receiving Host's authority. After moving a Host, review the restored private address and HTTPS port before enabling its listener. Missing, expired or mismatched existing authority is reported rather than silently replaced with a new CA that enrolled Nodes do not trust.

### Upgrading from the original worker-IP allowlist

Update and restart only the Host, then rerun its generated firewall command once in Administrator PowerShell. It replaces the same named rule with `-RemoteAddress Any`. Old `allowedSources` values in settings and imported backups are ignored; they cannot leave a hidden per-worker restriction in the new listener. The CA, Host identity and enrolled Node keys are retained. Existing Corp direct workers require neither a code update nor re-enrollment for this change when the Host address remains unchanged. Fleet does not alter the existing firewall rule automatically.

## Manual acceptance checklist

1. Keep Dev Tunnels available during the pilot. Enable Corp direct on one Host and verify its displayed HTTPS address and effective scoped firewall rule.
2. Enroll one worker with the foreground command. Verify the Node is online, create a normal Copilot session and exercise a Fleet MCP tool call from an orchestrator session.
3. Stop the foreground Node, install login startup using the saved identity, and verify no Dev Tunnels client is required.
4. Restart the Node task. Confirm it reconnects with the same Node ID, private Host origin and public CA; no expired grant should be required.
5. At an agreed maintenance time, reboot the worker and sign back in. Verify task status, logs, reconnection and an agent session. Record the private IP before and after; do not infer stability from one successful reconnect alone.
6. Restart the Host using its existing login-start method and verify its saved direct listener and CA are restored. Check that the local UI still works and no plain-HTTP listener is bound to the private interface.
7. Test wrong/untrusted certificates, missing/invalid enrollment grants and unauthenticated API access in a disposable environment; they must fail. Confirm a new worker can connect without adding its source IP. Test other regions and laptop access separately.
8. Once the desired Nodes have migrated successfully and policy approval is established, turn off Dev Tunnels if it is no longer needed.

To roll back, stop the direct Node task, use a new Dev Tunnels command from the Host to reconfigure it, verify reconnection, and turn Corp direct off. Remove the named Corp direct firewall rule using Administrator PowerShell. Disabling the provider retains its protected authority so a later re-enable does not rotate trust.
