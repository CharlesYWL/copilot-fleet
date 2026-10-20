# Dark usage report implementation plan

## Approved design

Adapt the user's OpenClaw weekly HTML report to Fleet. All interface copy is English. Reuse Fleet's dark Fluent UI theme: navy background (#0b0f1a), raised surface (#111728), light text (#e9eefb), muted text (#8994ab), blue accent (#6c8cff), and subtle dividers (#252e45). Use restrained Georgia report headings, the existing body font, and monospace tabular numeric values. Keep the reference's spacious report header, three-column summary, split analysis, and table/caveat layout. Collapse sections on narrow screens.

Show total tokens, Copilot AI credits, and token-reporting session coverage instead of estimated dollar costs. Preserve all filters and the five-second refresh. Show daily total-token bars independently of the selected table grouping. Display optional source counters independently because cache/input and reasoning/output may overlap. Keep unknown values distinct from zero and retain opening-balance, multi-day interval, and boundary warnings. Do not copy sample values, model names, prices, or simulated categories from the reference.

## Scope and implementation

Work directly in the existing worktree; no delegation, dependencies, collection changes, database changes, version changes, or publishing.

1. Add `apps/host/ui/src/lib/usage-format.ts` and its Vitest tests. Format decimal K/M/B to two fractional digits, leave smaller numbers readable, retain credit precision below 1K, and promote rounded unit boundaries. Preserve exact English-formatted numbers for accessible text and hover titles.
2. Extend `UsagePage.test.tsx` before implementation to cover compact values, English report headings, a daily chart under machine grouping, identical filter/range propagation to both requests, missing daily values, overlapping details, and errors.
3. Implement `UsageReportView.tsx` for the presentation. `UsagePage.tsx` remains responsible for filters and fetching. Pseudocode:
   - Build the selected query once per refresh; reuse its time boundaries for a daily query.
   - If grouped by day, reuse the same response; otherwise request the selected and daily reports concurrently.
   - Abort stale requests on filter changes and unmount; publish both responses together.
   - Render summary, independent detail bars, date-only daily bars, grouped table, and measurement notes.
   - Exclude unknown-date and multi-day buckets from dated bars; list their actual amounts separately.
   - Use exact accessible names and hover titles for compact values; support keyboard access and horizontal scrolling for long histories.
4. Update `docs/guide/usage.md` with report layout, K/M/B rules, and chart limitations.
5. Run targeted Vitest tests, Prettier, ESLint, Host typecheck, production build, and a local synthetic-data browser check at desktop and mobile sizes. Synthetic preview data is strictly local and is not shipped.

## Verification commands

- `npx vitest run apps/host/ui/src/lib/usage-format.test.ts apps/host/ui/src/components/UsagePage.test.tsx apps/host/ui/src/components/Sidebar.test.tsx`
- `npx prettier --check <changed files>`
- `npx eslint <changed TypeScript files>`
- `npm run typecheck -w @fleet/host`
- `npm run build -w @fleet/host`

Existing runtime requirement is Node >=22.5 (including node:sqlite); this UI-only change preserves it.
