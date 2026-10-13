# Development

[← README](../../README.md) · [Guide index](README.md)

Commands, benchmarks, and local verification for contributors.

## Commands

```bash
npm run dev
npm run dev:tunnel
npm test
npm run test:watch
npm run test:coverage
npm run test:e2e # builds, then drives the built UI in a real browser
npm run typecheck
npm run build
npm run verify   # lint, format, types, tests, then production builds
```

For repeatable chat-history performance measurements, run
`npm run benchmark:history` (Host and data path) and `npm run benchmark:browser`
(the built UI in headless Edge). Both use synthetic histories and an isolated
Host, report median/P95 timings, and write JSON reports under `dist/benchmarks`.
See [Chat-history benchmarks](../chat-history-benchmarks.md) for workload
sizes, before/after comparisons, and measurement limitations. The
[chat-history performance plan](../chat-history-performance-plan.md) records
what was implemented, the measured results, and the remaining limits.

`npm run benchmark:session-stream -- --rtt 50 --max-regression-ms 15` compares
direct event forwarding with durable Node forwarding for 1, 4 and 8 concurrent
streams at 50 chunks/second each. It uses separate Host/Node processes, real
WebSockets and SQLite stores, and a simulated round-trip delay. The optional
budget fails the command if journaled P95 exceeds the direct baseline by more
than that many milliseconds. `--rtt`, `--sessions`, `--duration` (milliseconds)
and `--output` customize the run. This measures event creation to Host
publication, not model latency or browser painting, and never contacts running
Fleet installations. Healthy delivery does not wait for per-session ACKs;
offline recovery still uses the explicit synchronization barrier.
See the [Node session console guide](../node-session-console.md#low-latency-live-delivery)
for the pipeline, backpressure limits and durability rules behind this benchmark.

### Local verification and test monitoring

The primary repository is
[`charlesyin_microsoft/copilot-fleet`](https://github.com/charlesyin_microsoft/copilot-fleet).
It is private; open it with the corporate GitHub account. Its user-owned
managed-account hosting does not provide GitHub-hosted Actions runners, so this
repository no longer includes a GitHub Actions workflow.

Run **`npm run verify` before pushing**. It retains every validation step from
the former CI workflow and stops with a nonzero exit code on failure. This
includes formatting (`prettier --check`), which `lint` does not cover.

For live feedback while editing, run **`npm run test:watch`** in a terminal.
Vitest displays passing/failing tests and reruns affected tests when files change.
The shared protocol package is rebuilt alongside it; changes to its built
output rerun the selected tests so consumers do not keep testing stale code.
Press **Ctrl+C** to stop both watchers. To focus on an area:

```bash
npm run test:watch -- --project=services apps/host/src/auth/public-signin.test.ts
```

Suites that drive real Git, PowerShell or Node processes are in the
`services-process` project instead, which runs after the others so it does not
starve them; select it the same way.

For a browser-readable coverage report, run **`npm run test:coverage`** and open
`coverage/index.html`. Coverage output is local and ignored by Git.

**`npm run test:e2e`** builds the workspace, starts the built Host on a
disposable database with a fake Node feeding it events, and drives the UI in
headless Microsoft Edge: opening and paging long transcripts, following output,
prompt jumps, focus, reconnects, and rapid switching. It needs an installed Edge,
or another Playwright channel such as `chrome` set in `FLEET_E2E_BROWSER`, so it
is not part of `npm run verify`; run it when changing transcripts, scrolling, or
the live connection. The UI unit tests cannot cover these: jsdom has no layout,
so they replace the virtual list with one that renders every row.

These commands provide local monitoring, not automatic remote push/PR checks or
a Linux runner. A hosted equivalent requires a separately configured CI system,
such as an approved Azure DevOps pipeline, or an organization-owned Microsoft
GitHub repository with suitable runners. No external pipeline is provisioned here.

Startup is seed-free. SQLite creates its schema and empty data file on first
launch.
