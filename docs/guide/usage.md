# Usage summary

For collection sources, storage, delivery, and accounting rules, see the
[technical design](../session-usage-design.md).

Open **Usage** in the Fleet sidebar to review AI credits and token consumption across all Fleet-managed sessions, including Orchestrators.

## Reading the summary

- **AI credits** are Copilot-reported credits. Hermes has no Copilot credit reading; unavailable credits are not a claim of zero consumption.
- **Total tokens** combines reported Copilot and Hermes consumption. Coverage shows how many sessions have supplied token and credit readings.
- The English-language dark report shows headline totals, independent token-detail counters, a daily chart, the selected breakdown, and reporting-scope notes. All filters apply to both the chart and the table, even when grouping the table by machine, task, or session.
- Token and credit values use decimal **K / M / B** units (1,000 / 1,000,000 / 1,000,000,000), with two decimal places for abbreviated values. Hover or use a screen reader to read the underlying value. Rounded displayed values may not sum exactly.
- The daily chart shows allocated daily token totals only. Opening balances and intervals spanning multiple days are listed separately, never assigned an invented date. Missing days are not confirmed zero usage. Long histories scroll horizontally.
- Input, output, cache read/write, and reasoning are optional source-reported details. They are not necessarily additive: cached input may already be included in input, and reasoning may already be included in output.
- Context-window occupancy is deliberately excluded from consumption totals.

Filter by machine, task, backend, or role. Choose the last 24 hours, 7 days, 30 days, all recorded history, or a custom date range. Daily groups use the report timezone; custom end dates include that whole local day.

## Live and historical readings

Fleet records changed cumulative session snapshots while sessions remain open. Idle polling does not add usage. Shutdown can advance the final reading but does not charge the same cumulative total again. Updates appear after the backend supplies accounting data, not as an estimated count of streaming text.

The first reading of an already-running conversation can be an **opening balance**. All-time totals include it once, but Fleet does not assign older usage to the day it discovered the session. Intervals spanning a filter boundary are shown as unallocated rather than guessed or prorated. Intervals spanning multiple days have their own daily-report group.

Workers and reviewers use their task binding. Long-lived Orchestrators can serve several tasks, so their spend appears under **Shared Orchestrator usage**, not an arbitrary split among tasks. Standalone sessions have their own task group.

## Reliability and privacy

Changed snapshots are persisted on their executing Node before delivery and acknowledged after the Host commits them. Reconnect retries use stable identities. Usage metadata survives transcript cleanup and travels in Host backups. Measurement failures do not run another model prompt or stop an agent.

Only usage counters, source identities, timestamps, and retained machine/session/task labels belong in the accounting history. Prompts, responses, credentials, and transcript bodies are not copied into the usage tables.

Backend versions differ in the cumulative counters they expose. Missing token totals or details remain unavailable. A decreasing counter without a verified new counter scope is flagged rather than silently interpreted as a new charge. Older peers do not receive unnegotiated usage messages.
