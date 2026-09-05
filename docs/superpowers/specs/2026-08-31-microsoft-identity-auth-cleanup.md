# Microsoft identity auth: why ~32k lines, what to cut

**Branch:** `feat/microsoft-identity-auth` vs `main`
**Scope:** committed + uncommitted (no code was changed for this review)
**Lens:** ponytail — keep current login working, delete ceremony, split what is not Microsoft sign-in
**Companion:** [2026-08-27 design](./2026-08-27-microsoft-identity-auth-design.md)

---

## Verdict

**The 32k is not necessary for “replace the operator password with Microsoft login.”**
It *is* a mostly-faithful implementation of the design, which bundled three products into one branch.

| What you asked for | What landed |
| --- | --- |
| Claim this Host with a console code + Microsoft account; later admins are Microsoft identities | That, **plus** a Node crypto rewrite, portable encrypted backup, device-code login, six auth states, migration UX, MCP principal hardening, and ~16.5k test lines |

You cannot review 32k as one PR. You also cannot delete 20k while keeping every current function. The honest split:

1. **Keep all current behavior** → cut ~1.5–2.5k of dead/duplicate/drive-by. The PR stays huge. Review by **splitting**, not shrinking.
2. **Keep Microsoft login working** (claim + PKCE + admin table + sessions) → **move ~12–15k out** of this PR and drop ~2.5k of optional device-flow surface. That is the reviewable path.

Default recommendation: **track 2**. Device flow, Node AEAD, and portable v2 all still work — just not in the same diff.

---

## Line census (including uncommitted)

```
32,698 insertions / 1,120 deletions / 147 files
```

| Bucket | Insertions | Share |
| --- | ---: | ---: |
| Tests (`*.test.*`) | 16,517 | 50% |
| Production | 13,960 | 43% |
| Docs (README, spec, ARCHITECTURE, `.env.example`) | 2,099 | 6% |
| lockfile | 122 | <1% |

Largest production files (insertions):

| File | +lines | Belongs to |
| --- | ---: | --- |
| `apps/host/src/store.ts` | 1,458 | A + B + C mixed |
| `apps/host/src/auth/service.ts` | 1,374 | A (and ~320 device) |
| `apps/host/ui/.../AuthGate.tsx` | 964 | A (12 gate views) |
| `apps/host/ui/.../SecurityPanel.tsx` | 919 | A + B + C UI |
| `packages/protocol/src/index.ts` | 850 | B frames + A DTOs |
| `apps/host/src/auth/entra.ts` | 831 | A (~280 device) |
| `apps/node/src/enrollment.ts` | 668 | B |
| `packages/protocol/src/node-auth.ts` | 643 | B |
| `apps/host/src/routes/auth.ts` | 547 | A |
| `apps/host/src/request-guard.ts` | 371 | A (+ node proofs) |

Largest test files: `node-socket.test.ts` (1093), `enrollment.test.ts` (1090), `request-guard.test.ts` (796), `node-auth.test.ts` (694), `node-enrollment.test.ts` (604). Those five are almost all **Node protocol**, not Microsoft login.

---

## Three features in one branch

The design’s execution plan (phases 1–8) is the root cause. The 2026-08-31 “product simplification” only removed the first-run Entra config screen. The code still implements the full original matrix.

```
A  Microsoft operator auth     claim code, PKCE, admin table, sessions, CSRF, AuthGate
B  Node mutual authentication  Ed25519 + X25519 + AEAD, enrollment grants, dual hello
C  Portable backup v2          scrypt+AES-GCM envelope, move Host identity
```

Login (A) does **not** need B or C. Coupling:

| Piece | Needed to sign in? |
| --- | --- |
| Administrators, opaque sessions, CSRF, claim code, PKCE | Yes |
| v1 data restore that **preserves** `auth.*` / CSRF / host identity | Yes — otherwise restore unclaims the Host |
| Enrollment grants, Host fingerprint, AEAD frames | No (legacy Node secret still works) |
| Portable v2 passphrase backup | No (single-machine login) |
| Device code flow | No (off by default; localhost PKCE is the product) |
| Versioned `/mcp` lead tokens | No (separate control plane) |

### Suggested PR split (review order)

