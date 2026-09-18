# Host-driven remote command permissions

Updated: 2026-09-17. This design supersedes the earlier local opt-in and
stop-all-sessions setup in this PR. The implementation is for trusted operators;
it is not a sandbox.

## User flow

1. An Orchestrator requests a command through `fleet_run_command`.
2. The Host resolves a registered placement or eligible managed worktree. The
   executing Node prepares its physical directory, shell, and permission identity.
3. If the Node has no applicable permission, the Host opens an approval dialog
   showing the exact command, machine, working folder, reason, and deadline.
4. The operator selects **Allow once**, **Allow during session**, **Always allow
   on this Node**, or **Deny**.
5. The Host sends the approved immutable request and scope to the Node. The Node
   validates the request and any remembered rule again before execution.
6. Output streams to the Host; durable completion wakes the Orchestrator without
   a polling loop or a new Copilot worker.

There is no preliminary local enable switch, eligible-root checklist, deployment
acknowledgment, or stop-all-sessions dialog. The regular Node settings page remains
available, with an optional persistent-only bulk JSON permission editor.

## Permission scopes

| Scope | Authority and lifetime |
| --- | --- |
| Once | The exact execution ID, attempt, command digest, target, and limits. It is never a reusable rule. Durable receipts prevent accidental relaunch. |
| During session | Node-process memory, bound to Host identity, requesting Orchestrator session, command identity, and canonical folder. Not shared with other sessions. Revoked on session stop and lost on Node restart. |
| Always on this Node | A versioned rule saved in Node configuration. Bound to the Host and exact resolved folder, and checked on every later request. An operator can remove it from Node settings. |
| Deny | No submitted code runs and no new grant is created. |

Host approval routes remain operator-authenticated. The MCP machine principal
cannot approve its own request. Existing YOLO/session policy is not a grant.
Matching permission records do not waive active-session ownership, maintenance,
resource, deadline, or managed-result restrictions.

The Host does not keep an independent reusable allowlist. The Node's prepared
permission description is part of the hashed descriptor. Automatic use is
explicitly recorded in execution history, and the Node rechecks current rules at
start. Removing a rule after preparation prevents its subsequent automatic use.
Persistent-rule write failure must be surfaced before submitted code starts.

## Matching command and folder

The chosen conservative identity is **command/subcommand + canonical working
folder**. Recognized ordinary flags do not create distinct rules:

- `git status --short` and `git status --branch` share the `git status` identity.
- `git reset` does not inherit a `git status` rule.
- `npm run build -- --verbose` shares `npm run build`; `npm run deploy` does not.
- A rule for one folder is not a prefix grant over its children or a different
  checkout. The displayed grant must match the actual Node resolution.

This is intentionally narrower than approving every subcommand of `git` or
`npm`. A reusable grant is still broad: ordinary arguments may change, and it
does not certify that all invocations are read-only.

When a reliable command identity cannot be determined, offer exact-script Session/Always.
Compound scripts, separators, redirection, computed commands, substitutions,
evaluation/code payloads, and unsupported execution-changing options must not
inherit permission from their first token. No regular-expression shortcut may
turn `git status; another-command` into an automatically approved Git request.
The complete script remains visible for review. Its exact text is hashed without
normalizing flags, whitespace, or statement order, and is bound to the canonical
starting directory and Host. Any text change asks again. This does not pin tools,
files, or environment values the script resolves at runtime.

Reusable external-command rules also pin the resolved executable's identity and
contents. Updating, replacing, or redirecting that executable asks again instead
of silently transferring trust. The UI displays the readable command; the full
stored key, including its fingerprint, remains available in its tooltip. Adding
a plain command in Node settings resolves this identity on the Node.

Other literal executable invocations, including `dotnet build`, `cargo test`, and
`where.exe git`, can also have reusable rules when the Node can resolve the tool
reliably. Their operands and unrecognized flags stay in the displayed identity
rather than being guessed away. Shells, interpreters, dynamic dispatch, absolute
executable paths, and unresolved tools require exact-script grants instead.

Literal directory changes (`cd` / PowerShell `Set-Location`) have visible,
removable built-in rules. These are not `Set-Path`, which is not a PowerShell
built-in. Defaults cover supported local directory changes only; they do not
authorize arbitrary later commands, remote/provider paths, or dynamic evaluation.
Each execution still has a fresh shell; changing directories in one execution
does not change another execution's cwd.

## Node settings

The command-permission editor is a large JSON array, one command/path object per
line, with explicit Save, Format, and Reload actions. Readable command text is
persisted for new Always grants; old script text is recovered only from matching,
hash-verified Node journal evidence. Missing originals stay explicit `legacyKey`
references rather than guessed text. Once and session grants are not listed.

