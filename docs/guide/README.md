# Copilot Fleet guide

[← README](../../README.md)

Start with [Getting started](getting-started.md), then use the feature map when
you need a specific surface.

| Guide                                                                 | Covers                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Getting started](getting-started.md)                                 | Requirements, Host setup, first-run walkthrough, diagnostics, the no-login demo       |
| [Sign-in, administrators and remote access](sign-in-and-access.md)    | Claiming a Host, Microsoft sign-in, administrators, password migration, tunnels       |
| [Connecting and configuring Nodes](nodes.md)                          | Windows Node, login startup, command-line flags, the Node config page, moved Host URL |
| [Using the Fleet UI](using-fleet.md)                                  | Overview, Chats, ordering, alerts, attachments, downloads, slash commands             |
| [Orchestration](orchestration.md)                                     | Orchestrator, PR maintenance, runs, local agents, approved remote commands            |
| [Host MCP forwarding and Agency mode](mcp-and-agency.md)              | Sharing Host-authenticated MCP servers, launching through Agency                      |
| [Operations: updates, moves and recovery](operations.md)              | Updating Host and Nodes, moving machines, recovering and retaining sessions           |
| [How it works](how-it-works.md)                                       | Architecture, message flow, session states                                            |
| [Security model](security.md)                                         | Trust boundaries and controls                                                         |
| [Development](development.md)                                         | Commands, benchmarks, local verification                                              |

Deeper design records: [ARCHITECTURE.md](../../ARCHITECTURE.md),
[orchestration lifecycle](../orchestration-lifecycle.md),
[managed worktree isolation](../managed-worktree-isolation.md),
[Node session console](../node-session-console.md),
[session usage snapshots](../session-usage-design.md), and
[Windows login startup](../windows-login-startup.md).

## Feature map

- **Install and claim a Host:** [Requirements](getting-started.md#requirements),
  [Set up the Host](getting-started.md#set-up-the-host-windows-macos-linux),
  [First-run walkthrough](getting-started.md#first-run-walkthrough), and
  [claim details](sign-in-and-access.md#first-run-claiming-a-fleet).
- **Configure Microsoft sign-in and administrators:**
  [registration and account support](sign-in-and-access.md#microsoft-sign-in-registration-and-account-support),
  [signing in remotely](sign-in-and-access.md#signing-in-from-somewhere-else),
  [adding/removing administrators](sign-in-and-access.md#adding-and-removing-administrators), and
  [security notes](security.md#security-notes).
- **Choose access and tunnel model:**
  [tunnels and who can reach the sign-in page](sign-in-and-access.md#tunnels-and-who-can-reach-the-sign-in-page)
  and [following a moved Host URL](nodes.md#following-the-host-to-a-new-url).
- **Connect or maintain machines:** [Windows Node](nodes.md#windows-node-powershell),
  [Windows login startup](nodes.md#windows-login-startup),
  [Node command-line flags](nodes.md#node-command-line-flags),
  [Node config page](nodes.md#node-config-page),
  [keeping nodes up to date](operations.md#keeping-nodes-up-to-date),
  [keeping the Host up to date](operations.md#keeping-the-host-up-to-date), and
  [Dev Box MCP onboarding design (proposed)](../devbox-fleet-onboarding-design.md).
- **Create projects and start everyday sessions:**
  [workspaces and placements](getting-started.md#first-run-walkthrough),
  [Agency mode](mcp-and-agency.md#agency-mode),
  [Host-authenticated MCP forwarding](mcp-and-agency.md#host-authenticated-mcp-forwarding),
  [Exact proof of concept](getting-started.md#exact-proof-of-concept),
  [attachments and images](using-fleet.md#attaching-files-and-images),
  [downloading files from a session](using-fleet.md#downloading-files-from-a-session), and
  [slash commands and session pickers](using-fleet.md#slash-commands-and-session-pickers).
- **Continue a worker from its VM:** [shared Node chat and offline continuation](nodes.md#shared-worker-chat-and-offline-continuation),
  [feature and implementation guide](../node-session-console.md), and
  [live/reconnect sequence diagrams](../node-session-streaming.html).
- **Review consumption:** [AI credits and token usage](usage.md), including live session snapshots, machine/task/day filters, and shared Orchestrator usage.
- **Monitor and organize active work:**
  [rows that fold themselves away](using-fleet.md#rows-that-fold-themselves-away),
  [drag ordering and filing](using-fleet.md#ordering-and-filing-by-dragging), and
  [alerts, sounds, and notifications](using-fleet.md#alerts).
- **Coordinate multi-agent work:**
  [Orchestrator quick guide](orchestration.md#orchestrator-quick-guide),
  [approved remote commands](orchestration.md#approved-remote-commands),
  [Runs: several sessions toward one objective](orchestration.md#runs-several-sessions-toward-one-objective),
  [Chats as a destination](orchestration.md#chats-as-a-destination), and
  [local agents](orchestration.md#local-agents-handing-work-to-an-orchestrator-from-this-machine).
- **Recover, move, back up, or troubleshoot:**
  [Moving a Host or Node](operations.md#moving-a-host-or-a-node-to-another-machine),
  [recovering sessions](operations.md#recovering-sessions-after-a-restart),
  [automatic session retention](operations.md#automatic-session-retention),
  [Diagnostics](getting-started.md#diagnostics-and-troubleshooting), and
  [local verification](development.md#local-verification-and-test-monitoring).
