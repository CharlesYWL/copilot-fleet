# Hermes cache-inclusive token correction

## Confirmed defect and approved fix

Hermes persists canonical **uncached** `input_tokens` alongside disjoint cache-read/cache-write buckets. Copilot persists inclusive input. Fleet incorrectly summed only Hermes input+output, and also selected the larger of Hermes lifetime database counters and ACP in-process response counters under the same identity. The resulting per-metric regressions mixed incompatible histories: a 95.30M headline with 529.56M cache reads.

## Implementation pseudocode

1. Leave Copilot normalization unchanged. For a Hermes native session, require known nonnegative integer uncached input, output, cache read, and cache write. Compute `inclusiveInput = uncachedInput + cacheRead + cacheWrite`; `total = inclusiveInput + output`. Never add reasoning again. Reject missing/invalid/overflowed required buckets rather than assume zero.
2. Use only the exact profile/native session's read-only database aggregate for Hermes consumption. ACP `usage_update` continues to report context pressure; `PromptResponse.usage` is not a compatible lifetime counter and will no longer enter the durable history. Poll every three seconds and refresh after prompt completion. Database unavailability leaves prior readings intact until polling succeeds.
3. Emit source `hermes-native-totals-v2` with a versioned counter identity including profile and native session. This ensures the Node journal sends even an unchanged numeric reading and prevents comparison against incompatible counters. Resumed sessions begin as undated opening balances; genuinely new native sessions retain their known creation interval.
4. Reconcile old `hermes-session-totals` records at **report time**, without rewriting immutable stored snapshots. Those records mixed sources without provenance, so neither cache addition nor max-value heuristics can safely repair them. Exclude their entire metric set from baselines, totals, and daily rows. Preserve them in backups. Updated Nodes supply one consistent native cumulative opening, recovering all-time usage without a correction charged today. Subsequent real deltas use normal interval accounting.
5. Return optional coverage counts for legacy Hermes sessions and those still awaiting a corrected native reading (scoped by Node + profile/native counter). Show clear English notices in the report. Explain that historical period allocation from the old mixed series is unavailable. Apply global counter decisions before task filters and retain all existing Copilot/backfill rules.
6. Add regressions using the observed 1,518,197 uncached input + 414,225,335 cache read + 38,500,830 cache write + 872,784 output = 455,117,146 total. Test legacy exclusion, v2 replacement/openings, subsequent deltas, task filtering, reordering, backup preservation, missing native columns, overflow, and contradictory ACP responses.

## Delivery and constraints

Combine this fix and the already implemented credit-backfill button in a single PR to `charlesyin_microsoft/copilot-fleet` main. Work directly without delegation. No new dependencies, provider requests, live database writes, service restarts, or version changes. Both Host and Nodes need the update for refreshed Hermes totals. Full repository lint/typecheck/build and focused accounting, provider, authorization, and UI tests must pass before publishing; the full repository test suite is not claimed unless run.
