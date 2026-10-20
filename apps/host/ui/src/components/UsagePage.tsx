import { useEffect, useState } from "react";
import {
  Button,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { usageAmountKeys, type UsageReport } from "@fleet/protocol";
import { api } from "../hooks/useFleet";

type UsageFilters = {
  period: string;
  from: string;
  to: string;
  groupBy: string;
  nodeId: string;
  taskId: string;
  backend: string;
  role: string;
};
const initialFilters: UsageFilters = {
  period: "week",
  from: "",
  to: "",
  groupBy: "day",
  nodeId: "",
  taskId: "",
  backend: "",
  role: "",
};
const storageKey = "fleet.usage.filters";
const readFilters = (): UsageFilters => {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (!value || typeof value !== "object") return initialFilters;
    return Object.fromEntries(
      Object.entries(initialFilters).map(([key, fallback]) => [
        key,
        typeof (value as Record<string, unknown>)[key] === "string"
          ? (value as Record<string, string>)[key]
          : fallback,
      ]),
    ) as UsageFilters;
  } catch {
    return initialFilters;
  }
};
const localDate = (text: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
    throw new Error("Choose valid start and end dates.");
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(year!, month! - 1, day!);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month! - 1 ||
    date.getDate() !== day
  )
    throw new Error("Choose valid start and end dates.");
  return date;
};
export const usageQuery = (filters: UsageFilters, now = new Date()): string => {
  const query = new URLSearchParams({
    groupBy: filters.groupBy,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  });
  if (filters.period === "custom") {
    const from = localDate(filters.from);
    const to = localDate(filters.to);
    if (from > to) throw new Error("Start date must not be after end date.");
    to.setDate(to.getDate() + 1);
    query.set("from", from.toISOString());
    query.set("to", to.toISOString());
  } else if (filters.period !== "all") {
    const days = filters.period === "day" ? 1 : filters.period === "month" ? 30 : 7;
    query.set("from", new Date(now.getTime() - days * 86_400_000).toISOString());
    query.set("to", now.toISOString());
  }
  for (const key of ["nodeId", "taskId", "backend", "role"] as const)
    if (filters[key]) query.set(key, filters[key]);
  return `/api/usage?${query}`;
};
const useStyles = makeStyles({
  page: {
    flex: 1,
    minWidth: 0,
    overflowY: "auto",
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    gap: "20px",
    "@media (max-width: 767px)": { padding: "14px" },
  },
  heading: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "16px",
  },
  filters: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
    gap: "12px",
  },
  summary: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "16px",
  },
  metric: {
    padding: "20px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  value: {
    fontSize: tokens.fontSizeHero800,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
    lineHeight: "1.3",
  },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  notice: {
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    paddingLeft: "12px",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  table: {
    overflowX: "auto",
    flexShrink: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  number: { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  error: { color: tokens.colorPaletteRedForeground1 },
});
const format = (value: number | null): string =>
  value === null
    ? "—"
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
const detailLabels = {
  inputTokens: "Input",
  outputTokens: "Output",
  cacheReadTokens: "Cache read",
  cacheWriteTokens: "Cache write",
  reasoningTokens: "Reasoning",
};

export const UsagePage = () => {
  const styles = useStyles();
  const [filters, setFilters] = useState<UsageFilters>(readFilters);
  const [report, setReport] = useState<UsageReport>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const handleFilter = (key: keyof UsageFilters, value: string) =>
    setFilters((previous) => ({ ...previous, [key]: value }));
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(filters));
    } catch {
      /* Storage is optional. */
    }
    const controller = new AbortController();
    let pending = false;
    setReport(undefined);
    setLoading(true);
    const load = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const path = usageQuery(filters);
        const next = await api<UsageReport>(path, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setReport(next);
          setError(undefined);
        }
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "Could not load usage.");
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [filters, refresh]);
  const details = usageAmountKeys.filter(
    (key): key is keyof typeof detailLabels =>
      key in detailLabels && report?.totals[key] != null,
  );
  return (
    <main className={styles.page} aria-label="Usage summary">
      <div className={styles.heading}>
        <div>
          <Text as="h1" size={700} weight="semibold">
            Usage
          </Text>
          <p className={styles.muted}>
            AI credits and tokens across sessions, including Orchestrators.
          </p>
        </div>
        <Button onClick={() => setRefresh((value) => value + 1)}>Refresh</Button>
      </div>
      <div className={styles.filters}>
        <Field label="Period">
          <Select
            value={filters.period}
            onChange={(event) => handleFilter("period", event.target.value)}
          >
            <option value="day">Last 24 hours</option>
            <option value="week">Last 7 days</option>
            <option value="month">Last 30 days</option>
            <option value="all">All recorded history</option>
            <option value="custom">Custom dates</option>
          </Select>
        </Field>
        {filters.period === "custom" && (
          <>
            <Field label="Start date">
              <Input
                type="date"
                value={filters.from}
                onChange={(_, data) => handleFilter("from", data.value)}
              />
            </Field>
            <Field label="End date">
              <Input
                type="date"
                value={filters.to}
                onChange={(_, data) => handleFilter("to", data.value)}
              />
            </Field>
          </>
        )}
        <Field label="Group by">
          <Select
            value={filters.groupBy}
            onChange={(event) => handleFilter("groupBy", event.target.value)}
          >
            <option value="day">Day</option>
            <option value="machine">Machine</option>
            <option value="task">Task</option>
            <option value="session">Session</option>
          </Select>
        </Field>
        <Field label="Machine">
          <Select
            value={filters.nodeId}
            onChange={(event) => handleFilter("nodeId", event.target.value)}
          >
            <option value="">All machines</option>
            {report?.machines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Task">
          <Select
            value={filters.taskId}
            onChange={(event) => handleFilter("taskId", event.target.value)}
          >
            <option value="">All tasks</option>
            {report?.tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Backend">
          <Select
            value={filters.backend}
            onChange={(event) => handleFilter("backend", event.target.value)}
          >
            <option value="">Copilot + Hermes</option>
            <option value="copilot">Copilot</option>
            <option value="hermes">Hermes</option>
          </Select>
        </Field>
        <Field label="Role">
          <Select
            value={filters.role}
            onChange={(event) => handleFilter("role", event.target.value)}
          >
            <option value="">All roles</option>
            <option value="lead">Orchestrator</option>
            <option value="worker">Worker</option>
            <option value="reviewer">Reviewer</option>
            <option value="standalone">Standalone</option>
          </Select>
        </Field>
      </div>
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
      {loading && <Spinner label="Loading usage" size="small" />}
      {report && (
        <>
          <div className={styles.summary}>
            <section className={styles.metric} aria-label="AI credits">
              <Text weight="semibold">AI credits</Text>
              <span className={styles.value}>
                {report.totals.aiCredits === null
                  ? filters.backend === "hermes"
                    ? "N/A"
                    : "Unavailable"
                  : format(report.totals.aiCredits)}
              </span>
              <Text className={styles.muted}>
                Copilot only · {report.coverage.creditSessions}/{report.coverage.sessions}{" "}
                sessions reporting
              </Text>
            </section>
            <section className={styles.metric} aria-label="Total tokens">
              <Text weight="semibold">Total tokens</Text>
              <span className={styles.value}>
                {report.totals.totalTokens === null
                  ? "Unavailable"
                  : format(report.totals.totalTokens)}
              </span>
              <Text className={styles.muted}>
                Copilot + Hermes · {report.coverage.tokenSessions}/
                {report.coverage.sessions} sessions reporting
              </Text>
            </section>
          </div>
          <div className={styles.notice}>
            <Text className={styles.muted}>
              Last reported:{" "}
              {report.coverage.lastReportedAt
                ? new Date(report.coverage.lastReportedAt).toLocaleString()
                : "No readings yet"}
              . Refreshes every 5 seconds. Timezone:{" "}
              {Intl.DateTimeFormat().resolvedOptions().timeZone}.
            </Text>
            <Text className={styles.muted}>
              Task totals exclude shared Orchestrator spending. Missing metrics are
              unavailable, not zero.
            </Text>
            {(report.coverage.openingAiCredits > 0 ||
              report.coverage.openingTokens > 0) && (
              <Text className={styles.muted}>
                Opening balances: {format(report.coverage.openingAiCredits)} credits /{" "}
                {format(report.coverage.openingTokens)} tokens. Included only in all-time
                totals; their dates are unknown.
              </Text>
            )}
            {(report.coverage.unallocatedAiCredits > 0 ||
              report.coverage.unallocatedTokens > 0) && (
              <Text className={styles.muted}>
                Boundary-overlapping intervals:{" "}
                {format(report.coverage.unallocatedAiCredits)} credits /{" "}
                {format(report.coverage.unallocatedTokens)} tokens, excluded because their
                exact period is unknown.
              </Text>
            )}
            {report.coverage.regressions > 0 && (
              <Text className={styles.error}>
                {report.coverage.regressions} counter regressions require reconciliation;
                affected readings were excluded.
              </Text>
            )}
          </div>
          {report.rows.length === 0 ? (
            <Text>
              No usage readings allocated to this selection. Start or continue a supported
              session, or choose a wider period.
            </Text>
          ) : (
            <div className={styles.table}>
              <Table aria-label="Usage breakdown">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>
                      {filters.groupBy === "day"
                        ? "Day"
                        : filters.groupBy === "machine"
                          ? "Machine"
                          : filters.groupBy === "task"
                            ? "Task"
                            : "Session"}
                    </TableHeaderCell>
                    <TableHeaderCell>Sessions</TableHeaderCell>
                    <TableHeaderCell>AI credits</TableHeaderCell>
                    <TableHeaderCell>Total tokens</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.rows.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell>{row.label}</TableCell>
                      <TableCell>{row.sessions}</TableCell>
                      <TableCell className={styles.number}>
                        {row.backend === "hermes" ? "N/A" : format(row.aiCredits)}
                      </TableCell>
                      <TableCell className={styles.number}>
                        {format(row.totalTokens)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {details.length > 0 && (
            <details>
              <summary>Source-reported token details</summary>
              <p className={styles.muted}>
                These counters can overlap and are not added to total tokens.
              </p>
              <div className={styles.table}>
                <Table aria-label="Token details">
                  <TableHeader>
                    <TableRow>
                      {details.map((key) => (
                        <TableHeaderCell key={key}>{detailLabels[key]}</TableHeaderCell>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      {details.map((key) => (
                        <TableCell key={key}>{format(report.totals[key])}</TableCell>
                      ))}
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </details>
          )}
        </>
      )}
    </main>
  );
};
