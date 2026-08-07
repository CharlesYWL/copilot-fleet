# Settings page + Cloudflare Tunnel

**Date:** 2026-08-07  
**Status:** Approved — implementing  
**Scope:** Host UI Settings shell; managed Cloudflare quick tunnel; fold Nodes/Workspaces into Settings.

## Goal

Operators manage remote access and inventory from one place:

1. Toggle a Cloudflare quick tunnel on/off from the UI (Host spawns `cloudflared`).
2. Collapse Workspaces and Nodes under a Settings view so the sidebar stays session-focused.

## Non-goals

- Named Cloudflare tunnels / fixed custom domains (future).
- Other providers (ngrok, etc.) — no provider dropdown in v1.
- Pushing updated `FLEET_HOST_URL` onto already-enrolled remote machines.
- Changing enrollment auth or session runtime.

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Tunnel management | Host embeds a tunnel manager (spawn `cloudflared`) |
| Providers in v1 | Cloudflare quick tunnel only |
| Sidebar | Sessions + Settings only |
| Settings IA | Tabs: Tunnel (default) / Nodes / Workspaces |
| Restart behavior | Persist `enabled`; Host auto-starts tunnel when enabled |
| URL persistence | Do **not** persist URL (quick tunnels rotate) |

## Navigation

### Sidebar

- Keep the session tree and “New session”.
- Remove footer buttons for Workspaces and Nodes.
- Add a single **Settings** footer button.

### Settings view

Fluent UI `TabList` with three tabs:

1. **Tunnel** — switch, status, URL, install hint, URL-change warning.
2. **Nodes** — existing `NodesPanel` + `ConnectNodeCard` (unchanged behavior).
3. **Workspaces** — existing `WorkspacesPanel` (unchanged behavior).

`SidebarView` becomes `"session" | "settings"`. Optional query/hash for deep-linking tabs is out of scope; default tab is Tunnel.

## Tunnel lifecycle

```
off ──enable──► starting ──url parsed──► on
                  │                      │
                  └──── error ◄──────────┘ (process exit / missing binary)
on ──disable──► stopping ──► off
```

| Status | Meaning |
|--------|---------|
| `off` | No child process. Public URL falls back to `FLEET_PUBLIC_URL` env or LAN/loopback resolver. |
| `starting` | `cloudflared` spawned; waiting for trycloudflare URL in stdout/stderr. |
| `on` | Process healthy; runtime `publicUrl` is the tunnel URL. |
| `stopping` | SIGTERM (Windows: terminate) in progress. |
| `error` | Failed to start, binary missing, or unexpected exit. Switch shows off; `error` message set. |

### Process

Spawn (PATH lookup for `cloudflared` / `cloudflared.exe`):

```text
cloudflared tunnel --url http://127.0.0.1:<PORT> --no-autoupdate
```

- `<PORT>` is the Host listen port (`process.env.PORT` / default `8787`).
- Always target loopback: tunnel forwards to the local Host, not `0.0.0.0`.
- Parse first match of `https://[a-z0-9-]+\.trycloudflare\.com` from combined stdout/stderr.
- On Host shutdown: stop tunnel child before exit.
- On unexpected child exit while `enabled`: transition to `error`, keep `enabled=true` so operator can retry (toggle off/on or explicit retry). Prefer: set `enabled=false` on crash to avoid restart loops — **decision: on crash → `error` + `enabled=false` persisted**, UI shows error + switch off. Auto-restart only applies to clean Host process boot when persisted enabled was true.

### Persistence

Store a single boolean in the Host SQLite DB (new key/value table or `settings` table):

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- key 'tunnel.enabled' → '0' | '1'
```

- Do not persist the tunnel URL.
- On Host boot: if `tunnel.enabled=1`, begin `starting` after the HTTP server is listening.

### Public URL resolution

Priority when serving `/api/enrollment` and Connect commands:

1. If tunnel status is `on` → runtime tunnel URL.
2. Else `FLEET_PUBLIC_URL` env (if set).
3. Else existing `resolvePublicHostUrl(HOST, PORT)` behavior.

## API

### `GET /api/tunnel`

```json
{
  "provider": "cloudflare",
  "enabled": false,
  "status": "off",
  "publicUrl": "http://192.168.x.x:8787",
  "error": null,
  "binaryPresent": true
}
```

`publicUrl` is whatever enrollment would currently advertise (including fallbacks).

### `POST /api/tunnel`

Body:

```json
{ "enabled": true }
```

- `enabled: true` while already starting/on → idempotent success.
- `enabled: false` while off → idempotent success.
- Missing binary on enable → `409` or `503` with `{ error: "..." }`, status `error`, enabled stays false.
- Zod: `UpdateTunnelSchema = z.object({ enabled: z.boolean() })`.

### Browser updates

v1: Tunnel tab polls `GET /api/tunnel` every ~2s while the Settings→Tunnel tab is visible (and once on mount). No new WebSocket message type required.

## UI — Tunnel tab

- Title: “Cloudflare Tunnel”.
- Switch bound to desired enabled state; disable switch while `starting` / `stopping`.
- Status line: Off / Starting… / Online / Error.
- When `on`: monospace URL + Copy button.
- When `binaryPresent === false`: MessageBar — install cloudflared; switch disabled.
- Persistent MessageBar when online: quick tunnel URLs change each start; remote nodes must update `FLEET_HOST_URL` and restart.
- Optional “Retry” button when `status === error`.

Connect card on Nodes tab continues to call `/api/enrollment` (picks up live tunnel URL).

## Code layout (indicative)

| Area | Change |
|------|--------|
| `apps/host/src/tunnel.ts` (new) | Spawn/parse/stop; status getters |
| `apps/host/src/store.ts` | `getSetting` / `setSetting` |
| `apps/host/src/server.ts` | Wire routes; boot auto-start; shutdown hook; enrollment uses tunnel URL |
| `packages/protocol` | `TunnelStatusSchema`, `UpdateTunnelSchema` |
| `apps/host/ui/.../SettingsPanel.tsx` (new) | Tabs shell |
| `apps/host/ui/.../TunnelPanel.tsx` (new) | Switch + status |
| `Sidebar.tsx` / `App.tsx` | View = settings; remove workspaces/nodes nav |

## Testing

- Unit: URL regex extraction from sample cloudflared log lines.
- Unit: settings get/set; enrollment URL priority (tunnel > env > fallback).
- Unit: `UpdateTunnelSchema`.
- Manual: toggle on → URL appears → enrollment command updates; toggle off → fallback; kill binary path → error state; restart Host with enabled=1 → auto starting.

## Risks

| Risk | Mitigation |
|------|------------|
| `cloudflared` not installed | Detect binary; clear UI error; no crash |
| Quick tunnel URL rotates | Warning copy; Connect card always shows current URL |
| Orphaned cloudflared after Host crash | Document; optional later: pid file cleanup on boot |
| Windows spawn differences | `shell: true` or `.exe` PATH; terminate via `taskkill` / `child.kill()` |

## Spec self-review

- No placeholders for provider list (explicitly Cloudflare-only).
- Crash vs reboot behavior specified (`enabled` cleared on crash; restored only from persisted true on Host boot).
- Enrollment URL priority ordered.
- Out of scope items listed under Non-goals.
