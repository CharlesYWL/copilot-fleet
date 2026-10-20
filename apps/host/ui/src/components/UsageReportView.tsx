import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import type { UsageReport } from "@fleet/protocol";
import { exactUsageAmount, formatUsageAmount } from "../lib/usage-format";

const monoFont = '"Cascadia Mono", "SFMono-Regular", Consolas, monospace';
const detailCategories = [
  { key: "inputTokens", label: "Input", color: tokens.colorBrandForeground1 },
  { key: "outputTokens", label: "Output", color: tokens.colorPaletteGreenForeground2 },
  {
    key: "cacheReadTokens",
    label: "Cache read",
    color: tokens.colorPalettePurpleForeground2,
  },
  {
    key: "cacheWriteTokens",
    label: "Cache write",
    color: tokens.colorPaletteTealForeground2,
  },
  { key: "reasoningTokens", label: "Reasoning", color: tokens.colorNeutralForeground3 },
] as const;

const useStyles = makeStyles({
  summary: {
    display: "grid",
    gridTemplateColumns: "1.15fr 1fr 0.85fr",
    paddingTop: "32px",
    paddingBottom: "32px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    "@media (max-width: 900px)": { gridTemplateColumns: "1fr", gap: "24px" },
  },
  metric: {
    minWidth: 0,
    paddingLeft: "28px",
    paddingRight: "28px",
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    ":first-child": { paddingLeft: 0, borderLeftWidth: 0 },
    ":last-child": { paddingRight: 0 },
    "@media (max-width: 900px)": { paddingLeft: 0, paddingRight: 0, borderLeftWidth: 0 },
  },
  eyebrow: {
    marginTop: 0,
    marginBottom: "16px",
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  metricValue: {
    fontFamily: monoFont,
    fontVariantNumeric: "tabular-nums",
    fontSize: "clamp(32px, 4.6vw, 70px)",
    lineHeight: "1.2",
    letterSpacing: "-0.06em",
    overflowWrap: "anywhere",
  },
  accent: { color: tokens.colorBrandForeground1 },
  description: {
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    lineHeight: "1.7",
    marginTop: "12px",
    marginBottom: 0,
  },
  analysis: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 0.85fr) minmax(0, 1.35fr)",
    gap: "48px",
    paddingTop: "32px",
    paddingBottom: "32px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    "@media (max-width: 1000px)": { gridTemplateColumns: "1fr", gap: "32px" },
  },
  section: { minWidth: 0 },
  headingRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "8px",
    marginBottom: "20px",
  },
  heading: {
    margin: 0,
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: "24px",
    lineHeight: "1.3",
    fontWeight: 400,
    letterSpacing: "-0.02em",
  },
  caption: { color: tokens.colorNeutralForeground3, fontSize: "11px" },
  details: { margin: 0, display: "grid", gap: "16px" },
  detailRow: { display: "grid", gridTemplateColumns: "1fr auto", gap: "8px" },
  detailLabel: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" },
  swatch: { width: "8px", height: "8px", borderRadius: "2px", flexShrink: 0 },
  detailValue: { margin: 0, fontSize: "13px", fontFamily: monoFont },
  detailTrack: {
    gridColumn: "1 / -1",
    height: "4px",
    backgroundColor: tokens.colorNeutralBackground6,
    borderRadius: "2px",
    overflow: "hidden",
  },
  detailBar: { height: "100%", borderRadius: "2px" },
  chartScroll: {
    overflowX: "auto",
    paddingBottom: "8px",
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "4px",
    },
  },
  chart: { display: "flex", alignItems: "stretch", gap: "12px", minHeight: "212px" },
  day: {
    flex: "1 0 52px",
    minWidth: "52px",
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "flex-end",
    textAlign: "center",
    borderRadius: "3px",
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  dayValue: {
    fontFamily: monoFont,
    fontSize: "11px",
    marginBottom: "10px",
    whiteSpace: "nowrap",
  },
  barArea: {
    height: "142px",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
  },
  dayBar: {
    width: "100%",
    maxWidth: "76px",
    backgroundColor: tokens.colorBrandBackground,
    borderTopLeftRadius: "3px",
    borderTopRightRadius: "3px",
  },
  peakBar: { backgroundColor: tokens.colorBrandForeground1 },
  unknownDay: { color: tokens.colorNeutralForeground3, fontSize: "18px" },
  dayLabel: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: "10px",
    marginTop: "8px",
    color: tokens.colorNeutralForeground3,
    fontFamily: monoFont,
    fontSize: "10px",
  },
  breakdown: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.65fr) minmax(240px, 0.85fr)",
    gap: "40px",
    paddingTop: "32px",
    paddingBottom: "28px",
    "@media (max-width: 1100px)": { gridTemplateColumns: "1fr", gap: "28px" },
  },
  tableScroll: {
    overflowX: "auto",
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "4px",
    },
  },
  table: { minWidth: "520px", tableLayout: "auto" },
  labelCell: { overflowWrap: "anywhere", minWidth: "130px" },
  numericCell: {
    textAlign: "right",
    fontFamily: monoFont,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  scope: {
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: "24px",
    borderRadius: "8px",
    alignSelf: "start",
  },
  scopeText: {
    fontSize: "13px",
    lineHeight: "1.8",
    color: tokens.colorNeutralForeground2,
    marginTop: "14px",
    marginBottom: 0,
  },
  accountingNotice: {
    marginTop: "16px",
    padding: "12px 16px",
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: "13px",
    lineHeight: "1.7",
  },
  warning: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: "13px",
    lineHeight: "1.7",
  },
  footer: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: "8px 24px",
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    paddingTop: "16px",
    paddingBottom: "24px",
    color: tokens.colorNeutralForeground3,
    fontSize: "11px",
    lineHeight: "1.7",
  },
});

