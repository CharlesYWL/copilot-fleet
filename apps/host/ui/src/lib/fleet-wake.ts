/**
 * Reading the machine turn an orchestrator is woken by.
 *
 * A wake is a prompt only in the mechanical sense: the Host sends it because
 * that is the one way to give a running agent something to read. Nobody typed
 * it. Drawn as a chat bubble it claimed the right-hand column the operator's
 * own words live in, and — being a full transcript of everything that settled —
 * buried the orchestrator's reply under a screen of machine text.
 *
 * So the envelope is parsed back into the two facts a reader wants at a glance
 * (which task came back, and how it went) and the rest is kept for whoever
 * expands the line.
 */

export type WakeSummary = {
  /** The run this result belongs to; an orchestrator may be driving several. */
  task: string;
  /** Phase label with its position, e.g. `Open PR (1/1)`, when the run has phases. */
  phase: string;
  /** `2/12` — how much of the wake budget this turn spent. */
  wakes: string;
  /** Steps that finished, as `title: state`. */
  settled: { title: string; state: string }[];
  /** Titles of steps still out when the wake was written. */
  running: string[];
};

/** Matches the header `wakeEnvelope` writes; see `apps/host/src/orchestrator/briefing.ts`. */
const HEADER =
  /^<fleet-wake\s+task="((?:[^"\\]|\\.)*)"(?:\s+phase="((?:[^"\\]|\\.)*)"\s*(\(\d+\/\d+\))?)?(?:\s+wakes=(\S+?))?>\s*$/;

/** `- Open PR for the fix (implement): succeeded` */
const SETTLED = /^-\s+(.*?)\s*(?:\(([^()]*)\))?\s*:\s*(\S+)\s*$/;

/** `- Open PR for the fix (implement)` — the running list carries no state. */
const RUNNING = /^-\s+(.*?)\s*(?:\(([^()]*)\))?\s*$/;

/**
 * The wake inside `text`, or `undefined` when it is an ordinary prompt.
 *
 * Only the opening tag is required. A wake whose body drifted from the shape
 * this parser expects still deserves the compact line — losing the summary is
 * a worse outcome than showing one with fewer facts in it.
 */
export function parseWake(text: string): WakeSummary | undefined {
  const lines = text.split("\n");
  const header = lines[0] ? HEADER.exec(lines[0].trim()) : null;
  if (!header) return undefined;

  const summary: WakeSummary = {
    task: unquote(header[1] ?? ""),
    phase: [unquote(header[2] ?? ""), header[3] ?? ""].filter(Boolean).join(" "),
    wakes: header[4] ?? "",
    settled: [],
    running: [],
  };

  let section: "settled" | "running" | undefined;
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (line === "</fleet-wake>") break;
    if (line.startsWith("Just finished:")) {
      section = "settled";
      continue;
    }
    if (line.startsWith("Still running:")) {
      section = "running";
      continue;
    }
    // A step's output is written on its own indented line under the bullet,
    // and is exactly the bulk this row exists to keep out of the stream.
    if (!section || !line.startsWith("-")) continue;
    if (section === "settled") {
      const step = SETTLED.exec(line);
      if (step) summary.settled.push({ title: step[1] ?? "", state: step[3] ?? "" });
      continue;
    }
    const step = RUNNING.exec(line);
    if (step) summary.running.push(step[1] ?? "");
  }

  return summary;
}

/** The left half of the row: what happened, in as few words as carry it. */
export function wakeTitle(summary: WakeSummary): string {
  const failed = summary.settled.filter((step) => step.state !== "succeeded").length;
  if (summary.settled.length === 0) return "Worker result received";
  const noun = summary.settled.length === 1 ? "worker" : "workers";
  const count = `${summary.settled.length} ${noun} finished`;
  return failed > 0 ? `${count}, ${failed} not clean` : count;
}

/** The right half: which task, which phase, and how it went. */
export function wakeDetail(summary: WakeSummary): string {
  const parts: string[] = [];
  if (summary.task) parts.push(summary.task);
  if (summary.phase) parts.push(summary.phase);
  for (const step of summary.settled) {
    parts.push(step.title ? `${step.title}: ${step.state}` : step.state);
  }
  if (summary.running.length > 0) parts.push(`${summary.running.length} still running`);
  if (summary.wakes) parts.push(`wake ${summary.wakes}`);
  return parts.join(" · ");
}

/** Undoes the `JSON.stringify` the Host used to write the attribute. */
function unquote(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}
