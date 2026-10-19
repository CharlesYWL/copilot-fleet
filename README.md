<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/copilot-fleet-mark-dark.svg" />
  <img src="docs/assets/copilot-fleet-mark-light.svg" alt="Copilot Fleet" width="88" />
</picture>

# Copilot Fleet

**Run GitHub Copilot CLI agents on every machine you own, and watch them all from one screen.**

Self-hosted · one outbound connection per machine · your Copilot login never leaves the machine it runs on

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.5-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Copilot CLI](https://img.shields.io/badge/Copilot_CLI-%E2%89%A51.0.69-24292f?style=flat-square&logo=githubcopilot&logoColor=white)
![Platforms](https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-4493F8?style=flat-square)

**English** · [简体中文](README.zh-CN.md)

[Quick start](#quick-start) · [Features](#features) · [How it works](#how-it-works) · [Docs](docs/guide/README.md) · [Security](docs/guide/security.md)

<br />

<img src="docs/screenshots/monitor-wall.png" alt="The Copilot Fleet overview: sessions across several workspaces and nodes, each card streaming its own transcript live." width="960" />

</div>

---

Copilot Fleet is a control plane for Copilot CLI agents spread across your
laptop, dev boxes, and build servers. A **Host** keeps state and serves the web
UI. Each **Node** dials out to it and runs one isolated Copilot process per
session. Start a session on any machine, follow every transcript live, answer
permission prompts, and let an Orchestrator split larger goals across workers.

## Features

<table>
<tr>
<td width="50%" valign="middle">

### The whole conversation, anywhere

Open any card for the full transcript, a composer with slash commands and file
attachments, and the agent's own Model and Mode pickers.

[Using the Fleet UI →](docs/guide/using-fleet.md)

</td>
<td width="50%"><img src="docs/screenshots/session-detail.png" alt="A single session with its full transcript, composer, and model and mode pickers." width="100%" /></td>
</tr>
<tr>
<td width="50%" valign="middle">

### Any machine, one command

Generate a one-time connect command, paste it on a machine, and it joins the
fleet. Nodes connect outbound, so they need no open inbound port.

[Connecting Nodes →](docs/guide/nodes.md)

</td>
<td width="50%"><img src="docs/screenshots/nodes.png" alt="Settings → Nodes: the connect command and two enrolled machines with capacity and version." width="100%" /></td>
</tr>
<tr>
<td width="50%" valign="middle">

### One project, many checkouts

A workspace is a logical project. A placement maps it to a real path on each
machine, so a session always starts in a directory you approved.

[Getting started →](docs/guide/getting-started.md#first-run-walkthrough)

</td>
<td width="50%"><img src="docs/screenshots/workspaces.png" alt="Settings → Workspaces: three workspaces, each mapped to an absolute path on its machines." width="100%" /></td>
</tr>
<tr>
<td width="50%" valign="middle">

### An Orchestrator that delegates

Give a lead agent an objective. It plans phases, dispatches workers across
Nodes, and is woken when they finish. You review the result.

[Orchestration →](docs/guide/orchestration.md)

</td>
<td width="50%"><img src="docs/orchestrator.png" alt="The orchestrator loop: the lead dispatches workers through Fleet tools and is woken with a summary when they finish." width="100%" /></td>
</tr>
<tr>
<td width="50%" valign="middle">

### PR maintenance

Register a pull request and approve its repair scope. The lead then keeps
checking reviews and CI and sends the original worker back to fix what it
finds.

[PR maintenance →](docs/guide/orchestration.md#pr-maintenance-opt-in-pilot)

</td>
<td width="50%"><img src="docs/pr-maintenance-repair-loop.png" alt="The PR maintenance repair loop: check GitHub, triage one batch, continue the original worker, reconcile the result." width="100%" /></td>
</tr>
<tr>
<td width="50%" valign="middle">

### Reach it from anywhere

Turn on Dev Tunnels, Cloudflare, Tailscale Funnel, or ngrok from Settings. Use
Microsoft sign-in to control who can operate the fleet. Verified Microsoft
corporate administrators can instead use [Corp direct](docs/corp-direct.md)
for private-IP HTTPS/WSS between reachable Windows Dev Boxes, without Dev Tunnels.

[Sign-in and remote access →](docs/guide/sign-in-and-access.md)

</td>
<td width="50%"><img src="docs/screenshots/tunnel.png" alt="Settings → Tunnel: Cloudflare, Tailscale Funnel, Dev Tunnels, ngrok, and bore providers." width="100%" /></td>
</tr>
</table>

**Also included:**

- **[Self-updating Nodes](docs/guide/operations.md#keeping-nodes-up-to-date)**: choose **Update** or **Update all** in the Nodes tab. A supervisor restarts each Node on the new build.
- **[Survives restarts](docs/guide/operations.md#recovering-sessions-after-a-restart)**: Nodes buffer events while disconnected, and interrupted sessions can be resumed.
- **[Host MCP forwarding](docs/guide/mcp-and-agency.md#host-authenticated-mcp-forwarding)**: share Host-authenticated MCP servers such as Figma with every Node.
- **[Agency mode](docs/guide/mcp-and-agency.md#agency-mode)**: for Microsoft staff, launch sessions through `agency copilot` across the fleet.
- **[Chats](docs/guide/using-fleet.md#chats)**: start a session with no checkout, for questions and research.
- **[Local agents](docs/guide/orchestration.md#local-agents-handing-work-to-an-orchestrator-from-this-machine)**: hand work to an orchestrator from an agent on your own machine.
- **[Windows login startup](docs/guide/nodes.md#windows-login-startup)**: start the Host and Node when you sign in to Windows.
- **[Backup, restore and migration](docs/guide/operations.md#moving-a-host-or-a-node-to-another-machine)**: move a Host or Node to another machine.

## Quick start

You need [Node.js](https://nodejs.org/en/download) 22.5+, npm 10+, Git, and
[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)
1.0.69+ signed in on every machine that will run agents.

**1. Start the Host**

```bash
git clone https://github.com/charlesyin_microsoft/copilot-fleet.git
cd copilot-fleet
npm install
cp .env.example .env    # PowerShell: Copy-Item .env.example .env
npm run build
npm run start:host
```

**2. Claim it.** Open `http://127.0.0.1:8787` and enter the one-time code the
Host printed to its console. Sign in with Microsoft, or continue without
sign-in for local or private-tunnel use only.

**3. Connect a machine.** Enable one or more permitted providers in
**Settings → Tunnel / Remote access**, then choose the appropriate provider's
section under **Settings → Nodes → Connect a machine**. Generate a command and
run it from a Fleet checkout on that worker. Providers can run side by side:
use Corp direct for reachable private networks and Dev Tunnels for workers
that cannot reach that private address. The Nodes table shows the connection
method reported on each successful connection.
Corp direct requires network/firewall approval and its one-time Host firewall setup;
cross-region private-IP access is not guaranteed.

**4. Add a workspace.** In **Settings → Workspaces**, create a workspace and add
a placement: an existing folder on that Node.

**5. Start a session.** Choose **New session**, write a prompt, and watch it
stream.

> [!TIP]
> No Copilot login yet? Connect a Node with `--mock-agent` to try the whole UI
> with a deterministic fake agent. See
> [the no-login demo](docs/guide/getting-started.md#exact-proof-of-concept).

The [full walkthrough](docs/guide/getting-started.md) covers development mode,
the setup tour, tunnels, and troubleshooting.

## How it works

<img src="docs/architecture.png" alt="Copilot Fleet architecture: the browser talks to the Fleet Host over REST and WebSocket; the Host stores events in SQLite and sends commands over a Node-initiated connection; each Node runs one Copilot CLI process per session over ACP." width="960" />

The Host owns desired state and history. The Node owns execution. Copilot
credentials, child processes, and local paths never leave the Node, and the
Node is always the side that dials out.

- Nodes enroll with a one-time grant and pin the Host's fingerprint. Their
  connection is signed and encrypted end to end, so a tunnel can relay it
  without reading it.
- Each session is its own Copilot CLI process, driven over the
  [Agent Client Protocol](https://agentclientprotocol.com).
- Events carry per-session sequence numbers. A Node buffers them while offline
  and replays them when it reconnects.

More: [How it works](docs/guide/how-it-works.md) ·
[ARCHITECTURE.md](ARCHITECTURE.md) · [Security model](docs/guide/security.md)

## Documentation

| Guide                                                         | What's inside                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Getting started](docs/guide/getting-started.md)              | Requirements, Host setup, first-run walkthrough, diagnostics, no-login demo |
| [Sign-in and remote access](docs/guide/sign-in-and-access.md) | Claiming a Host, Microsoft sign-in, administrators, tunnels                 |
| [Connecting Nodes](docs/guide/nodes.md)                       | Windows Node, login startup, flags, the Node config page                    |
| [Using the Fleet UI](docs/guide/using-fleet.md)               | Overview, Chats, alerts, attachments, downloads, slash commands             |
| [Orchestration](docs/guide/orchestration.md)                  | Orchestrator, PR maintenance, runs, local agents, approved remote commands  |
| [MCP forwarding and Agency](docs/guide/mcp-and-agency.md)     | Sharing Host MCP servers, Agency mode                                       |
| [Operations](docs/guide/operations.md)                        | Updates, moving machines, session recovery and retention                    |
| [Security model](docs/guide/security.md)                      | Trust boundaries and controls                                               |
| [Development](docs/guide/development.md)                      | Commands, benchmarks, local verification                                    |

## Development

```bash
npm run dev       # Host + UI + local Node, with hot reload
npm test          # unit and integration tests
npm run verify    # lint, format, types, tests, then production builds
```

Run `npm run verify` before pushing. See [Development](docs/guide/development.md)
for watch mode, end-to-end browser tests, and benchmarks.