| PR | Contents | Est. lines (prod+test) |
| --- | --- | ---: |
| **A** | Entra + claim + sessions + guard + AuthGate + admin invite + v1 preserve-security restore | 18–21k |
| **D** | `/mcp` principal + versioned lead tokens | 0.7–0.9k |
| **B** | Node keys, grants, dual gateway, Connect command, migration switch | 8.5–10k |
| **C** | Portable v2 export/import UI + envelope | 3.5–4.2k |
| **E** | Drive-bys (see below) | 0.5k |

A-only is still large because the tests are doing their job on a security feature. It is reviewable as “one product.” A+B+C is not.

---

## Track 1 — keep every current function (safe deletes)

Do these even if you ship the whole design. None of them change operator-visible behavior that actually works today.

### Dead production code

| Item | Where | Why it can go | Est. |
| --- | --- | ---: |
| `OperatorAuth.login` / `verify` / `revoke` / `issue` / signed-cookie key | `apps/host/src/auth.ts` | Production only calls `check()`. Sessions live in `auth/sessions.ts`. `login`/`verify`/`revoke` have **zero** production callers. | ~95 |
| `SESSION_MAX_AGE_MS`, `SESSION_KEY_SETTING` | `auth.ts` | Ten-year cookie constants from the old signed cookie. Unused. | ~10 |
| `newDeviceFlowId()` | `auth/entra.ts` | Exported, never imported. Host uses `randomBytes(24)` in `service.ts`. | ~3 |
| `enableRecoveryPassword()` | `auth/service.ts` | Documented as a “local console command.” **No CLI, no route, no `main.ts` call.** Only `service.test.ts`. Docs lie. Wire a CLI **or** delete. | ~25 + UI copy |
| `nodeKeyUpgradeTranscript()` | `packages/protocol/src/node-auth.ts` | **Never called.** Leftover from the in-band upgrade the design later rejected. | ~20 |
| `request_node_key` / `node_key` / `node_key_accepted` **behavior** | protocol + `apps/node/src/main.ts` + tests | Design says “keep frames so old peers don’t hang up.” Host **never sends** `request_node_key`. Node refuses it. Schema + comments describe a path that does not exist. Keep *ignore-unknown* if you must; delete the upgrade crypto, capability, and comments that still claim HMAC-on-secret works. | ~150–250 |
| `ClaimCodeService.status` / `codeFingerprint` / `bindingCount` | `auth/claim.ts` | Test/diagnostic only. | ~15 |

**Subtotal: ~300–400 production lines.** Small, but it stops reviewers from tracing ghosts.

### Drive-bys in the uncommitted pile (not Microsoft login)

| Change | Verdict |
| --- | --- |
| `apps/host/src/dev-proxy.ts` + `vite.config.ts` | Keep with A (Vite Origin vs exact-origin guard). Tiny and real. |
| `data-permissions.ts` rewrite | Split. Hardens the DB directory; not the login path. ~465 lines. |
| `TerminalView.tsx` responsive/a11y | Split. Unrelated polish. ~25 lines. |
| `TopBar.tsx` signed-in identity | Keep with A. |

### Test overlap (keep unique assertions)

Do **not** slash the suite because it is 50%. Security features should be test-heavy. Cut copies:

| Theme | Same invariant in | Cut if you keep all features |
| --- | --- | ---: |
| 127.0.0.1 → localhost | `auth-client.test.ts`, `AuthGate.test.tsx`, `auth-browser-ux.test.ts` | ~100 |
| Device enable/verify ≠ session | `device-flow.test.ts`, `device-flow-lifecycle.test.ts`, `auth-browser-ux.test.ts`, `SecurityPanel.test.tsx` | ~150 |
| Envelope replay/tamper | `node-auth.test.ts` **and** `node-socket.test.ts` **and** `request-guard.test.ts` | ~250 |
| AuthGate test harness (`show`/`host`/`statusBody`) copied 3× | `AuthGate.test.tsx`, `.migration.test.tsx`, `.invitation.test.tsx` | ~120 |
| Node keys in portable backup | `store.portable-backup.test.ts` vs `store.node-auth.test.ts` | ~80 |

**Subtotal: ~550–750 test lines** without losing a unique check.

