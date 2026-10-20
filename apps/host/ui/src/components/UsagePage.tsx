import { useEffect, useState } from "react";
import {
  Button,
  Field,
  Input,
  Select,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowClockwise20Regular } from "@fluentui/react-icons";
import type { UsageReport } from "@fleet/protocol";
import { api } from "../hooks/useFleet";
import { UsageReportView } from "./UsageReportView";
import { UsageBackfillButton } from "./UsageBackfillButton";

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
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  report: {
    maxWidth: "1440px",
    marginLeft: "auto",
    marginRight: "auto",
    padding: "28px 40px",
    "@media (max-width: 767px)": { padding: "20px 16px" },
  },
  masthead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "12px",
    paddingBottom: "18px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  eyebrow: {
    color: tokens.colorNeutralForeground3,
    fontSize: "11px",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
  },
  live: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    color: tokens.colorNeutralForeground2,
    fontSize: "11px",
  },
  liveDot: {
    height: "6px",
    width: "6px",
    borderRadius: "50%",
    backgroundColor: tokens.colorBrandForeground1,
  },
  headingRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "16px",
    marginTop: "28px",
    marginBottom: "24px",
    flexWrap: "wrap",
  },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "8px" },
  heading: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: "clamp(30px, 3.2vw, 44px)",
    fontWeight: 400,
    lineHeight: "1.2",
    letterSpacing: "-0.035em",
    margin: 0,
  },
  subtitle: {
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    lineHeight: "1.7",
    marginTop: "10px",
    marginBottom: 0,
  },
  filters: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
    gap: "12px",
    paddingBottom: "24px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    "@media (max-width: 480px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
  },
  status: { paddingTop: "16px" },
  error: {
    color: tokens.colorPaletteRedForeground1,
    paddingTop: "16px",
    lineHeight: "1.7",
  },
});
const periodLabels: Record<string, string> = {
  day: "Last 24 hours",
  week: "Last 7 days",
  month: "Last 30 days",
  all: "All recorded history",
};
type ReportData = { report: UsageReport; dailyReport: UsageReport };

export const UsagePage = () => {
  const styles = useStyles();
  const [filters, setFilters] = useState<UsageFilters>(readFilters);
  const [data, setData] = useState<ReportData>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const handleRefresh = () => setRefresh((value) => value + 1);
  const handleBackfillCompleted = () => {
    setFilters((previous) => ({
      ...initialFilters,
      groupBy: previous.groupBy,
      period: "all",
      backend: "copilot",
    }));
    handleRefresh();
  };
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
    setData(undefined);
    setError(undefined);
    setLoading(true);
    const load = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const path = usageQuery(filters);
        const options = { signal: controller.signal };
        let next: ReportData;
        if (filters.groupBy === "day") {
          const report = await api<UsageReport>(path, options);
          next = { report, dailyReport: report };
        } else {
          // Reuse the exact range and filters; only the grouping changes.
          const dailyQuery = new URLSearchParams(path.split("?")[1]);
          dailyQuery.set("groupBy", "day");
          const [report, dailyReport] = await Promise.all([
            api<UsageReport>(path, options),
            api<UsageReport>(`/api/usage?${dailyQuery}`, options),
          ]);
          next = { report, dailyReport };
        }
        if (!controller.signal.aborted) {
          setData(next);
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
  const report = data?.report;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const periodLabel =
    filters.period === "custom"
      ? `${filters.from || "Start date"} — ${filters.to || "End date"}`
      : periodLabels[filters.period];

  return (
    <main className={styles.page} aria-label="Usage summary">
      <div className={styles.report}>
        <div className={styles.masthead}>
          <span className={styles.eyebrow}>Fleet / Session accounting</span>
          <span className={styles.live}>
            <span className={styles.liveDot} aria-hidden="true" />
            Live session snapshots
          </span>
        </div>
        <header className={styles.headingRow}>
          <div>
            <h1 className={styles.heading}>Usage report</h1>
            <p className={styles.subtitle}>
              {periodLabel} · Timezone: {timeZone}
              <br />
              AI credits and tokens across sessions, including Orchestrators.
            </p>
          </div>
          <div className={styles.actions}>
            <UsageBackfillButton onCompleted={handleBackfillCompleted} />
            <Button
              icon={<ArrowClockwise20Regular aria-hidden="true" />}
              onClick={handleRefresh}
            >
              Refresh
            </Button>
          </div>
        </header>
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
                  onChange={(_, input) => handleFilter("from", input.value)}
                />
              </Field>
              <Field label="End date">
                <Input
                  type="date"
                  value={filters.to}
                  onChange={(_, input) => handleFilter("to", input.value)}
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
            {data ? "Refresh failed; showing the last successful report. " : ""}
            {error}
          </div>
        )}
        {loading && (
          <div className={styles.status}>
            <Spinner label="Loading usage" size="small" />
          </div>
        )}
        {data && (
          <UsageReportView
            report={data.report}
            dailyReport={data.dailyReport}
            groupBy={filters.groupBy}
            backend={filters.backend}
          />
        )}
      </div>
    </main>
  );
};
