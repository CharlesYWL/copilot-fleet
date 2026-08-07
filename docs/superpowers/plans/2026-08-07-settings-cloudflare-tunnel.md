# Settings + Cloudflare Tunnel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Settings shell (Tunnel / Nodes / Workspaces) + Host-managed Cloudflare quick tunnel with persisted enable flag.

**Architecture:** `TunnelManager` spawns `cloudflared`, parses trycloudflare URL, exposes status to `/api/tunnel`. SQLite `settings` stores `tunnel.enabled`. Enrollment public URL prefers live tunnel URL.

**Tech Stack:** Fastify, SQLite (`node:sqlite`), Fluent UI v9 Tabs/Switch, Vitest.

## Tasks

1. Protocol: `TunnelStatusSchema`, `UpdateTunnelSchema`
2. Store: `settings` table + get/set; tests
3. `tunnel.ts`: binary check, URL parse, spawn/stop; unit tests for parse
4. Server: GET/POST `/api/tunnel`, enrollment URL priority, boot auto-start, shutdown stop
5. UI: `TunnelPanel`, `SettingsPanel`, Sidebar/App wiring
6. Typecheck + tests + manual smoke
