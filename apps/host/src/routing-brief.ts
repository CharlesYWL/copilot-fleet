import type { Run } from "@fleet/protocol";
import type { RoutingBrief, RoutingTaskContext } from "./decision-provider.js";

/**
 * What the decision model reads is a short, human-shaped description of the
 * work, not the worker's brief.
 *
 * The orchestrator writes a brief for the worker, so it is full of commit
 * hashes, absolute paths, digests and links. None of that says what kind of
 * work this is, and the decision model has a small context. Identifiers are
 * replaced with short placeholders and every field is capped before the
 * request is built; the worker's own prompt is never touched.
 */
export const ROUTING_FIELD_LIMITS = {
  title: 200,
  deliverable: 2_000,
  scope: 1_500,
  verify: 1_000,
  taskName: 120,
  taskObjective: 600,
  taskPhase: 80,
  taskPlan: 300,
} as const;

/** Raw text is bounded first so the replacements below never scan megabytes. */
const MAX_RAW_CHARACTERS = 50_000;

const replacements: ReadonlyArray<readonly [RegExp, string]> = [
  [/https?:\/\/([^\s/)>\]"'`]+)[^\s)>\]"'`]*/gi, "<url:$1>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  [/\\\\[\w.$-]+\\[^\s"'`<>|?*,;)]+/g, "<path>"],
  [/\b[A-Za-z]:[\\/][^\s"'`<>|?*,;)]+/g, "<path>"],
  [/(?<![\w/<:.-])\/(?:[\w.@%+~-]+\/)+[\w.@%+~-]+/g, "<path>"],
  // Digests and full hashes, even when glued to the word before them.
  [/[0-9a-f]{24,}/gi, "<hash>"],
  // Short hashes need a digit and a letter, so plain numbers and words survive.
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,23}\b/gi, "<hash>"],
];

/** Keeps the start and the end, which is where a brief states and then checks the work. */
export const clipText = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  const marker = " … ";
  const keep = Math.max(0, limit - marker.length);
  const head = Math.ceil(keep * 0.7);
  const tail = keep - head;
  const isHighSurrogate = (index: number) => {
    const code = text.charCodeAt(index);
    return code >= 0xd800 && code <= 0xdbff;
  };
  const isLowSurrogate = (index: number) => {
    const code = text.charCodeAt(index);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  const headEnd = head > 0 && isHighSurrogate(head - 1) ? head - 1 : head;
  const tailStart = text.length - tail;
  const safeTailStart = tail > 0 && isLowSurrogate(tailStart) ? tailStart + 1 : tailStart;
  return `${text.slice(0, headEnd)}${marker}${text.slice(safeTailStart)}`;
};

export const sanitizeRoutingText = (text: string, limit: number): string => {
  let value = clipText(text, MAX_RAW_CHARACTERS);
  for (const [pattern, replacement] of replacements)
    value = value.replace(pattern, replacement);
  value = value
    .replace(/\r/g, "")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clipText(value, limit);
};

const sanitizeTaskContext = (task: RoutingTaskContext): RoutingTaskContext => ({
  name: sanitizeRoutingText(task.name, ROUTING_FIELD_LIMITS.taskName),
  objective: sanitizeRoutingText(task.objective, ROUTING_FIELD_LIMITS.taskObjective),
  ...(task.phase
    ? { phase: sanitizeRoutingText(task.phase, ROUTING_FIELD_LIMITS.taskPhase) }
    : {}),
  ...(task.plan
    ? { plan: sanitizeRoutingText(task.plan, ROUTING_FIELD_LIMITS.taskPlan) }
    : {}),
});

/** The brief exactly as the decision model will see it. */
export const prepareRoutingBrief = (brief: RoutingBrief): RoutingBrief => ({
  category: brief.category,
  title: sanitizeRoutingText(brief.title, ROUTING_FIELD_LIMITS.title),
  deliverable: sanitizeRoutingText(brief.deliverable, ROUTING_FIELD_LIMITS.deliverable),
  scope: sanitizeRoutingText(brief.scope, ROUTING_FIELD_LIMITS.scope),
  verify: sanitizeRoutingText(brief.verify, ROUTING_FIELD_LIMITS.verify),
  ...(brief.taskContext ? { taskContext: sanitizeTaskContext(brief.taskContext) } : {}),
});

/**
 * What the task is for and which phase this step serves, from the task record
 * the Host already keeps. The orchestrator is not asked for anything extra.
 */
export const routingTaskContext = (
  run: Pick<Run, "name" | "objective" | "phases" | "phaseIndex">,
): RoutingTaskContext => {
  const phaseName = run.phases[run.phaseIndex];
  return {
    name: run.name,
    objective: run.objective,
    ...(phaseName
      ? { phase: `${run.phaseIndex + 1} of ${run.phases.length}: ${phaseName}` }
      : {}),
    ...(run.phases.length > 1 ? { plan: run.phases.join(" → ") } : {}),
  };
};
