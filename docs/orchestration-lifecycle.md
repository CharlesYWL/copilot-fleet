# Orchestration lifecycle

Orchestration control uses separate persisted facts:

- The run and step state controls scheduling.
- The session state records the latest worker state reported by a Node.
- `stopRequested` records an unacknowledged Stop across disconnects and restarts.
- `dismissed` controls visibility only.
- `stoppedByOrchestrator` identifies unfinished steps that Resume may continue.

## Operation contract

| Existing state | Stop | Dismiss | Resume |
|---|---|---|---|
| Pending or dependency-waiting step | Run becomes `cancelled`; step becomes `cancelled` and is marked resumable | No execution change | Marked step returns to `pending`; dependencies are re-evaluated |
| Starting, queued, or running step | Same persisted cancellation; worker receives Stop and remains in its reported state until acknowledgement | Rejected while the lead is live | Rejected until every Stop is acknowledged |
| Succeeded step | Preserved | No execution change | Preserved and never dispatched again |
| Failed step | Preserved | No execution change | Preserved; descendants remain blocked |
| Skipped or independently cancelled step | Preserved | No execution change | Preserved |
| Offline worker | Stop intent remains persisted and is reissued if the Node reports the session after reconnect | Rejected until the lead is terminal | Rejected while execution is unknown |
| Terminal worker | Preserved | No execution change | Reattached only when its step was marked by orchestration Stop |
| Live lead | Owned runs are cancelled before any stop command is sent; the lead records `stopRequested` | Rejected | Rejected |
| Terminal lead | Idempotent; any still-live owned run is cancelled | Allowed only after owned work settles; visibility changes and history remains stored | Lead is reattached, then eligible stopped runs reopen |

Dismiss and restore never change run, step, or worker state. A dismissed lead and
its tasks remain in persistence and continue accepting late terminal events.

## Dependency rules

A step is runnable only when every prerequisite is `succeeded`. Failed,
cancelled, or skipped prerequisites block their direct and transitive
descendants. Independent branches remain eligible. Fan-in requires every branch
to succeed.

## Event precedence

1. Persisting run cancellation prevents all new dispatches.
2. A matching turn completion followed by `idle` or `completed` wins a race
   with Stop and preserves that step as `succeeded`.
3. A reported worker failure remains `failed`.
4. A Stop acknowledgement leaves unfinished work `cancelled`.
5. Nonterminal events received after Stop do not clear stop intent; Stop is
   reissued.
6. Nonterminal state events for dismissed sessions are recorded but cannot
   restore the session to a live UI state.
7. Event sequence watermarks prevent output from an earlier attempt from being
   attached to a resumed attempt.

## Recovery and compatibility

The control fields are additive SQLite columns with safe defaults, so older
databases remain active and visible. Backups preserve the fields. On reconnect,
a stopped session still present on the Node receives Stop again; a session no
longer present is confirmed `stopped`. Resume resets only steps explicitly
marked by the orchestration Stop transaction.
