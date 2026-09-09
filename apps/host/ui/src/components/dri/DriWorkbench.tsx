import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import {
  CreateDriSchema,
  type DriEvidence,
  type DriInvestigation,
  type DriPage,
  type DriRecord,
  type DriRecordKind,
  type DriReport,
  type DriAvailability,
} from "@fleet/protocol";
import { api } from "../../hooks/useFleet";
import { useDri } from "../../hooks/useDri";

const useStyles = makeStyles({
  page: {
    flexGrow: 1,
    minWidth: 0,
    padding: "20px",
    overflow: "auto",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  row: { display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" },
  fields: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
    gap: "12px",
    maxWidth: "960px",
  },
  field: { display: "flex", flexDirection: "column", gap: "4px" },
  card: {
    padding: "12px",
    marginBlock: "10px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "6px",
    overflowWrap: "anywhere",
  },
  text: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  tabs: { display: "flex", flexWrap: "wrap", gap: "6px", marginBlock: "12px" },
});
const sections: { name: string; kind: DriRecordKind | "overview" }[] = [
  { name: "Overview", kind: "overview" },
  { name: "Timeline (UTC)", kind: "timeline" },
  { name: "Evidence", kind: "evidence" },
  { name: "Queries", kind: "queries" },
  { name: "Hypotheses", kind: "hypotheses" },
  { name: "Similar incidents", kind: "similar" },
  { name: "Changes / deployments", kind: "changes" },
  { name: "Report", kind: "reports" },
];
type ProfileChoice = { id: string; label: string; version: string };

export function DriWorkbench({ initialId = "" }: { initialId?: string }) {
  const styles = useStyles();
  const [id, setId] = useState(
    initialId || new URLSearchParams(window.location.search).get("dri") || "",
  );
  const [items, setItems] = useState<DriPage<DriInvestigation>>();
  const [listCursor, setListCursor] = useState(0);
  const [listRevision, setListRevision] = useState(0);
  const [profiles, setProfiles] = useState<ProfileChoice[]>([]);
  const [availability, setAvailability] = useState<DriAvailability>({
    fixtureEnabled: false,
    liveRegistration: "embedding_only",
    liveProvidersConfigured: false,
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<DriRecordKind | "overview">("overview");
  const [citation, setCitation] = useState<DriEvidence>();
  const citationHeading = useRef<HTMLHeadingElement>(null);
  const citationTicket = useRef(0);
  const view = useDri(id, section);
  const current = view.detail?.investigation;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api<DriPage<DriInvestigation>>(`/api/dri?limit=25&cursor=${listCursor}`),
      api<{ profiles: ProfileChoice[]; availability?: DriAvailability }>(
        "/api/dri/profiles",
      ),
    ])
      .then(([page, choices]) => {
        if (!cancelled) {
          setItems(page);
          setProfiles(choices.profiles);
          if (choices.availability) setAvailability(choices.availability);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load investigations. Retry to reconnect.");
      });
    return () => {
      cancelled = true;
    };
  }, [listCursor, listRevision]);
  useEffect(() => {
    if (citation) citationHeading.current?.focus();
  }, [citation]);

  const open = (nextId: string) => {
    citationTicket.current++;
    setId(nextId);
    setSection("overview");
    setCitation(undefined);
    view.first();
    const url = new URL(window.location.href);
    if (nextId) url.searchParams.set("dri", nextId);
    else url.searchParams.delete("dri");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const values = new FormData(event.currentTarget);
      const input: Record<string, unknown> = Object.fromEntries(
        [...values].filter(([, value]) => value !== ""),
      );
      const start = input.start,
        end = input.end;
      delete input.start;
      delete input.end;
      if (start || end) input.timeRange = { start, end };
      if (!CreateDriSchema.safeParse(input).success)
        throw new Error(
          "Enter a valid ICM ID/URL and an ordered UTC time range of at most 24 hours.",
        );
      if (
        !input.mode ||
        (input.mode === "fixture" && !availability.fixtureEnabled) ||
        (input.mode === "live" && !availability.liveProvidersConfigured)
      )
        throw new Error(
          "Select an available provider mode. Live adapters are embedding-only, not shipped with the CLI.",
        );
      const investigation = await api<DriInvestigation>("/api/dri", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setCreating(false);
      open(investigation.id);
      setListRevision((value) => value + 1);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to create investigation",
      );
    } finally {
      setBusy(false);
    }
  };
  const mutate = async (operation: string, body?: unknown) => {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/dri/${current.id}/${operation}`, {
        method: ["profile", "retention"].includes(operation) ? "PATCH" : "POST",
        headers: { "if-match": `"${current.revision}"` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      view.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Operation failed");
      view.reload();
    } finally {
      setBusy(false);
    }
  };
  const showCitation = async (evidenceId: string) => {
    const request = ++citationTicket.current;
    try {
      const evidence = await api<DriEvidence>(
        `/api/dri/${id}/evidence/${encodeURIComponent(evidenceId)}`,
      );
      if (request === citationTicket.current && evidence.investigationId === id)
        setCitation(evidence);
    } catch {
      setError("Citation unavailable; refresh the evidence page.");
    }
  };
  const cite = (ids: string[]) =>
    ids.map((evidenceId) => (
      <Button
        key={evidenceId}
        appearance="subtle"
        size="small"
        onClick={() => void showCitation(evidenceId)}
      >
        Evidence {evidenceId.slice(-8)}
      </Button>
    ));

  return (
    <main
      className={styles.page}
      aria-label="DRI investigations"
      aria-busy={busy || view.loading}
    >
      <div className={styles.row}>
        <h1>DRI investigations</h1>
        <Button appearance="primary" onClick={() => setCreating(true)}>
          Create DRI Investigation
        </Button>
        {id && <Button onClick={() => open("")}>All investigations</Button>}
      </div>
      <p>
        Evidence-driven, read-only investigation. Provider access is never implied by
        incident content.
      </p>
      <p>
        Production CLI live adapters are not shipped. Synthetic fixtures require Host
        opt-in; live-provider registration is embedding-only.
      </p>
      {(error || view.error) && (
        <div role="alert">
          {error || view.error}{" "}
          <Button
            onClick={() => {
              setError("");
              view.reload();
              setListRevision((value) => value + 1);
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {creating && (
        <form
          onSubmit={(event) => void create(event)}
          aria-label="Create DRI Investigation"
        >
          <div className={styles.fields}>
            <label className={styles.field}>
              ICM URL or ID (required)
              <input name="icm" required maxLength={512} autoFocus />
            </label>
            <label className={styles.field}>
              Profile
              <select name="profile" defaultValue="auto">
                <option value="auto">Auto (verified ICM ownership only)</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              Provider mode
              <select name="mode" defaultValue="" required>
                <option value="" disabled>
                  Choose an available provider mode
                </option>
                <option value="live" disabled={!availability.liveProvidersConfigured}>
                  Live (embedding-only adapters; not shipped)
                </option>
                <option value="fixture" disabled={!availability.fixtureEnabled}>
                  Synthetic fixture (Host must enable)
                </option>
              </select>
            </label>
            <label className={styles.field}>
              Question or symptom
              <textarea name="question" maxLength={2_000} />
            </label>
            <label className={styles.field}>
              UTC start
              <input name="start" placeholder="ISO 8601 UTC ending in Z" />
            </label>
            <label className={styles.field}>
              UTC end
              <input name="end" placeholder="ISO 8601 UTC ending in Z" />
            </label>
            {[
              ["service", "Service"],
              ["component", "Component"],
              ["telemetryCluster", "Telemetry cluster"],
              ["telemetryDatabase", "Telemetry database"],
              ["artifactRef", "HAR / attachment reference"],
              ["repository", "Repository hint"],
              ["pipeline", "Pipeline hint"],
              ["deployment", "Deployment hint"],
            ].map(([name, label]) => (
              <label key={name} className={styles.field}>
                {label}
                <input name={name} maxLength={160} />
              </label>
            ))}
          </div>
          <p>
            Hints are fingerprinted, not placed in public query context. Do not enter
            credentials or personal/customer content.
          </p>
          <Button
            type="submit"
            disabled={
              busy ||
              (!availability.fixtureEnabled && !availability.liveProvidersConfigured)
            }
          >
            Start investigation
          </Button>{" "}
          <Button onClick={() => setCreating(false)}>Cancel</Button>
        </form>
      )}
      {!id && (
        <section aria-label="Investigation list">
          {!items && !error && <p role="status">Loading investigations…</p>}
          {items?.items.length === 0 && <p>No investigations yet.</p>}
          {items?.items.map((investigation) => (
            <div key={investigation.id} className={styles.card}>
              <Button onClick={() => open(investigation.id)}>
                Open investigation {investigation.id.slice(0, 8)}
              </Button>{" "}
              {investigation.profile.profileId} · {investigation.phase} ·{" "}
              {investigation.status}
            </div>
          ))}
          {listCursor !== 0 && (
            <Button onClick={() => setListCursor(0)}>First page</Button>
          )}
          {items?.nextCursor !== null && items?.nextCursor !== undefined && (
            <Button onClick={() => setListCursor(items.nextCursor!)}>
              Next investigations
            </Button>
          )}
        </section>
      )}
      {id && view.loading && <p role="status">Loading investigation…</p>}
      {current && view.detail && (
        <>
          <h2>Investigation {current.id.slice(0, 8)}</h2>
          <p>
            <strong>
              {current.phase.toUpperCase()} · {current.status}
            </strong>{" "}
            · Revision {current.revision}, generation {current.generation}
          </p>
          <p>
            Linked Run:{" "}
            <a
              href={`#run-${current.runId}`}
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(`run-${current.runId}`)?.scrollIntoView?.();
              }}
            >
              {current.runId}
            </a>
          </p>
          <p>
            Profile: {current.profile.profileId} {current.profile.profileVersion} (
            {current.profile.method}; confidence{" "}
            {Math.round(current.profile.confidence * 100)}%).{" "}
            {current.profile.explanation}
          </p>
          <label>
            <input
              type="checkbox"
              checked={current.legalHold}
              disabled={busy}
              onChange={(event) =>
                void mutate("retention", { legalHold: event.target.checked })
              }
            />{" "}
            Retention legal hold
          </label>
          <label>
            Correct profile (pauses work){" "}
            <select
              aria-label="Correct profile"
              value={current.requestedProfile}
              disabled={busy}
              onChange={(event) =>
                void mutate("profile", { profile: event.target.value })
              }
            >
              <option value="auto">Auto</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.row}>
            <Button
              disabled={busy || ["stopped", "completed"].includes(current.status)}
              onClick={() => void mutate("stop")}
            >
              Stop
            </Button>
            <Button
              disabled={
                busy ||
                !["stopped", "blocked", "failed", "partial"].includes(current.status)
              }
              onClick={() => void mutate("resume")}
            >
              Resume unfinished work
            </Button>
            <Button
              disabled={busy || !["awaiting_review", "partial"].includes(current.status)}
              onClick={() => void mutate("complete")}
            >
              Approve reviewed report
            </Button>
            <Button onClick={view.reload}>Refresh</Button>
          </div>
          {current.limitation && <p role="status">{current.limitation}</p>}
          <nav className={styles.tabs} aria-label="Investigation sections">
            {sections.map((entry) => (
              <Button
                key={entry.kind}
                appearance={section === entry.kind ? "primary" : "secondary"}
                aria-pressed={section === entry.kind}
                onClick={() => {
                  view.first();
                  setSection(entry.kind);
                }}
              >
                {entry.name}
              </Button>
            ))}
          </nav>
          {section === "overview" ? (
            <section id={`run-${current.runId}`} aria-label="Run and provider progress">
              <h3>Run status: {view.detail.run.state}</h3>
              <h3>Scoped provider workers and dependencies</h3>
              <ul>
                {view.detail.work.map((work) => (
                  <li key={work.id}>
                    {work.role}: {work.state} · depends on{" "}
                    {work.dependsOn.join(", ") || "intake input"} ·{" "}
                    {work.capabilities.join(", ") || "typed validation only"}
                  </li>
                ))}
              </ul>
              <h3>Provider readiness</h3>
              {view.detail.providers.length ? (
                <ul>
                  {view.detail.providers.map((provider) => (
                    <li key={provider.id}>
                      {provider.id}: {provider.readiness} · read-only ·{" "}
                      {provider.capabilities.join(", ")}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  No providers configured. The investigation will remain blocked, without
                  live calls.
                </p>
              )}
            </section>
          ) : (
            <section aria-label={sections.find((entry) => entry.kind === section)?.name}>
              {view.page && (
                <p>
                  Collection snapshot: revision {view.page.revision}, generation{" "}
                  {view.page.generation ?? current.generation}
                  {view.loading ? " (refreshing)" : ""}.
                </p>
              )}
              {!view.loading && view.page?.items.length === 0 && (
                <p>No {section} recorded. Missing evidence is not a negative result.</p>
              )}
              {view.page?.items.map((record) => (
                <article key={record.id} className={styles.card}>
                  <RecordView record={record} cite={cite} />
                </article>
              ))}
              {!view.atStart && <Button onClick={view.first}>First page</Button>}
              {view.page?.nextCursor !== null && view.page?.nextCursor !== undefined && (
                <Button onClick={view.next}>Next page</Button>
              )}
            </section>
          )}
          {citation && (
            <section className={styles.card} aria-label="Evidence citation">
              <h3 ref={citationHeading} tabIndex={-1}>
                Evidence {citation.id.slice(-8)}
              </h3>
              <p>{citation.finding}</p>
              <p>
                {citation.source} · {citation.observedAt} · {citation.completeness}
              </p>
              <Button onClick={() => setCitation(undefined)}>Close citation</Button>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function RecordView({
  record,
  cite,
}: {
  record: DriRecord;
  cite: (ids: string[]) => React.ReactNode;
}) {
  switch (record.kind) {
    case "evidence":
      return (
        <>
          <h3>
            {record.type} · {record.completeness}
          </h3>
          <p>{record.finding}</p>
          <p>
            {record.observedAt} · {record.providerId} · confidence {record.confidence}
          </p>
          <p>{record.limitation}</p>
          {cite([record.id])}
        </>
      );
    case "timeline":
      return (
        <>
          <time>{record.at}</time>
          <p>{record.summary}</p>
          {cite(record.evidenceIds)}
        </>
      );
    case "queries":
      return (
        <>
          <h3>{record.purpose}</h3>
          <p>
            {record.template} · {record.state} · {record.error}
          </p>
          <p>
            {record.timeRange.start} — {record.timeRange.end}
          </p>
          <p>
            Limits: {record.bounds.maxRows} rows / {record.bounds.maxBytes} bytes /{" "}
            {record.bounds.timeoutMs}ms / {record.bounds.maxPages} pages
          </p>
          <p>{record.summary}</p>
          <p>Private parameter values and raw results are not exposed.</p>
        </>
      );
    case "hypotheses":
      return (
        <>
          <h3>
            {record.status} · confidence {record.confidence}
          </h3>
          <p>{record.statement}</p>
          <p>Missing: {record.missingEvidence.join("; ")}</p>
          <p>Falsification: {record.falsifyingEvidence.join("; ")}</p>
          <p>Supporting</p>
          {cite(record.supportingEvidence)}
          <p>Contradicting</p>
          {cite(record.contradictingEvidence)}
        </>
      );
    case "similar":
      return (
        <>
          <h3>
            {record.match} · score {record.score}
          </h3>
          <p>Signals: {record.technicalSignals.join(", ") || "none"}</p>
          <p>{record.priorCause}</p>
          <p>Prior mitigation: {record.priorMitigation}</p>
          <p>{record.applicability}</p>
          {cite(record.evidenceIds)}
        </>
      );
    case "changes":
      return (
        <>
          <h3>
            {record.category} · {record.assessment}
          </h3>
          <time>{record.at}</time>
          <p>{record.summary}</p>
          {cite(record.evidenceIds)}
        </>
      );
    case "reports":
      return <ReportView report={record} cite={cite} />;
    default:
      return <p>{record.kind} metadata available through the paginated API.</p>;
  }
}
export function ReportView({
  report,
  cite,
}: {
  report: DriReport;
  cite: (ids: string[]) => React.ReactNode;
}) {
  return (
    <section aria-label={`Report revision ${report.revision}`}>
      <h3>Immutable report revision {report.revision}</h3>
      {report.sections.map((section) => (
        <section key={section.title}>
          <h4>{section.title}</h4>
          {section.title === "Similar incidents" && section.statement.includes(" | ") ? (
            <table>
              <caption>Technical similar-incident comparison</caption>
              <thead>
                <tr>
                  <th>Match</th>
                  <th>Technical signals</th>
                  <th>Applicability</th>
                </tr>
              </thead>
              <tbody>
                {section.statement
                  .split("\n")
                  .slice(2)
                  .map((row, i) => (
                    <tr key={i}>
                      {row.split(" | ").map((cell, j) => (
                        <td key={j}>{cell}</td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <p style={{ whiteSpace: "pre-wrap" }}>{section.statement}</p>
          )}
          {cite(section.evidenceIds)}
        </section>
      ))}
      <h4>
        Causal chain · {report.causalChain.assessment} · confidence{" "}
        {report.causalChain.confidence}
      </h4>
      {Object.entries(report.causalChain).flatMap(([name, value]) => {
        const claims = Array.isArray(value)
          ? value
          : typeof value === "object"
            ? [value]
            : [];
        return claims.map((claim, index) => (
          <div key={`${name}-${index}`}>
            <strong>{name}</strong>
            <p>{claim.statement}</p>
            {cite(claim.evidenceIds)}
          </div>
        ));
      })}
      <h4>Recommended actions</h4>
      {report.actions.map((action, index) => (
        <div key={index}>
          <strong>{action.kind}</strong>
          <p>{action.statement}</p>
          {cite(action.evidenceIds)}
        </div>
      ))}
    </section>
  );
}