const UsageNumber = ({
  value,
  unit,
  className,
}: {
  value: number | null;
  unit: string;
  className?: string;
}) => {
  const exact =
    value === null ? `${unit} unavailable` : `${exactUsageAmount(value)} ${unit}`;
  return (
    <span className={className} title={exact} aria-label={exact}>
      {formatUsageAmount(value)}
    </span>
  );
};

type UsageReportViewProps = {
  report: UsageReport;
  dailyReport: UsageReport;
  groupBy: string;
  backend: string;
};

export const UsageReportView = ({
  report,
  dailyReport,
  groupBy,
  backend,
}: UsageReportViewProps) => {
  const styles = useStyles();
  const datedRows = dailyReport.rows.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.key));
  const undatedRows = dailyReport.rows.filter(
    (row) => !/^\d{4}-\d{2}-\d{2}$/.test(row.key),
  );
  const largestDay = datedRows.reduce(
    (largest, row) => Math.max(largest, row.totalTokens ?? 0),
    0,
  );
  const largestDetail = detailCategories.reduce(
    (largest, { key }) => Math.max(largest, report.totals[key] ?? 0),
    0,
  );
  const hasDetails = detailCategories.some(({ key }) => report.totals[key] !== null);
  const groupLabel =
    groupBy === "machine"
      ? "Machine"
      : groupBy === "task"
        ? "Task"
        : groupBy === "session"
          ? "Session"
          : "Day";
  const coverage = report.coverage;

  return (
    <>
      <div className={styles.summary}>
        <section className={styles.metric} aria-label="Total tokens">
          <p className={styles.eyebrow}>Total tokens</p>
          <div className={mergeClasses(styles.metricValue, styles.accent)}>
            {report.totals.totalTokens === null ? (
              "Unavailable"
            ) : (
              <UsageNumber value={report.totals.totalTokens} unit="tokens" />
            )}
          </div>
          <p className={styles.description}>
            Reported consumption ·{" "}
            {backend === "copilot"
              ? "Copilot"
              : backend === "hermes"
                ? "Hermes"
                : "Copilot + Hermes"}
          </p>
        </section>
        <section className={styles.metric} aria-label="AI credits">
          <p className={styles.eyebrow}>AI credits</p>
          <div className={styles.metricValue}>
            {report.totals.aiCredits === null ? (
              backend === "hermes" ? (
                "N/A"
              ) : (
                "Unavailable"
              )
            ) : (
              <UsageNumber value={report.totals.aiCredits} unit="AI credits" />
            )}
          </div>
          <p className={styles.description}>
            Copilot only · {coverage.creditSessions}/{coverage.sessions} sessions
            reporting
          </p>
        </section>
        <section className={styles.metric} aria-label="Token reporting coverage">
          <p className={styles.eyebrow}>Token reporting coverage</p>
          <div className={styles.metricValue}>
            {coverage.sessions
              ? `${Math.round((coverage.tokenSessions / coverage.sessions) * 100)}%`
              : "—"}
          </div>
          <p className={styles.description}>
            {coverage.tokenSessions}/{coverage.sessions} sessions reporting tokens
          </p>
        </section>
      </div>

      {(coverage.legacyHermesSessions ?? 0) > 0 && (
        <div className={styles.accountingNotice} role="status">
          <p>
            {coverage.legacyHermesSessions} Hermes{" "}
            {coverage.legacyHermesSessions === 1 ? "session has" : "sessions have"}{" "}
            incompatible legacy readings that are excluded from totals. Refreshed native
            balances enter as undated opening balances; period breakdowns from the old
            mixed counters are unavailable.
          </p>
          {(coverage.pendingHermesSessions ?? 0) > 0 && (
            <p>
              {coverage.pendingHermesSessions}{" "}
              {coverage.pendingHermesSessions === 1 ? "session has" : "sessions have"} no
              corrected native reading before this report's end. Totals remain partial.
              Update affected Nodes for future readings; closed legacy sessions are not
              automatically rescanned.
            </p>
          )}
        </div>
      )}
      <div className={styles.analysis}>
        <section className={styles.section} aria-label="Token details">
          <div className={styles.headingRow}>
            <h2 className={styles.heading}>Token details</h2>
            <span className={styles.caption}>Normalized source counters</span>
          </div>
          {hasDetails ? (
            <dl className={styles.details}>
              {detailCategories.map(({ key, label, color }) => (
                <div key={key} className={styles.detailRow}>
                  <dt className={styles.detailLabel}>
                    <span
                      className={styles.swatch}
                      style={{ backgroundColor: color }}
                      aria-hidden="true"
                    />
                    {label}
                  </dt>
                  <dd className={styles.detailValue}>
                    <UsageNumber value={report.totals[key]} unit="tokens" />
                  </dd>
                  <div className={styles.detailTrack} aria-hidden="true">
                    <div
                      className={styles.detailBar}
                      style={{
                        backgroundColor: color,
                        width: `${largestDetail ? ((report.totals[key] ?? 0) / largestDetail) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </dl>
          ) : (
            <p className={styles.description}>
              Token details are unavailable for this selection. Supported backends may
              report input, output, cache, and reasoning counters.
            </p>
          )}
          <p className={styles.description}>
            These counters can overlap: input includes cached input, and output includes
            reasoning where reported. They are not added together. Bars are relative to
            the largest detail counter, not shares of total tokens.
          </p>
        </section>

        <section className={styles.section} aria-label="Daily usage">
          <div className={styles.headingRow}>
            <h2 className={styles.heading}>Daily usage</h2>
            <span className={styles.caption}>Tokens · K / M / B</span>
          </div>
          {datedRows.length > 0 ? (
            <div
              className={styles.chartScroll}
              tabIndex={0}
              role="region"
              aria-label="Daily token chart; scroll for more dates"
            >
              <div className={styles.chart}>
                {datedRows.map((row) => {
                  const description = `${row.key}: ${row.totalTokens === null ? "token reading unavailable" : `${exactUsageAmount(row.totalTokens)} tokens`}`;
                  return (
                    <div
                      key={row.key}
                      className={styles.day}
                      role="img"
                      tabIndex={0}
                      aria-label={description}
                      title={description}
                    >
                      <span className={styles.dayValue}>
                        {formatUsageAmount(row.totalTokens)}
                      </span>
                      <div className={styles.barArea} aria-hidden="true">
                        {row.totalTokens === null ? (
                          <span className={styles.unknownDay}>—</span>
                        ) : (
                          <div
                            className={mergeClasses(
                              styles.dayBar,
                              largestDay > 0 &&
                                row.totalTokens === largestDay &&
                                styles.peakBar,
                            )}
                            style={{
                              height: `${largestDay ? (row.totalTokens / largestDay) * 142 : 0}px`,
                              minHeight: row.totalTokens > 0 ? "2px" : 0,
                            }}
                          />
                        )}
                      </div>
                      <span className={styles.dayLabel}>
                        {row.key.slice(0, 4)}
                        <br />
                        {row.key.slice(5).replace("-", "/")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className={styles.description}>
              No daily readings allocated to this selection. Continue a supported session
              or choose a wider period.
            </p>
          )}
          <p className={styles.description}>
            Daily totals use the selected timezone and filters. Missing dates have no
            allocated readings, not confirmed zero usage. Small positive values use a
            minimum visible bar.
          </p>
          {undatedRows.map((row) => (
            <p className={styles.description} key={row.key}>
              <UsageNumber value={row.totalTokens} unit="tokens" /> tokens /{" "}
              {backend === "hermes" ? (
                "N/A"
              ) : (
                <UsageNumber value={row.aiCredits} unit="AI credits" />
              )}{" "}
              credits · {row.label.toLowerCase()} · excluded from dated bars.
            </p>
          ))}
        </section>
      </div>

      <div className={styles.breakdown}>
        <section className={styles.section} aria-label="Usage breakdown">
          <div className={styles.headingRow}>
            <h2 className={styles.heading}>Usage by {groupLabel.toLowerCase()}</h2>
            <span className={styles.caption}>{report.rows.length} groups</span>
          </div>
          {report.rows.length === 0 ? (
            <p className={styles.description}>
              No usage readings allocated to this selection. Start or continue a supported
              session, or choose a wider period.
            </p>
          ) : (
            <div
              className={styles.tableScroll}
              tabIndex={0}
              role="region"
              aria-label="Scrollable usage table"
            >
              <Table className={styles.table} aria-label="Usage breakdown">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>{groupLabel}</TableHeaderCell>
                    <TableHeaderCell className={styles.numericCell}>
                      Sessions
                    </TableHeaderCell>
                    <TableHeaderCell className={styles.numericCell}>
                      AI credits
                    </TableHeaderCell>
                    <TableHeaderCell className={styles.numericCell}>
                      Total tokens
                    </TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.rows.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell className={styles.labelCell}>{row.label}</TableCell>
                      <TableCell className={styles.numericCell}>{row.sessions}</TableCell>
                      <TableCell className={styles.numericCell}>
                        {backend === "hermes" || row.backend === "hermes" ? (
                          "N/A"
                        ) : (
                          <UsageNumber value={row.aiCredits} unit="AI credits" />
                        )}
                      </TableCell>
                      <TableCell className={styles.numericCell}>
                        <UsageNumber value={row.totalTokens} unit="tokens" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <aside className={styles.scope}>
          <h2 className={styles.heading}>Reporting scope</h2>
          <p className={styles.scopeText}>
            All Fleet-managed sessions, including Orchestrators. Task totals exclude
            shared Orchestrator spending, which has its own group.
          </p>
          <p className={styles.scopeText}>
            AI credits are reported by Copilot; Hermes credits are not applicable. Missing
            metrics are unavailable, not zero. Context-window occupancy is excluded.
          </p>
          {(coverage.openingAiCredits > 0 || coverage.openingTokens > 0) && (
            <p className={styles.scopeText}>
              Opening balances:{" "}
              <UsageNumber value={coverage.openingAiCredits} unit="AI credits" /> credits
              / <UsageNumber value={coverage.openingTokens} unit="tokens" /> tokens.
              Included only in all-time totals; their dates are unknown.
            </p>
          )}
          {(coverage.unallocatedAiCredits > 0 || coverage.unallocatedTokens > 0) && (
            <p className={styles.scopeText}>
              Boundary-overlapping intervals:{" "}
              <UsageNumber value={coverage.unallocatedAiCredits} unit="AI credits" />{" "}
              credits / <UsageNumber value={coverage.unallocatedTokens} unit="tokens" />{" "}
              tokens, excluded because their exact period is unknown.
            </p>
          )}
          {coverage.regressions > 0 && (
            <p className={styles.warning} role="status">
              {coverage.regressions} counter regressions require reconciliation; affected
              readings were excluded.
            </p>
          )}
        </aside>
      </div>

      <footer className={styles.footer}>
        <span>
          Source: cumulative session snapshots · Refreshes every 5 seconds.
          <br />
          Last reported:{" "}
          {coverage.lastReportedAt
            ? new Date(coverage.lastReportedAt).toLocaleString("en-US")
            : "No readings yet"}
        </span>
        <span>
          K = 1,000 · M = 1,000,000 · B = 1,000,000,000
          <br />
          Rounded display · Hover over values for exact readings.
        </span>
      </footer>
    </>
  );
};
