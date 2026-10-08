# Local agent API: delegate to existing Fleet orchestrators

Status: implemented — REST `/v1` and a stateless MCP endpoint on the same
loopback listener, off by default. The design below is kept as written; where
the implementation departs from it, the [implementation record](#implementation-record)
says how and why, and that record wins.
Owner request: let a local assistant such as Hermes create work in CF and ask
follow-up questions about existing tasks, without Microsoft sign-in.
Baseline inspected: `48e166af707b12ba0fe842fa89b64c06c4703d45`.

This document uses **task** for the UI concept stored as a `Run`, and
**orchestrator** for a Fleet `Session` with `runRole: "lead"`. They are not
interchangeable. All API names, configuration names and DTOs below are proposals.
Source citations refer to the baseline revision; recheck them before implementation.

## Goal

A local assistant can:

1. Discover explicitly exposed, existing orchestrators and their tasks.
2. Create a real task on one chosen orchestrator and receive its stable ID.
3. Ask about an old task, including completed work, or give an open task more
   instructions through its existing orchestrator.
4. Read bounded task facts, conversation output and delivery receipts without
   repeatedly prompting the agent or renewing session retention.

The caller does not need a browser cookie, Microsoft identity, a lead token, or
access to another Hermes profile. CF remains responsible for scheduling and
execution. An HTTP success means durable acceptance, not that the model read the
message, a worker started, or the task succeeded.

### Non-goals

- No new orchestrator creation, direct worker prompt/start, arbitrary shell,
  arbitrary file read/download/upload, or generic proxy/RPC endpoint.
- No stop/resume/transfer/archive/delete, model/profile changes, permission
  approvals, maintenance authorization or human review decisions through this API.
- No second scheduler, second Host process, second store, or alternate ACP client.
- No Hermes profile provisioning, credential copying, concurrent attachment to a
  native session, or changes to any user's Hermes installation/configuration.
- No unauthenticated access to existing `/api/*`, `/ws/*`, or lead `/mcp`.
- No SSE in the first release. REST plus polling supplies the complete initial
  workflow. *(Implemented: the owner asked for MCP as well, so a thin stateless
  MCP adapter over the same service ships at `/v1/mcp`, with no new domain
  semantics.)*
- No claim of a sandbox, process identity, exactly-once model effects, or a
  read-only model merely because a request is labeled as a question.

## Decisions

These are the recommended implementation defaults, not a claim of prior owner
approval of each detail.

- **D1 — Honor the requested unauthenticated mode, opt-in only.** No secret/token
  is required on the local API. The main Host keeps its current authentication.
  Enabling must explicitly acknowledge that every process able to reach the
  socket can use the exposed authority, potentially including other local users.
- **D2 — One separate listener, not several ports.** Bind a new Fastify instance
  to literal `127.0.0.1`, default port `8786` (not the originally proposed `8788`,
  which is a Node's own config page), sharing existing application services.
  The port is independently configurable; the bind address is not.
  Do not assume that port is free. No IPv6 listener in v1.
- **D3 — Explicit exposure.** An administrator selects lead IDs and task-workspace
  IDs; both lists initially empty, no wildcard. New leads/workspaces never become
  exposed implicitly. These constrain API targeting and disclosure, not the
  underlying lead's wider tool or shell authority.
- **D4 — REST first.** Version the local surface under `/v1`. Expose typed task
  creation, task messages and bounded reads. Do not register `FleetTools` or mint
  an orchestrator token for the external caller.
- **D5 — Preserve identity.** Requests name stable Fleet IDs, never native session
  IDs, command lines, cwd, backend, profile or model overrides. The existing
  orchestrator retains its Node, actual `agentParams` and native conversation.
- **D6 — Real tasks, not optimistic chat.** Create through extracted task-creation
  semantics and persist ownership plus the owed initial brief atomically. Return
  the actual task ID even if subsequent worktree preparation is blocked.
- **D7 — Questions and instructions are different intents.** A question may refer
  to a retained closed/awaiting-human task without reopening it. Guidance is for
  eligible open tasks only. Neither is a human approval. No implicit resume of a
  stopped orchestrator; the operator uses existing CF controls.
- **D8 — Durable-capable peers only for writes.** Require the selected lead's live
  sealed Node connection to advertise `durable-lead-delivery-v1`. Busy leads may
  accept queued requests. Offline/legacy/stopping/cleanup leads do not. Never
  silently downgrade to legacy prompt delivery.
- **D9 — Durable idempotency and truthful receipts.** Every write requires a UUID
  operation ID. Persist payload comparison and receipt linkage; identical retries
  replay, conflicting reuse fails. Unknown delivery stays unknown and is never
  retried with a fresh delivery identity automatically.
- **D10 — No impersonation.** `local-agent` is a source category, not an authenticated
  person. Never populate `fleetHumanActor`, `fleetSession`, administrator identity,
  Node identity or lead claims for it. Optional client labels are unverified.
- **D11 — Scope transfer races explicitly.** Pin the task's expected owner at
  acceptance. Block ownership transfer while a task-bound local delivery remains
  unresolved; do not implement transparent message migration in v1.
- **D12 — Preserve existing approvals, do not overstate them.** Existing human-only
  CF gates remain inaccessible. Leads already run YOLO and possess shell/tool
  authority: a local instruction can still cause substantial work without a new
  approval. This API does not create a new hard execution sandbox.
- **D13 — Host-local consent.** Configuration is managed only on the primary
  authenticated Security UI/API. Require a Microsoft administrator and recent
  authorization-code reauthentication for enablement or scope/port changes.
  Disable requires an administrator with CSRF. *(Implemented differently for a
  Host running without Microsoft sign-in: there, the operator on loopback or a
  private Dev Tunnel manages it, exactly as it already manages Nodes — see the
  implementation record.)*
- **D14 — Safe lifecycle.** Optional-listener failure leaves the main Host running
  and surfaces a visible error. Disabling closes admission, not already accepted
  work. Restore/auth-reset closes this listener and clears enablement/exposure;
  an operator must opt in again. No environment-variable enablement in v1.

## Implementation record

What shipped, how to use it, and every place the implementation departs from
the design that follows. Where this section and the design disagree, this
section describes the code.

### Using it

1. In the primary UI, open **Settings → Security → Local agent API**. Tick the
   orchestrators and workspaces to expose (nothing is pre-selected), keep or
   change the port (default `8786`), choose **Turn on…** and accept the warning.
   With Microsoft sign-in on, any change that leaves it on needs a sign-in from
   the last few minutes; turning it off or abandoning a request needs only an
   administrator. On a Host running without sign-in, the operator on loopback or
   a private Dev Tunnel manages it.
2. Call `http://127.0.0.1:<port>` — literally that address, because the `Host`
   header must be exactly `127.0.0.1:<port>` (`localhost` is refused). Every
   request carries `x-fleet-local-agent: 1`, which is protocol syntax, not a
   secret. POST bodies are `application/json`. `Origin`, `Cookie`,
   `Authorization`, `Forwarded`, `X-Forwarded-*`, `Via`, `Upgrade`,
   `Sec-Fetch-Site`/`-Dest`/`-User` and `X-CSRF-Token` are refused, so a browser
   page cannot drive it.

   ```bash
   curl -H "x-fleet-local-agent: 1" http://127.0.0.1:8786/v1/orchestrators
   ```

3. REST routes are exactly the table in section 3. Writes take a fresh UUID
   `operationId`; retry with the same one after a lost response and the original
   receipt is replayed (`replayed: true`).
4. MCP: Streamable HTTP, stateless, `POST /v1/mcp` (a GET answers 405). Tools:
   `list_orchestrators`, `list_workspaces`, `list_tasks`, `get_task`,
   `read_transcript`, `get_request`, `create_task`, `send_task_message` — the
   same service as REST, with tool errors returned as `isError` results carrying
   the REST error body. The settings card copies this client configuration once
   the API is on:

   ```json
   {
     "mcpServers": {
       "copilot-fleet": {
         "type": "http",
         "url": "http://127.0.0.1:8786/v1/mcp",
         "headers": { "x-fleet-local-agent": "1" }
       }
     }
   }
   ```

5. Replies are asynchronous: poll `GET /v1/requests/:operationId` (or
   `get_request`) and the task, and read the orchestrator's answer from its
   transcript. Receipt states are `waiting_for_brief`, `pending`,
   `rejected_busy`, `reserved`, `accepted`, `settled`, `uncertain`, `rejected`,
   `orphaned` and `abandoned`; errors carry a stable `code` from
   `localAgentErrorCodes` in `packages/protocol/src/local-agent.ts`.

### Where the implementation departs from the design, and why

- **Port 8786, not 8788.** `8788` is where a Node's config page listens (and it
  walks upward when busy), and a Node usually runs beside the Host.
- **MCP shipped now** (design: P4), because the owner asked for "public API/MCP".
  It is a thin stateless adapter: no sessions, no SSE, no FleetTools, no new
  semantics. It sits behind the same transport admission as REST.
- **No-auth Hosts can use it.** The design required a Microsoft administrator,
  which a Host running without sign-in can never have, so the feature would have
  been dead there. In no-auth mode the operator on loopback or a private Dev
  Tunnel — who can already drive every orchestrator through the main port —
  manages it, mirroring `requireNodeOperator`. Audits record
  `actorKind: "operator"`. With sign-in on, the D13 split holds: any change that
  leaves the API on (enabling, re-scoping, a new port) needs a recent
  authorization-code sign-in; disabling and abandoning
  need an administrator and CSRF, not a fresh sign-in, so withdrawing consent is
  never harder than granting it.
- **`Sec-Fetch-Mode` is tolerated** (see section 1). Every other browser marker
  is still refused.
- **`method_not_allowed` (405)** joins the error codes, for unsupported methods
  and the stateless MCP GET.
- **The ledger is host-local and stays out of backups** (design: backed up and
  merged). A receipt names delivery records and runs on this Host; importing it
  elsewhere could re-send a person's words to an agent they never meant them for.
  A restore keeps the destination ledger and uses it as proof: a restored run
  whose owed brief this Host already delivered or abandoned has exactly those
  bytes removed (`local_agent_brief_retired` audit), so the brief is not sent
  twice. Restore and auth reset also turn the API off and clear its exposure.
  The fresh-destination limit stays: a Host that never saw an operation cannot
  deduplicate it.
- **The ledger stores digests, not text.** It keeps the payload digest and, for
  a creation brief, the brief's digest and length. There is no payload text to
  redact after 30 days, so there is no tombstone pass; the 100,000-row cap still
  refuses new work with `receipt_storage_full` and never evicts.
- **Brief provenance is digest plus prefix length,** not a generation counter. A
  local brief always heads `Run.pendingPrompt`; operator text appended later
  sits after it. Delivery links the brief only while the queued text still
  begins with those exact bytes, and abandoning removes only that prefix, so
  appended operator text stays owed.
- **Exact-ID briefs.** Task briefs now carry `id="…"` in `<fleet-task>`, and the
  wake parser accepts it, so a lead adopts the exact task even when names repeat.
- **Local messages use their own envelope,** `<fleet-local-agent-request>`,
  rendered in the transcript as "Local agent question/guidance". The lead
  briefing explains it: quoted text is data, questions do not reopen or change
  the task, guidance acts only within what the task already permits, and none of
  it stands in for a person.
- **Delivery reuses the lead's stored execution binding** and the existing
  durable queue; nothing sends ACP or Node commands directly.
- **Queue-boundary holds** (`LocalAgentStore.admits`): an abandoned request is
  never handed out; guidance waits while its task is closed, awaiting a person,
  or no longer owned by the orchestrator it named; and a question or guidance
  waits while the task's own brief or update is still owed or queued, so it
  cannot reach the lead before the brief that says the task exists. No strict
  FIFO is claimed.
- **`rejected_busy` counts as handed out** for abandonment: the Node may have
  journaled it, so only a never-reserved `pending` or proven-unsent `orphaned`
  message is withdrawn; anything else becomes `abandoned_unknown`.
- **`quiescence_required`** means the owning orchestrator is not in a terminal
  state. Stop it, or wait for the delivery to settle, before writing off a
  request that may already be acting.
- **A lead without a live durable-delivery connection** returns 503
  `lead_unavailable`; one that needs a resume returns `lead_requires_resume`. The
  PR-maintenance task fence surfaces as `command_task_fenced`.
- **Ownership transfer** refuses with `task_message_pending` while a task has an
  unresolved local request, on every transfer path (REST single and bulk, MCP).
- **Branch naming** for local tasks uses the existing nonhuman fallback; no
  administrator's username is borrowed.
- **Transcript reads** may build the lead's transcript projection if it is not
  yet cached; they never touch session activity or retention.
- **Stale saved IDs** (a dismissed lead, a deleted workspace) are kept in the
  saved config, grant nothing, and show as "Stale" in the card, so the
  administrator sees and removes them. Validation applies only to IDs being
  newly added. The settings view lists the selectable `choices`.
- **Tunnel guard.** The listener writes a marker beside `tunnel.json`; Fleet's
  detached tunnel process refuses a target that matches the local API port.
- **Lifecycle.** The listener is inert until the main Host is listening
  (in-memory `buildServer()` fixtures never open it); reads are capped at 16 in
  flight; disable closes admission, then drains for five seconds.

### Files

- `packages/protocol/src/local-agent.ts` — DTOs, limits, states, error codes.
- `apps/host/src/local-agent-server.ts` — listener, admission, REST and MCP.
- `apps/host/src/local-agent-service.ts` — scope, reads, writes, recovery,
  config.
- `apps/host/src/local-agent-store.ts` — the request ledger and queue holds.
- `apps/host/src/local-agent-marker.ts` — the tunnel-guard marker.
- `apps/host/src/routes/local-agent-settings.ts` — primary-UI config, requests
  and disposition routes.
- `apps/host/src/orchestrator/task-application.ts` — task creation shared by the
  browser route and the local API.
- `apps/host/ui/src/components/LocalAgentCard.tsx` — the Security settings card.

## Current state

### Repository-wide ownership map

Inspection covered the tracked repository layout, architecture/lifecycle/backend
plans, and the Host, Node, protocol, UI and launch/test paths below. This is an
architecture-wide review with detailed reads of the affected paths, not a claim
that every source/test line or generated/dependency file was read. Source wins
where historical documentation disagrees with current implementation.

| Area | Existing responsibility and relevant coupling |
| --- | --- |
| `apps/host/src/server.ts:~148-196,264-269,444-552,596-618` | One store, service, engine and tunnel supervisor; primary Fastify lifecycle. A second `buildServer()` would reset connectivity and duplicate ownership, not just open another port. |
| `apps/host/src/request-guard.ts:~325-539`; `auth/guard-rules.ts:~34-85` | Main API/socket protection, name/origin checks, principal classification, CSRF. Unmatched ordinary non-API paths are not automatically protected. Do not add a bypass here. |
| `apps/host/src/routes/orchestrators.ts:~471-589,736-843` | Lead discovery/creation and task creation on an existing lead. A lead owns many tasks; new lead sessions need not have `runId`. |
| `apps/host/src/routes/runs.ts:~63-81,151-155,265-302` | Task/step/note reads and reopen semantics. Detail GET omits notes; the new projection must include them. |
| `apps/host/src/orchestrator/tools.ts:~2528-2661,2726-2974` | Owned task context and existing-worker continuation. `fleet_follow_up` takes a worker session ID and queues a tracked step attempt, not a message to a task's lead. |
| `apps/host/src/orchestrator/schedule.ts:~830-869`; `engine.ts:~712-796` | Persisted owed briefs and wakes, idle-lead handoff, capability-dependent durable queue. Reuse rather than add a dispatcher loop. |
| `apps/host/src/command-execution-service.ts:~1461-1482,1524-1622`; `command-execution-store.ts:~1204-1302` | Durable lead queue, reservations and Node receipt correlation. Reused by task wakes, command completions and human prompts. |
| `apps/host/src/orchestrator/lifecycle.ts:~298-440` | Shared REST/MCP task transfer, maintenance ownership and pending wake migration. The local-message ownership guard belongs here. |
| `apps/host/src/managed-worktree-service.ts`; `session-retention.ts`; `pr-maintenance-store.ts` | Checkout preparation, mutation/cleanup admission, retention and human direction gates. Local adapters must not lose checks currently applied by primary-route hooks. |
| `packages/protocol/src/index.ts:~175-185,462-544,606-688`; `command-execution.ts:~419-458` | Typed actual backend identity, sessions, transcript paging/revisions and durable prompt receipts. Add local DTOs separately and keep existing wire fields backward compatible. |
| `apps/node/src/router.ts:~325-498,714-779,933-990,1543-1613` | Busy admission, durable delivery, exclusive profile slots, resume and same-conversation MCP recovery. No new direct entry point here. |
| `apps/node/src/agents.ts:~717-768,881-947,1133-1176`; `agent-kinds/hermes.ts:~55-118` | ACP new/load/prompt/settlement; `hermes -p <saved-profile> acp`; missing native history fails rather than silently creating a new conversation; YOLO permission mapping. |
| `apps/node/src/lead-prompt-delivery.ts:~15-27,48-65,125-201` | Node journal persists admission before ACP side effect, checks payload digest and changes interrupted accepted turns to uncertain. |
| `apps/host/ui/src/hooks/useFleet.ts:~405-435,555-710,866-944,1026-1063` | Existing snapshot/task/transcript rendering and primary-origin authenticated writes. Local API integration must not make the browser call the new port. |
| `apps/host/ui/src/components/orchestration/ConversationTasks.tsx`, `OrchestratorPage.tsx` | Existing task creation/detail and conversation UI, worker links and human lifecycle actions. Keep these as the operator experience. |
| `apps/host/src/tunnel-process.ts:~14-18`; `external-tunnel.ts:~9-16,41-64`; `apps/host/vite.config.ts:~31-45` | Detached tunnel target can be configured separately; external tunnel metadata does not prove its target. Keep local port out of managed tunnels, Vite proxy, enrollment and MCP URL discovery. |
| `scripts/launcher.mjs`, `scripts/login-service*.mjs`, `apps/node/supervisor.mjs`, `package.json:~21-38` | Existing deployment/process ownership and validation scripts. No new daemon/service or live restart is needed to implement/test this feature. |

### Gaps that must not be wrapped and renamed as a working API

1. **Task-creation crash gap:** `orchestrators.ts:~803-826` creates a Run and
   idempotency record in one transaction; `~827-838` separately assigns the lead,
   running state and owed brief. Replay can return an unowned task after a crash.
   Close this gap in the shared service, after a behavior-preserving extraction.
2. **Generic prompt is insufficient:** `fleet-service.ts:~1257-1294` requires idle;
   `~1421-1435` can enqueue lead prompts, but creates a fresh queue key. Ordinary
   lead prompt `operationId` is not a complete external idempotency contract.
3. **Queue dedup is not request validation:**
   `command-execution-store.ts:~1243-1249` returns a matching logical key without
   comparing payload. A local receipt ledger must compare canonical content.
4. **Legacy handoff is weaker:** `engine.ts:~736-755` clears owed text before
   legacy dispatch. A persisted brief alone does not prove durable Node admission.
5. **Uncertainty differs across layers:** Host `reserved()` includes uncertain
   (`command-execution-store.ts:~1232-1235`); Node only accepted reserves the native
   conversation (`lead-prompt-delivery.ts:~15-27,125-131`). Do not claim timeout or
   reconnect automatically releases a Host reservation. Preserve conservative
   behavior in this feature; a wider recovery redesign is separate work.
6. **Transfer recognizes only its own keys:** `lifecycle.ts:~361-405` migrates
   pending/rejected-busy `run-prompt`/`run-wake` messages, not arbitrary local keys.
7. **Existing polling can change retention:** `routes/sessions.ts:~137-162` touches
   activity on full-event/latest-transcript reads. Add non-touching projections;
   do not automate those HTTP routes for background polling.
8. **Lead read-only is not protection:** `orchestrators.ts:~565-583` explicitly uses
   `yolo: true` and explains that `readOnly` is capacity accounting, not a sandbox.

## Design

### 1. Composition and trust boundary

```text
Local Hermes (any profile) / another native client
    | unauthenticated HTTP, strict local protocol, explicit stable IDs
    v
127.0.0.1:8786 — separate LocalAgentListener
    | allowlisted routes + strict DTOs + bounded projections
    v
LocalAgentService / LocalAgentRequestStore
    | shared task application service + existing durable lead queue
    v
Existing Host engine / sealed Node connection / existing ACP lead
    | existing lead decides how to use Fleet tools and retained workers
    v
Existing task scheduling, checkouts, permissions and human review

Browser -> primary Host -> Microsoft administrator + CSRF
                          -> local integration settings and recovery controls
```

Implement a small facade injected with the existing service/store/engine. Do not
forward HTTP requests internally, call `app.inject()` to impersonate an operator,
copy whole route plugins, or grant the caller the lead's MCP credentials.

#### Mandatory local transport checks

Run admission before parsing a body and on every route, including reads/errors:

- Bind only literal `127.0.0.1`, explicitly `trustProxy: false`; validate actual
  bound address and the raw socket peer. Do not inherit `HOST` or proxy trust.
- Accept only exact authority `127.0.0.1:<actual-port>`. Reject malformed/missing/
  duplicate Host, wrong port, alternate IPv4 spellings, absolute-form targets,
  DNS names and rebinding suffixes. Do not reuse permissive main-Host allowlists.
- Require `X-Fleet-Local-Agent: 1` on every request. It is public protocol syntax,
  **not a secret or authentication**.
- Reject any `Origin` (including empty/null/same-origin), `Sec-Fetch-Site`,
  `Sec-Fetch-Dest`, `Sec-Fetch-User`, Cookie, Authorization, Node-proof headers,
  `Forwarded`, `X-Forwarded-*`, Via and Upgrade. Check header presence, including
  duplicates, not just truthiness. *(`Sec-Fetch-Mode` alone is tolerated: Node's
  own `fetch` sends `cors` on every request, and a browser never sends it without
  the refused `Sec-Fetch-Site` and `Origin`.)*
- No CORS allow headers, OPTIONS preflight, actionful GET, HEAD auto-exposure,
  redirects, static UI, WebSocket or JSONP. POST requires `application/json`.
  Disable automatic HEAD routes; unmatched method/path must not mutate state.
- Strict Zod schemas reject unknown fields; no operatorId/yolo/force/approval/
  profile/path injection through extra JSON fields. JSON responses use no-store
  and nosniff. Error/log projections exclude request bodies and credentials.
- Initial limits: 64 KiB request body; text message/objective at most 16,000
  characters plus serialized-byte validation; names at most 200 characters;
  list default 20/max 100; response body ceiling 256 KiB; read concurrency 16;
  accepted local writes 30/minute globally and at most 20 unresolved per lead.
  Existing stricter queue/storage limits still win. Use finite header/body
  timeouts (10 seconds) and a 30-second response deadline; no wait for model work.
  Return structured 413/429 errors before persistence. A committed operation
  remains discoverable if the client disconnects or the response times out.

**Residual risk must be explicit:** another native process can forge these
headers, and a local relay/SSRF endpoint can strip browser headers and rewrite
Host. This listener cannot authenticate OS users or block all proxies. Database
ACLs do not prevent a different local user from calling it. Never publish/tunnel
this port. Browser/private-network restrictions are defense in depth only.

An owner-protected local bearer file remains a future alternative for shared
machines; it is not silently made mandatory for the requested initial mode.

### 2. Configuration and lifecycle

Store validated host-local configuration separately from transferable data:

```ts
type LocalAgentConfig = {
  enabled: boolean; // default false
  port: number; // default 8786; integer 1024..65535, different from primary port
  allowedLeadSessionIds: string[]; // default []; max 100; no wildcard
  allowedWorkspaceIds: string[]; // default []; max 100; no wildcard
};
```

Add a card to **Settings -> Security**. Primary guarded configuration endpoints:
`GET /api/local-agent/config`, `PUT /api/local-agent/config`. Explicitly enforce
D13 rather than treating the normal operator guard as sufficient. Unknown,
wrong-role and dismissed IDs fail validation; stopped valid leads may remain in
scope for history. Stale/deleted IDs grant nothing and appear as stale in the UI.
Never auto-select the first lead or a repository copy for the operator.

Show desired config separately from observed listener state:
`disabled | starting | listening | error | stopping`, actual address, bounded
error and config revision. Browser uses only the primary origin. Copy examples
must show the numeric local URL and marker, never a credential.

Enable confirmation:

> Any process that can reach this loopback port, potentially including other
> local users, can read exposed conversations and ask these orchestrators to act
> using their existing permissions. Browser filtering does not authenticate
> agents. Do not forward or tunnel this port.

Lifecycle owner starts only after primary listening succeeds, not when an
in-memory `buildServer()` fixture calls `ready()`. Serialize transitions and
register shutdown cleanup before opening a socket. Bind failure leaves the
optional feature in `error`; never select another port or interrupt the main
Host. Close the local listener before the shared service/store shutdown.

Disable closes admission first (including keep-alive requests), then drains
connections within five seconds. Previously accepted intents may still execute
through normal CF delivery; the UI must say so. Removing scope denies subsequent
reads/writes but does not silently cancel accepted work. Explicit Stop and normal
operator recovery remain distinct actions.

Do not add local URLs to public/enrollment URLs, Node welcome/reconnect payloads,
lead MCP injection, managed tunnel targets or Vite proxies. Add a guard to Fleet's
own detached tunnel startup to refuse a target matching the configured local
listener. This cannot prevent forwarding by unrelated/manual tools.

Both restore paths and auth-reset close admission before state replacement and
reset enablement/exposure. Ordinary restart on the same Host retains explicit
consent. Incoming backup config must never enable this API. No env enable/scope
bypass is introduced; a future bootstrap option needs its own security review.

### 3. Local HTTP contract

All routes below require transport admission and effective exposure checks.
Unauthorized/out-of-scope resource IDs return the same 404 as missing IDs.
For a new mutation, use a structured 409/503 for an exposed but ineligible target.
Reads are permitted for retained stopped leads; writes never implicitly resume.

| Route | Purpose and response |
| --- | --- |
| `GET /v1/capabilities` | Version, fixed unauthenticated trust mode, supported operations and limits; no whole-fleet snapshot. |
| `GET /v1/orchestrators?cursor=&limit=` | Exposed nondismissed leads: ID/name, actual agent kind/profile, Node connectivity, session/stop/cleanup state, durable-write eligibility/reason. No secrets or launch environment. |
| `GET /v1/workspaces?cursor=&limit=` | Exposed workspace IDs/names and candidate source placement IDs, Node labels/online state, effective managed-mode requirement; no absolute paths. Needed to create a task without guessing IDs/baselines. |
| `GET /v1/tasks?leadSessionId=&state=&query=&cursor=&limit=` | Scoped task summaries; state includes closed history. Defaults exclude archived only; explicit filter allows retained archived records. Stable task ID/current owner always included. |
| `GET /v1/tasks/:taskId` | Task details: objective, phase/criteria, current owner, workspace/binding status, bounded notes and steps/results/admission. Large note/step collections use typed continuation cursors on this route. |
| `POST /v1/orchestrators/:leadId/tasks` | Create a real task and initial owed brief. 201 with task ID, operation receipt, status URL and task URL. Does not await a model or claim execution started. |
| `POST /v1/tasks/:taskId/messages` | Ask a question or give guidance to the current lead. 202 with durable request and delivery linkage. No direct worker prompt or lifecycle change. |
| `GET /v1/requests/:operationId` | Immutable acceptance result plus current delivery disposition, blocker/evidence, original task/lead IDs and read links. |
| `GET /v1/orchestrators/:leadId/transcript?before=&limit=` | Bounded non-touching lead-conversation pages using the existing projector. Full lead conversation may span several tasks; disclosure consent covers it, not merely one task. |

Task reads require **both** current owner in allowed leads and task workspace in
allowed workspaces. Lead transcript disclosure is explicitly conversation-wide;
workspace filtering cannot make an interleaved lead transcript project-private.
No worker transcript/file endpoint in v1; read bounded task results/notes or ask
the lead. Recheck scope and ownership for each pagination request; cursors do not
carry authorization. Request reads check original exposed lead/workspace and any
linked task's current scope. Transfer outside exposure denies these task/request
projections, but does **not** revoke historical transcript disclosure: an exposed
lead still exposes its entire retained conversation, including transferred-out
tasks and workspaces absent from the workspace allowlist. Include this explicitly
in consent. Do not imply that task filtering redacts an interleaved transcript.
If a task or original lead has been deleted, local receipt reads return 404;
retained tombstones remain visible only through the primary administrator UI.

Proposed request schemas (UUIDs are real IDs, not names):

```ts
type CreateLocalTask = {
  operationId: string;
  workspaceId: string;
  sourcePlacementId?: string; // required when effective mode is managed
  name: string;
  objective: string;
  clientLabel?: string; // unverified display label, max 80 chars
};

type LocalTaskMessage = {
  operationId: string;
  expectedLeadSessionId: string;
  intent: "question" | "guidance";
  text: string;
  clientLabel?: string;
};
```

Creation always uses current `workspaceMode: "auto"`; the caller cannot select
shared/legacy mode, override budgets/policy, set integration refs or supply paths.
Reuse current validated policy resolution, including forced wake policy and step
failure handling. Record the effective policy in task detail. Do not borrow an
administrator username to generate a branch; use existing nonhuman fallback
naming. Managed source belongs to the selected workspace and must be explicitly
chosen; no silent baseline or fallback to a shared checkout.

#### Old-task questions versus new work

- **question:** allowed on any exposed retained task, including completed,
  archived and awaiting-human, provided its lead is writable. Read its facts and
  ask the lead for explanation/status. Do not reopen the task, approve it,
  append a worker attempt or clear any hold in the facade.
- **guidance:** allowed only on a task whose existing continuation/maintenance
  admission permits it. Closed tasks return `reopen_required`; awaiting-human
  tasks return `human_review_required`; maintenance/fence holds retain their
  exact reason. The operator uses existing CF controls if more work is intended.
- Either intent may have a busy lead and queue normally. An old task with a
  stopped/offline lead remains readable; sending returns `lead_requires_resume`
  or `lead_unavailable`, with no alternate orchestrator/profile selection.

The envelope identifies request/task/intent/source and quotes user text as data;
its fixed instruction asks the lead to use the exact task ID, inspect retained
context and not treat local input as human authorization. For questions it asks
for an answer without reopening/dispatching. This steers behavior, **not a hard
read-only guarantee**: the lead retains its existing tool/shell authority.

Task association in reads is authoritative; model text is not. A settled request
can point to the lead transcript window, but cannot claim that every output in a
shared turn belongs exclusively to this request or that the answer is correct.

### 4. Shared services, atomic acceptance and delivery

#### Task creation

Extract the existing `POST /api/orchestrators/:id/runs` operation into
`orchestrator/task-application.ts`, preserving browser behavior first. In a
separate feature commit, make creation + ownership/state + owed brief + replay
receipt one transaction. Network and worktree preparation stay outside it.

For local creation:

1. Validate transport, exposure, UUID/payload, current lead capability/mutability,
   workspace/source and existing resource limits. Replay handling follows section 5.
2. In one transaction create the Run, set owner/running state, persist its owed
   brief with the **task ID**, and insert local receipt in `waiting_for_brief`.
   Persist owed-brief provenance: task ID, monotonic brief generation, exact text
   digest, contributing request IDs and delivery/retirement disposition. Every
   mutation of a locally linked `pendingPrompt`, including appended operator text,
   must atomically advance that generation and carry forward the request links.
   Keep nonlocal briefs compatible; never reconstruct provenance from prose.
   Do not rely on a same-name task lookup. Update planning resolution minimally
   if needed so the lead can adopt the exact unphased task by ID; retain legacy
   name-based calls and add a duplicate-name regression test.
3. Start normal worktree preparation after commit. A post-commit failure is a
   recorded task/preparation problem, not grounds to create a replacement task
   on retry. Recovery reuses the existing persisted preparation lifecycle.
4. When the engine converts this exact owed brief to a durable delivery, link
   its delivery ID to the pending local receipt **in the same transaction** as
   clearing `pendingPrompt` and enqueueing. Compare the exact owed generation/text
   digest and retire that generation; stale delivery decisions must not consume
   an appended or administratively retired brief. If a brief is combined with another
   owed message, record explicit many-requests-to-one-delivery linkage, not a
   transcript search. Preserve original request text separately.
5. After acceptance, loss of capability must leave the brief owed with a visible
   blocker, **not** execute the legacy dispatch branch. Existing nonlocal legacy
   behavior remains unchanged. Recheck mutable task/lead admission before handoff.

#### Task messages

Inside one transaction validate the expected current owner, scope, task intent
and lead mutability/capability; insert the request plus an associated durable
lead prompt using a namespaced logical key derived from the operation UUID.
Then call the existing `pumpLead`; do not send ACP or Node commands directly.
Questions use this queue even for closed tasks, rather than `Run.pendingPrompt`,
whose scheduling is lifecycle-dependent. No worker/session is created here.

Reuse the lead's stored execution binding where current prompt delivery requires
it. Replicate nonhuman admission in the shared facade: main route hooks do not
protect a second Fastify instance. Do not call `promptSession` with a made-up
operator ID to get around an idle/maintenance refusal.

Immediately before reserving a local delivery, recheck stopping/cleanup and
current task/owner admission. Add a small local-record-aware hook at the existing
queue boundary; it must not change unrelated human/wake/command delivery policy.
A guidance hold appearing after acceptance becomes a visible blocker; a question
does not itself clear that hold. Shared delivery batches cannot be partially
cancelled by deleting another source's text.

#### Queue and completion semantics

Use the existing queue limits and one in-flight reservation per lead. Do not
claim strict FIFO: busy-rejected entries are only retried after a newer session
event, so another eligible pending entry can be chosen first. New local limits
must leave capacity for ordinary CF wakes and command completions.

Expose native states without compressing them into a success boolean:

- `waiting_for_brief`: accepted task and owed brief, not yet a queue record.
- `pending` / `rejected_busy`: safely queued/retry-eligible under existing rules.
- `reserved`: Host has committed dispatch intent.
- `accepted`: Node journal admitted the prompt, not proof of model consumption.
- `settled`: authoritative completion of that lead turn, not task completion.
- `uncertain`: consumption/effects unknown; no fresh-ID replay, no timer expiry.
- `rejected` / `orphaned`: include exact bounded reason and last known evidence;
  orphaned is not synonymous with definitely never executed.

Expose separate task state, preparation state, worker admission/attempts, Node
connectivity, lead availability and request blockers. Missing evidence is null
or unknown, not zero percent progress or a successful result.

### 5. Request ledger, retries and persistence

Add `local_agent_requests` (and, if needed, a small linkage table) in the existing
SQLite database via the existing migration/transaction conventions. Typed store
wrapper in `local-agent-store.ts`, not raw SQL in HTTP handlers.

Persist: operation UUID; API version/kind; original task/workspace/lead IDs;
validated canonical payload digest; immutable acceptance response; unverified
client label and source `local-agent`; created/updated times; delivery ID(s);
pre-delivery intent state; monotonic request version; terminal disposition/evidence;
audit reference.
Keep a monotonic `dispatchEverReserved` fact and the strongest native receipt
evidence independently of the current queue state. Once dispatch was reserved,
`orphaned` cannot erase possible execution or automatically resolve the local
request. This fact and owed-brief provenance participate in backup/recovery.

Idempotency rules:

- UUID is unique across local write operations on this Host, not per client label.
  The same UUID on a different operation/target or with different validated
  content is 409 `idempotency_conflict`. Compare canonical parsed JSON (including
  meaningful text exactly), not raw key order or prompt text searched in history.
- After transport and current exposure checks, look up replay **before** mutable
  eligibility checks. A retry after Stop or task completion returns its original
  accepted IDs and current disposition rather than creating work again. Revoked
  exposure still denies access. Replayed requests count toward HTTP rate limits
  but not the new-work quota.
- The queue's logical-key uniqueness is a second barrier, not this contract.
  Creation/intent/ledger/linkage changes commit atomically. No send occurs inside
  the transaction; a crash after commit is recovered by normal CF processing.
- Retain terminal request content/evidence for 30 days; then redact payload text
  and keep a compact tombstone containing UUID, digest, IDs and disposition.
  V1 does not automatically delete tombstones: cap the ledger at 100,000 entries
  and refuse **new** operations with `receipt_storage_full` rather than silently
  evicting replay protection. Existing request reads/replays/reconciliation remain
  available. Future archival is an explicit administrative design, not a TTL that
  permits accidental repeated work. Bound content/queue bytes independently.
- Unresolved records are not expired by age. Preserve receipt identity even if
  task/session retention removes content. Local reads/retries against deleted
  targets return 404 under current-scope checks; administrator views show retained
  disposition plus `target_deleted`. The UUID remains consumed: no local mutation
  may reuse it to create a new operation, even with a different valid target.
- *(Implemented differently: the ledger is host-local and stays out of backups;
  restore keeps it and uses it to retire replayed briefs. See the implementation
  record. The original proposal follows.)*
  Backups include ledger/tombstones/linkage and owed-brief provenance. Restore
  **retains destination ledger/tombstones**, then transactionally merges imported
  records; never replace them with an older archive. Missing local fields in a
  legacy archive do not delete destination evidence. Reject UUID/digest/target/
  linkage conflicts before applying the restore; do not downgrade stronger
  settlement/reservation evidence with an older imported disposition. Conflicting
  evidence requires an explicit recovery decision, not last-writer-wins. Records
  whose targets disappear stay consumed/admin-readable under the deletion rule.
  Test a request accepted after a backup, followed by restoring that older backup
  and retrying the UUID. On a fresh destination, operations absent from the archive
  cannot be deduplicated; disclose this disaster-recovery limit and do not promise
  global exactly-once behavior. Restore disables the listener and
  never autonomously replays imported accepted/reserved/uncertain local requests.
  Mark them recovery-required consistently with imported command delivery state;
  retain original evidence. A waiting local brief must not lose its provenance
  and be replayed as an ordinary untracked `pendingPrompt`. Gate it until an
  operator disposes/reconciles it. Test both data-only and portable restores.

Audit bounded metadata for config transitions, accepted operations, conflicts,
rejections and operator disposition; no full prompts, secrets or raw exception
objects. HTTP logs omit bodies/credentials. Store source and request linkage for
UI attribution rather than relying on an attacker-editable textual prefix.

### 6. Ownership, Stop and recovery

Expected-owner validation and request insertion must be atomic. Add a shared
transactional check inside `transferRun`: unresolved local task requests prevent
transfer with `task_message_pending`. It applies to REST single/bulk transfer and
MCP, including waiting briefs, pending, busy-rejected, reserved, accepted and
uncertain records. An orphaned delivery with possible execution remains locally
unresolved, regardless of the shared queue's terminal classification. A proven
never-dispatched orphan also stays unresolved until its owed intent/batch is
explicitly retired. Do not merely fix the new route while leaving another transfer
entry point open. Same-owner no-op remains a no-op.

A settled turn releases this guard; it does not stop workers or change task
ownership by itself. Stop/cleanup must not silently erase pending local intent.
If a lead becomes terminal, project the underlying delivery evidence truthfully.

Provide an **administrator-only recovery action on the primary UI/API**, not the
local port: `POST /api/local-agent/requests/:operationId/disposition` with strict
`{ action: "abandon", reason, expectedRequestVersion, expectedBriefGeneration?,
expectedBriefDigest? }`. Require an administrator and CSRF; validate optimistic
versions and require generation/digest whenever an owed batch is affected. The UI
shows the exact affected batch and evidence before confirmation:

- A unique message proven never reserved/sent can be cancelled transactionally,
  removing its pending queue work without touching other sources.
- Stop alone does **not** clear `Run.pendingPrompt`, and transfer carries owed
  text forward. Before abandoning a creation brief or combined unsent batch,
  present the complete batch (including appended operator text) for explicit
  administrator confirmation with expected generation/digest. Atomically retire
  that entire proven-unsent generation, clear only the matching `pendingPrompt`,
  and disposition every contributing request. A changed batch conflicts and must
  be reviewed again. Do not silently delete another source's text. If the batch
  cannot be safely retired, retain the local transfer guard; Stop followed by
  abandonment must never let an old brief replay on resume or transfer.
- Reserved/accepted/uncertain work cannot be called safely cancelled. Allow an
  administrative `abandoned_unknown` disposition only after existing lifecycle
  evidence establishes that the old lead turn/process cannot continue (or an
  explicit existing Mark-stopped operator confirmation establishes that boundary).
  Preserve native receipt/attempt evidence and never replay that operation UUID.
  Do not change shared queue reservations merely to make a button succeed.
- Administrative abandonment releases the local transfer guard only after all
  owed generations and delivery linkages for that request are retired or
  authoritatively settled. Engine delivery and transfer must consult that durable
  provenance, including after restart/restore, and never migrate a retired brief.
  Administrative abandonment does not
  assert that earlier external effects did not happen or undo them. Show that
  warning and audit it. If quiescence cannot be established, recovery stays blocked.

This bounded recovery path is part of the release, not an unspecified future
fix for an indefinitely blocked transfer. Broader Host/Node uncertainty-reservation
alignment is a separate issue; changing it requires its own cross-layer tests.

### 7. Reads, conversation output and UI

Use bounded projections from existing stores and `service.withAdmission` rather
than whole snapshots or a new progress calculator. No status/transcript request
updates `last_activity_at`. Use stable keyset cursors for lists; order and filters
are encoded in versioned opaque cursors. Reject invalid/cross-route cursors. Define
results as live pagination, not a frozen fleet-wide snapshot, and recheck scope.

Reuse transcript `{generation, revision, total, start, blocks}` semantics with
smaller local limits (default 50/max 200 blocks, plus response byte ceiling).
Return `hasMore`, `nextBefore`, `truncated` and an explicit oversize-block marker
when a single block exceeds the byte budget; never silently drop it or issue a
cursor that cannot advance. On generation change, clients refetch. Revision is
not a promise that an old block is immutable. No new global event cursor is needed.

Task detail independently pages notes/steps and includes truncation/continuation
metadata. Limit notes/results by bytes as well as count. Do not use only
`run.updatedAt` to infer note, admission or session freshness. Return measured
snapshot timestamps and current original IDs.

Publish accepted task/note/request changes through existing browser update paths;
add optional request/source metadata only where needed. A small request list in
the lead/task detail shows queued/uncertain/settled and unverified client label,
links to normal CF task/conversation views, and exposes primary-UI recovery to
administrators. Keep human review buttons and maintenance approvals unchanged.

Caller workflow: discover -> choose exact lead/workspace/source -> submit once
with saved UUID -> poll receipt/task -> read relevant lead transcript pages.
Start polling at two seconds and back off to ten seconds; stop on completion,
required human action, uncertainty, caller deadline or loss of scope. A timeout
is a reason to GET/retry the **same UUID**, not to submit a new task or nudge.

### 8. Suggested implementation files

- New `packages/protocol/src/local-agent.ts`: strict public DTOs, bounded response
  schemas, errors and receipt unions; export from protocol entry point.
- New `apps/host/src/local-agent-server.ts`: separate instance, transport guard,
  registration, listener lifecycle; no store ownership.
- New `apps/host/src/local-agent-service.ts`, `local-agent-store.ts`: scoped
  application facade, request ledger/projections/attribution/recovery.
- New `apps/host/src/routes/local-agent-settings.ts`: primary guarded config,
  listener status and administrative request disposition.
- New `apps/host/src/orchestrator/task-application.ts`: pure extraction first,
  then atomic shared task creation and exact-ID briefing support.
- Small deliberate changes in `server.ts`, `store.ts` migration/backup paths,
  `orchestrator/engine.ts`, `lifecycle.ts`, and command queue admission/linkage.
- Security settings card and small task/lead receipt presentation; optional
  protocol/UI metadata must leave old snapshots usable.
- Focused tests adjacent to each module, cross-layer delivery tests and a hostile
  browser/socket integration fixture. Update README/ARCHITECTURE/lifecycle docs.
- No new Node transport or Hermes adapter in v1; change Node only if a demonstrated
  existing wire limitation blocks the contract, with separate compatibility tests.

## Phasing

### P0 — Preserve behavior and establish seams

In a separate implementation worktree, read current diffs and baseline tests.
Extract task creation into the application service with unchanged browser route
behavior/status codes. No new listener, migrations or security exceptions in
this commit. Existing task creation, managed workspace and lifecycle tests green.

### P1 — Domain correctness before exposure

Add ledger/DTOs, atomic task ownership/brief creation, exact-ID task adoption,
durable receipt linkage, question/guidance operations, admission checks, transfer
guard and operator recovery. Implement non-touching bounded reads. Use in-memory
and reopened disposable databases with mock Node/ACP; no network feature enabled.

### P2 — Opt-in REST and usable operator experience

Add the isolated listener/security checks, primary settings/consent, scoped
selection, visible actual listener status, receipt attribution/recovery UI,
backup/reset behavior and documentation. Wire shutdown/disable and detached-tunnel
negative checks. Feature remains off until an operator opts in after deployment.

### P3 — Acceptance and handoff

Exercise native HTTP against an isolated listener and the actual shared delivery
path with fake ACP/Node fixtures. Test busy leads, old closed-task questions,
restart/lost receipt, hostile browser/proxy/Host cases and main-auth isolation.
Run the complete repository validation in the implementation worktree. Record
actual output and outstanding failures; do not claim a real model/provider smoke
succeeded from mock evidence. A production smoke needs separate owner consent.

### P4 — Optional later work, not a release dependency

SSE; owner-file bearer mode; a general non-task lead chat endpoint; broader
uncertain-delivery recovery. No broad FleetTools export. Do not investigate
unrelated backends now. *(The MCP adapter with only local task/read/message
tools, originally listed here, shipped with P2.)*

## Acceptance criteria and verification

### Required behavior tests

1. **Disabled/isolation:** no socket by default; optional bind collision leaves
   main Host healthy; actual bind is literal loopback. `HOST=0.0.0.0`, main-port
   changes and `FLEET_ALLOWED_HOSTS=*` never widen it. `ready()` opens no sockets.
2. **Transport:** real TCP tests cover duplicate/wrong/missing Host and port,
   absolute-form requests, browser Origin/null/empty, Sec-Fetch, marker absence,
   JSON versus forms, OPTIONS/HEAD/Upgrade, proxy headers and oversized input.
   Hostile browser tests assert no mutation, not merely unreadable CORS responses.
   A fully rewriting local proxy remains a documented residual risk, not an
   impossible negative test claiming all proxies are blocked.
3. **Authority:** local calls cannot reach main auth/admin/Node/lead routes or
   spoof operator/source metadata. Original `/mcp` still needs valid lead claims.
   No change to Microsoft-only mode, YOLO defaults or human approval gates.
4. **Scope/disclosure:** no implicit first lead; out-of-scope IDs/cursors fail;
   stopped/closed retained history is discoverable; task owner/workspace is
   rechecked. UI warns that a lead transcript crosses task/workspace boundaries.
5. **New task:** idle and busy lead cases create one owned task/owed brief/receipt.
   Duplicate task names still target the exact ID. Managed source requirement,
   online placement, policy budgets and preparation failure remain truthful.
6. **Atomicity/idempotency:** crash injection between every acceptance/linkage
   step, HTTP response loss, SQLite reopen and simultaneous same/different-payload
   retries produce no duplicate task or unowned acceptance. Replay after Stop
   returns original IDs; revoked scope still denies. Storage caps never evict keys.
7. **Old work:** a question on completed/archived/awaiting-human work is delivered
   without facade reopen/review/worker mutation. Guidance respects closed/human/
   maintenance holds. Busy queues, offline/stopped refuses; no silent new lead.
8. **Delivery:** accepted is not settled; rejected-busy retries retain identity;
   Host/Node restarts, stale completion, replayed history, lost receipts and MCP
   recovery never create a fresh prompt for unknown effects. Test Host and Node
   together, including conservative uncertain reservations and visible recovery.
9. **Transfer/Stop:** acceptance-versus-transfer races serialize; all REST/MCP
   transfer paths apply the shared guard; questions also bind their task owner.
   Settled releases it; uncertain requires documented operator disposition;
   stopping a lead does not falsely mark its workers/tasks completed. Test
    abandon -> transfer/resume with an owed creation brief, appended operator
    text, stale generation/digest, and orphaning before/after reservation; no
    retired intent may replay and possible execution must stay unresolved.
10. **Identity:** Copilot and Hermes lead fixtures use the existing ACP path.
    Saved profile/Node/native identity is unchanged; wrong-role/missing-history
    fails, no implicit backend fallback or second concurrent profile process.
    Ordinary Host resume may reapply current model defaults; do not test an
    invented guarantee that all picker choices are immutable.
11. **Reads/UI:** bounded pagination advances on oversized entries; truncation,
    generation/revision and unknowns are explicit. Polling leaves retention
    activity untouched. Existing browser task/notes/transcript updates work;
    settings/receipt UI never calls the local port.
12. **Lifecycle/backup:** disable handles keep-alive/concurrent requests; accepted
    work semantics are visible; teardown precedes DB close. Both restore formats
    retain idempotency evidence but disable scope and prevent imported local
    intents becoming untracked/replayed briefs. Main-only administrative recovery
    preserves ambiguous evidence. Test destination-ledger merge against older and
    legacy backups, post-backup UUID reuse, conflict rollback and nondowngraded
    evidence; a fresh destination's missing-history limit is documented. Test
    deleted-target local 404 with administrator-visible tombstones and continued
    idempotency protection. No changes to tunnel/enrollment/Node MCP URLs.

### Commands for the implementing agent

Run only in a separate worktree with its own installed dependencies and disposable
CF data. Do not copy `node_modules` from the live checkout. Never invoke live
`npm run dev`, `npm start`, reset-auth, service install/update or real profiles as
part of tests. Root builds/tests write dist/fixtures and are not read-only.

```bash
npm ci
npm run build -w @fleet/protocol
npx vitest run --project services apps/host/src/routes/orchestrators.test.ts apps/host/src/orchestrator/engine.test.ts apps/host/src/orchestrator/transfer.test.ts apps/host/src/command-execution.test.ts apps/host/src/request-guard.test.ts apps/node/src/lead-prompt-delivery.test.ts apps/node/src/router.test.ts
# Add all new local-agent tests and the suites listed below.
npm run verify
# When UI/browser integration is ready, in its isolated harness:
npm run test:e2e
```

Additional regression anchors: orchestrator continuity/lifecycle/schedule/MCP
principal, managed worktrees, maintenance controls and Resume-now, Host backup/
restore/retention/transcript, Node agency-startup/MCP recovery/permissions, protocol
schemas, UI useFleet/ConversationTasks/OrchestratorPage/SecurityPanel. Repository
Vitest projects are `services`, `ui`, `node-ui` (`vitest.config.ts:~18-51`). Full
verify/typecheck/build/test can be slow on this Windows host; preserve logs and do
not interrupt the running Fleet process to accelerate them.

## Open questions

No blocking product question is required to start P0-P1 using the defaults above.
Before enabling P2 on the real Host, the owner must choose the exposed lead IDs
and workspace IDs and accept the unauthenticated trust warning in the UI. Never
infer that consent from this design or pre-enable it during implementation.

The owner may instead request owner-file bearer authentication, but it is an
alternative trust model, not a hidden dependency of this unauthenticated design.
General non-task chat, automatic resume and automatic task reopen are
explicitly deferred rather than unanswered requirements.

## Ready-to-use Copilot handoff

Implement `docs/local-agent-api-plan.md` in a separate worktree. Begin with the
P0 behavior-preserving extraction, then P1 domain correctness, P2 opt-in listener
and UI, and P3 verification. Keep the feature disabled. Preserve the existing main
Host authentication, lead MCP, Node channel, scheduling, profile ownership and
human approval boundaries. Do not expose the normal API on another port or launch
another Hermes session. Do not claim completion until the acceptance matrix has
real test evidence, including old-task questions, idempotency/crash recovery,
ownership transfer, uncertainty recovery and hostile-browser rejection. Report
any incompatible existing contract before replacing it with a weaker guarantee.

## Evidence and document validation

The design below this point was investigated from source and tests, not by
implementation tests or a live Fleet mutation; the
[implementation record](#implementation-record) supersedes it where they differ,
and its tests (`local-agent-service.test.ts`, `local-agent-server.test.ts`,
`LocalAgentCard.test.tsx`, the Security panel and fleet-wake suites) are the
execution evidence. During the design investigation the working tree contained
unrelated Host presence/store/server and Node main/socket changes, and changed
during inspection; none were edited for this design. Use the pinned baseline for
citations and inspect current diffs before relying on them.

During document validation HEAD advanced to
`01b4375a4c02cd4853f03c5f9a2579664bd10f1c` (heartbeat/presence change). The
baseline-to-HEAD changed-file inventory was inspected; the detailed task/queue/
authentication paths above did not change in that interval. Baseline line numbers
remain intentional, particularly for `server.ts` and `store.ts`. Additional
uncommitted Git-runner/integration-test edits were left untouched. Markdown
formatting and source-reference/section validation are document checks only, not
execution evidence for the proposed API.