Track 1 total: **~1.5–2.5k**. The remaining ~30k is real.

---

## Track 2 — keep Microsoft login working (the ponytail cut)

Default local product after 2026-08-31:

1. Start Host. Console prints claim code.
2. Open localhost. Paste code. Click **Sign in with Microsoft**.
3. That account is admin. Invite more Microsoft accounts from Security.
4. Password is upgrade-only.

Everything below is **off the happy path** and is what makes the diff unreadable.

### 1. Split Node mutual auth (B) to a follow-up PR

**~8.5–10k lines**, including the five biggest test files.

Leave legacy `hello` + enrollment token until B. Claim already blocks Node enroll before the Host is owned (`423`). That is the A invariant. The AEAD channel is a different product.

If B stays in this branch anyway: delete the abandoned upgrade transcript/frames first so reviewers are not reading a rejected design.

### 2. Split portable backup v2 (C); keep v1 preserve

**~3.5–4.2k** if moved.

Must stay with A: `replaceHostBackupRows` / `PRESERVED_SETTING_KEYS` so a catalog restore cannot wipe administrators. That is ~250–400 prod + tests, not 4k.

v2 is “move this Host to another machine.” Login does not need it.

### 3. Delete or quarantine device flow

Off by default. Localhost PKCE is the product. Tenant CA may block it anyway.

| Layer | Est. if removed |
| --- | ---: |
| `service.ts` device maps/start/poll/verify | ~320 |
| `entra.ts` MSAL device adapter | ~280 |
| `routes/auth.ts` `/device/*` | ~120 |
| UI: `DeviceCodePanel`, `device-login.ts`, `DeviceStep`, `DeviceFlowCard` | ~350 |
| Tests: `device-flow*.test.ts`, lifecycle, adapter, UX copies | ~350–450 |
| **Total** | **~1.5–2.5k** |

If you still want “remote tunnel URL login” later: keep the code, **move it to `auth/device.ts`** and stop threading it through `FleetAuth` and AuthGate. Reviewers of A should not have to read it.

### 4. Collapse AuthGate to the screens that actually run

`AuthGate.tsx` is ~1,013 lines and **12 views**. Default install with baked-in Entra hits maybe four.

| View | Default Microsoft-corporate install | Suggestion |
| --- | --- | --- |
| `checking`, `unreachable` | Yes | Keep |
| `claim` | Yes | Keep |
| `sign-in` | Yes | Keep |
| `denied` / `pending` | Yes (invites) | Keep |
| `configure` | No — tenant is preconfigured | Delete `EntraConfigForm` / `ConfigureStep`. BYO stays env-only (`FLEET_ENTRA_*`). |
| `local-forward` / `device` | No — localhost | Delete with device flow |
| `migrate` / `password-sign-in` | Upgrade Hosts only | One thin password form, or console-only |
| `endpoint-refused` | Public HTTP tunnel | Keep server-side; hide if you only ship localhost |

Also delete `TrustRail` (~100 lines). It is a diagram. Error copy already explains claim / denied / pending.

**AuthGate savings: ~350–450 lines** if configure + device + TrustRail go. Migration can stay as a stub.

### 5. Slim SecurityPanel to identity + admins

Eight cards. MVP is three.

| Card | Keep in A? |
| --- | --- |
| Signed-in identity | Yes. Hide tenant/client ID fields (env). |
| Pending candidates + administrators | Yes |
| Reauth banner for destructive actions | Yes |
| Password enable | Migration only — disable button is enough |
| Device sign-in verify | No (with §3) |
| Node mutual-auth migration | Move to B / Connect card |
| Portable backup | Move to C |
| Security audit table | Later. `recordSecurityAudit` can stay server-side |

**~200–320 UI lines** out of Security without losing invite/approve/remove.

### 6. Stop growing `FleetAuth` (1,374 lines)

`service.ts` is the orchestrator for claim, PKCE, device, password, invitations, audit, and scheme policy. That is why it is unreadable.

Do **not** merge `claim.ts` / `sessions.ts` / `state.ts` into it. Those files are already the right size. Do the opposite:

- Device → `auth/device.ts` (or delete)
- Password enable/disable/recovery → `auth/password.ts`
- Invitations already have store methods; routes can stay thin