Explicit `*` patterns match simple command identities and resolved local folders,
including subfolders; they do not grant appended scripts or dynamic expressions.
Pattern rules trust matching program names/arguments, not executable versions.
Their matching retains literal arguments and flags. Command-mode normalization
remains separate and also works with wildcard folders; an omitted default mode
and explicit `command` mode preserve the same existing rule and pin.
`match: "exact"` preserves literal full-script text and may use a folder pattern.
Unchanged entries retain private IDs, Host bindings, and executable pins.

Edits use a
versioned compare-and-set endpoint separate from the ordinary settings form, so
an old open form cannot overwrite a rule just saved by Host approval.

Rules removed by the operator stay removed; initialization must not recreate
deleted defaults on every restart. Old `remoteCommandsEnabled`,
`commandExecutionRoots`, and `commandIsolationConfirmed` values are not migrated
into permission grants.

Session grants and Once evidence are not exported as new execution authority.
Identity/backup restore must clear volatile permissions and quarantine pending
requests as appropriate; no copied approval or pending prompt is executed merely
because a backup was restored.

## Execution and recovery remain separate

Reuse the existing finite Windows PowerShell 5.1 runner, independently supervised
Job Objects, suspended launch, parent-loss handling, monotonic runtime limits,
script-file transport, and retained output journal.

- A permission grant is not an execution receipt.
- Node readiness is about runtime support, not whether an operator has visited
  a setup page.
- Duplicate requests return the existing execution; they do not reapply side
  effects. A deliberate rerun needs a new request key.
- Session/always grants are saved only for a reliably reusable identity.
- Unknown outcome and unknown process ownership remain different facts.
- Output offsets and bytes commit atomically. Recovery preserves native output
  not yet transferred into the journal.
- Ordinary placement commands can coexist with sessions and legacy untracked
  session markers, without deleting those records. They still record process
  ownership and exclude maintenance. Managed task commands and legacy Host
  exchanges retain exclusive checkout coordination. No implicit session stop
  is introduced; operators coordinate ordinary concurrent file writes.
- Known unknown ownership or maintenance quarantine still blocks execution.
  Approval does not waive it or delete lock files.
- Worktree sealing, review, and publication are not implicitly approved by
  running a command. Protected managed targets remain restricted.

The Host and executing Node negotiate the permissions capability separately from
legacy command transport. Older Nodes must not accidentally receive persistent
approval semantics that they interpret as Once or unconditional execution.

## Host dialog behavior

An unmatched pending request opens automatically from live events or a restored
snapshot. Queue multiple requests rather than replacing the currently reviewed
command. Existing Host dialogs take precedence. **Review later** leaves the
request in Commands without repeatedly stealing focus on every snapshot.

The full command and physical target are shown. Session/always buttons display
the reusable command key and folder and explain their broader argument scope.
For exact-script grants, explain that any text change requires new approval.
Older Nodes with no reusable descriptor retain Once-only controls.
Disconnects, stale versions, persistence failures, and denials stay explicit.

Keep the existing Commands history/details view for output, cancellation,
additional evidence, and reopening a deferred permission request.

## Acceptance checks

| Scenario | Expected result |
| --- | --- |
| Fresh upgraded Node | Request reaches Host review without local opt-in, root entry, or draining unrelated sessions. |
| Once | Exact request runs once; another request needs review. |
| Session grant | Ordinary flag variants on the same key/folder reuse permission only for the same requesting session. |
| Session stop / Node restart | Volatile grants are revoked; a later unmatched request asks again. |
| Always | Node configuration persists the rule; matching later requests can run automatically. |
| Rule deletion | A future or queued automatic start cannot use the deleted rule. |
| Separate path/subcommand | Does not inherit an unrelated rule. |
| Dynamic/compound script | Exact full-script Session/Always only; no first-token autoapproval. |
| Built-in directory change | Supported literal local changes can match; removing the default makes them ask. |
| Concurrent local settings / Host grant | Versioned/serialized writes preserve both intents or return an explicit conflict. |
| Rule persistence failure | No success-shaped response or submitted command launch. |
| Multiple popup requests | Each remains individually reviewable with the correct target/digest. |
| Ordinary session workload | No forced stop or all-Node drain requirement; conflicting checkout ownership is explicit. |
| Existing lifecycle behavior | Native cancellation, replay, output bounds, durable lead delivery, attachments, and backup quarantine continue to pass. |

The prior integration review remains relevant to runtime correctness: independent
supervision, bidirectional admission, pre-mutation maintenance barriers, immutable
managed results, acknowledged lead delivery, and Windows command-line/encoding
limits remain requirements. Changing the permission UX does not remove them.
