# Import / export Host and Node identity

**Date:** 2026-08-14  
**Status:** Implemented
**Scope:** Move a Host (catalog, sessions, transcripts, settings) or a Node (identity + local settings) between machines. Replace-on-import. Transfer a tunnel only when the Host address is stable.

## Goal

An operator can take a fleet from one machine to another without re-creating workspaces, placements, sessions, or node identities by hand.

Two archives, two places:

1. **Host** — Settings → General: export/import a JSON file that replaces this Host’s SQLite state.
2. **Node** — local config page (`http://127.0.0.1:8788`): export/import that machine’s `node.json` + `settings.json`.

## Non-goals

- Merging two fleets.
- Copying Copilot’s on-disk ACP sessions, git checkouts, or provider login files (`~/.cloudflared`, ngrok config, Tailscale state).
- Live process migration. Agents stay on the machine that started them.
- A combined “whole fleet” file that collects every node secret onto the Host.

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Surfaces | Separate Host and Node actions |
| Import | Replace destination state after confirm |
| Format | Versioned JSON (`kind` + `version: 1`) |
| Host secrets | Archive includes enrollment token and node **secret hashes** (not plaintext) |
| Node secrets | Archive includes `node.json` plaintext secret (loopback config page only) |
| Tunnel URL | Restore only if dialable **and** not a rotating provider hostname |
| Tunnel switch | Restore provider + enabled; new Host starts a tunnel on boot when enabled |
| Live sessions on Host import | Non-terminal sessions land `offline` (“Imported onto this Host”) |
| Live agents on Node import | Stop local agents, write identity, reconnect |

## What transfers

### Host archive (`kind: "copilot-fleet-host"`)

- Nodes (ids, names, secret hashes, capacity, platform, order-independent)
- Workspaces, placements, sidebar positions
- Sessions (including names, YOLO, agent session ids, slash/config snapshots) and the full event log
- Defaults (YOLO, auto-resume)
- Enrollment token
- Tunnel provider + enabled
- `publicUrl` only when it is transferable (see below)

After import, nodes are offline. Existing nodes reconnect with the secrets they already have; hashes in the archive must match.

### Node archive (`kind: "copilot-fleet-node"`)

- Credentials: `hostUrl`, `nodeId`, `secret`, `name`
- Settings: host URL, name, capacity, Copilot command, permission timeout, context tier, known host URLs

Does not include workspace files or Copilot session directories. Resume still needs Copilot’s files on **that** machine (or the same node disk). Placement paths are whatever the Host already stored for this node id — update them on the new box if the checkout moved.

## Transferable Host URL

A URL is copied into the Host archive (and restored to `settings.host.publicUrl`) when:

- another machine can dial it (`isDialableHostUrl`), and
- it is not a rotating tunnel hostname: `*.trycloudflare.com`, `*.ngrok-free.app`, `*.ngrok.io`, `bore.pub`

`FLEET_PUBLIC_URL` in the environment still wins over a restored setting, so a new machine can override. Loopback is never stored.

Named / reserved domains, Tailscale `*.ts.net`, and LAN addresses transfer. Quick tunnels do not: the new Host may still start a tunnel (enabled + provider restored) and will get a **new** URL; nodes keep dialing the old one until retargeted.

## Import behaviour

### Host

1. Close every node socket (no mixed writes into the new catalog).
2. In one transaction: delete events, sessions, placements, workspaces, nodes, settings; insert the archive; rewrite live session states to `offline`.
3. Persist enrollment token in `settings` (`enrollment.token`) and in the running process.
4. Persist transferable `host.publicUrl` when present.
5. Apply tunnel provider/enabled.
6. Broadcast a fresh snapshot. The Settings UI reloads the page.

Wrong `kind` (a node file dropped on the Host) is a 400 that names the node config page.

### Node

1. Stop local agents.
2. Replace `node.json` and `settings.json`.
3. Reconnect with the imported identity.

Wrong `kind` is a 400 that names Settings → General.

Export of a node that has not enrolled yet is 409.

## Security

The Host has no operator auth today; export is as sensitive as `GET /api/enrollment` already is. The Node config listener stays loopback-only. UI copy must say the file contains secrets.

## API

- Host: `GET /api/backup`, `POST /api/backup` (JSON body, 50 MiB limit)
- Node: `GET /api/backup`, `POST /api/backup` on the config server

## Testing

- Protocol: schema accept/reject; rotating vs transferable URLs; live session → offline
- Store: round-trip including `authenticateNode` with the original secret; positions; event log
- Host routes: export/import; reject node archive; enrollment token visible after import
- Node config router: export/import; reject host archive; refuse export before credentials exist