`EntraProvider` → `MsalAdapter` → `MsalClient` is three layers for one SDK. Collapse to **one interface** + inject the MSAL client in tests (~40 lines, clearer).

### 7. `store.ts` (+1,458) is three features sharing a file

Review `store.ts` by grep, not by reading:

- A: `administrators`, `operator_sessions`, `administrator_invitations`, `security_audit`, session revoke
- A-min backup: `PRESERVED_SETTING_KEYS`, `replaceHostBackupRows`
- B: `public_key`, `auth_protocol`, `registerNodeWithKey`, `createEnrollmentGrant`
- C: `exportSecurityBackup`, `importPortableBackup`

No new abstractions needed. If you split PRs, the store diffs split with them.

---

## What not to “simplify”

These are load-bearing. Cutting them to shrink the diff would be the 3am page.

- Console claim code, hash-only storage, bootstrap grant, per-binding limits
- PKCE `state` / `nonce` / verifier; MSAL redemption (no hand-rolled JWT)
- Authorization by `(tid, oid)`, not email
- Opaque session + SHA-256 in SQLite; CSRF HMAC; idle/absolute expiry
- Immediate session + socket revoke on admin removal
- Last-admin cannot be removed
- Invitation → pending candidate → existing admin approves (leaked link)
- External scheme map (do not trust `x-forwarded-proto` / source IP)
- Principal-aware guard (method + regex), not a string `OPEN_PATHS` list
- v1 restore preserving the security envelope

Invitation two-step looks like ceremony. It is the Graph-less add-admin design. Keep it.

---

## How to review the remaining A PR without reading 32k

Read in this order. Stop when the invariant is obvious.

1. Design §Preferred architecture + §Safe first claim + §Authorization invariants (not the whole 1,400-line spec).
2. `auth/state.ts` — which states default install actually enters (`unclaimed` → `microsoft-only`).
3. `auth/claim.ts` → `POST /api/auth/bootstrap` in `routes/auth.ts`.
4. `auth/entra.ts` PKCE half only (skip device).
5. `FleetAuth.authorize` / `claimFirstAdministrator`.
6. `auth/sessions.ts` + CSRF in `request-guard.ts`.
7. `AuthGate` `viewFor` + `ClaimStep` / `SignInStep` only.
8. `routes/administrators.test.ts` — invite / approve / remove / last-admin.

Skip on first pass: `node-auth.ts`, `node-channel.ts`, `node-socket.ts`, `enrollment.ts`, `portable-backup.ts`, `security-backup.ts`, `DeviceCodePanel`, `TrustRail`, protocol `request_node_key` comments.

---

## Suggested cleanup order (when you *do* edit)

1. Split B and C to follow-up branches (or label them clearly in the PR description as “not login”).
2. Delete dead `OperatorAuth` cookie path, unused exports, unwired recovery, unused `nodeKeyUpgradeTranscript`.
3. Delete or isolate device flow.
4. Delete `configure` UI + `TrustRail`; hide tenant fields.
5. Dedup tests after the production surface shrinks (otherwise you fight fixtures twice).
6. Peel `data-permissions` / `TerminalView` into their own commits.

Do not start by “merging files to make fewer files.” The auth folder split is already the lazy structure. `service.ts` is the file that got greedy.

---

## After cleanup (expected shape)

| If you… | Diff vs main |
| --- | --- |
| Do nothing | ~32.7k / 147 files |
| Track 1 only (dead + drive-by + test dup) | ~30–31k — still unreviewable as one PR |
| Split B+C+D, keep A + v1 preserve | **~18–21k**, mostly tests, one product |
| Split B+C+D **and** drop device + configure + TrustRail | **~15–18k** and AuthGate becomes a claim/sign-in page |

15–18k with half tests is a normal size for “first-claim Microsoft admin + sessions + CSRF + invitations” on a Host that previously had a shared password. 32k is that plus two other security products.

---

## Open product questions (defaults, not stalls)

If you want the full design (device flow, Node AEAD, portable move, audit tab): say so and keep the code — **still split the PRs**.

If this is the local VM manager from 2026-08-31: device flow, first-run Entra form, TrustRail, in-band Node key upgrade leftovers, and portable v2 do not need to be in the Microsoft-login review.
