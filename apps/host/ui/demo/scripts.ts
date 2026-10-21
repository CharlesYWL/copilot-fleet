/**
 * Scripted agent behaviour for the playable showcase.
 *
 * Each script is a list of beats the mock Host plays back with realistic
 * pacing: thoughts stream in small chunks, tools start and finish, and some
 * beats pause for a permission the visitor has to answer.
 */

export type Beat =
  | { kind: "thought"; text: string }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      title: string;
      toolKind: "read" | "edit" | "execute" | "search" | "fetch" | "think";
      detail: string;
      ms?: number;
      response?: string;
    }
  | { kind: "permission"; title: string; toolKind: "edit" | "execute"; detail: string }
  | { kind: "pause"; ms: number };

const words = (text: string): string[] => text.match(/\S+\s*/g) ?? [text];

/** Splits text into the small chunks an agent actually streams. */
export const chunk = (text: string, size = 3): string[] => {
  const tokens = words(text);
  const chunks: string[] = [];
  for (let index = 0; index < tokens.length; index += size) {
    chunks.push(tokens.slice(index, index + size).join(""));
  }
  return chunks;
};

const GENERIC_REPLIES: readonly ((prompt: string) => Beat[])[] = [
  (prompt) => [
    {
      kind: "thought",
      text: `The operator asked: "${prompt.slice(0, 80)}". I'll look at the relevant code before changing anything.`,
    },
    {
      kind: "tool",
      title: "Search repository",
      toolKind: "search",
      detail: `rg -n "${firstKeyword(prompt)}" src`,
      ms: 900,
    },
    {
      kind: "tool",
      title: "Read src/server/routes.ts",
      toolKind: "read",
      detail: "src/server/routes.ts",
      ms: 700,
    },
    {
      kind: "text",
      text: `I found where this lives. Here's the plan:\n\n1. Tighten the input validation in \`routes.ts\`.\n2. Add a regression test that covers the edge case.\n3. Run the focused test suite.\n\nStarting with the change now.`,
    },
    {
      kind: "permission",
      title: "Edit src/server/routes.ts",
      toolKind: "edit",
      detail: "src/server/routes.ts (+14 -3)",
    },
    {
      kind: "tool",
      title: "Run focused tests",
      toolKind: "execute",
      detail: "npm test -- routes",
      ms: 1600,
    },
    {
      kind: "text",
      text: `Done. \`routes.test.ts\` passes (**12 passed**, 0 failed) and the edge case you described is now covered by \`rejects an empty payload\`.\n\nAnything else you'd like me to look at?`,
    },
  ],
  (prompt) => [
    {
      kind: "thought",
      text: `Let me check the current state of the workspace first, then answer "${prompt.slice(0, 60)}".`,
    },
    {
      kind: "tool",
      title: "git status",
      toolKind: "execute",
      detail: "git status --short",
      ms: 600,
    },
    {
      kind: "tool",
      title: "Read package.json",
      toolKind: "read",
      detail: "package.json",
      ms: 500,
    },
    {
      kind: "text",
      text: `Short answer: yes, and it's a small change.\n\n| Area | Status |\n| --- | --- |\n| Build | ✅ clean |\n| Lint | ✅ clean |\n| Tests | ✅ 214 passed |\n\nThe working tree is clean, so I can start whenever you're ready. Want me to open a branch for it?`,
    },
  ],
];

const firstKeyword = (prompt: string): string =>
  prompt
    .split(/\W+/)
    .find((word) => word.length > 4)
    ?.toLowerCase() ?? "handler";

let replyCursor = 0;

/** A plausible response to whatever the visitor typed. */
export const replyTo = (prompt: string): Beat[] => {
  const trimmed = prompt.trim();
  if (trimmed === "/usage") {
    return [
      {
        kind: "text",
        text: "**Session usage**\n\n- Premium requests: 3.5\n- Input tokens: 48,210\n- Output tokens: 6,904\n- Context: 31% of 200k",
      },
    ];
  }
  if (trimmed.startsWith("/")) {
    return [{ kind: "text", text: `Ran \`${trimmed.split(/\s/)[0]}\`. ✔` }];
  }
  const script = GENERIC_REPLIES[replyCursor % GENERIC_REPLIES.length]!;
  replyCursor += 1;
  return script(trimmed);
};

/** What a brand new session does with its first prompt. */
export const firstTurn = (prompt: string): Beat[] => [
  { kind: "pause", ms: 700 },
  ...replyTo(prompt),
];

/** The orchestrator's planning turn for a task the visitor created. */
export const orchestratorPlan = (taskName: string): Beat[] => [
  {
    kind: "thought",
    text: `New task "${taskName}". I need success criteria first, then I'll split the work across the online Nodes.`,
  },
  {
    kind: "tool",
    title: "fleet_list_nodes",
    toolKind: "fetch",
    detail: "3 online · 9 free slots",
    ms: 700,
  },
  {
    kind: "tool",
    title: "fleet_plan_task",
    toolKind: "think",
    detail: `${taskName} · 3 phases · 3 criteria`,
    ms: 900,
  },
  {
    kind: "text",
    text: `Planned **${taskName}** in three phases: *Investigate → Implement → Review*.\n\nI'm dispatching an investigation worker on **devbox-west** and an implementation worker on **build-01** in parallel. I'll check their output against the criteria and hand it back to you for sign-off.`,
  },
  {
    kind: "tool",
    title: "fleet_dispatch",
    toolKind: "execute",
    detail: "investigate → devbox-west",
    ms: 500,
  },
  {
    kind: "tool",
    title: "fleet_dispatch",
    toolKind: "execute",
    detail: "implement → build-01",
    ms: 500,
  },
];

/** What a worker dispatched by the orchestrator streams while it works. */
export const workerTurn = (title: string): Beat[] => [
  {
    kind: "thought",
    text: `Working on "${title}". Reading the code that's involved first.`,
  },
  {
    kind: "tool",
    title: "Search repository",
    toolKind: "search",
    detail: 'rg -n "retry" src',
    ms: 900,
  },
  {
    kind: "tool",
    title: "Read src/client/retry.ts",
    toolKind: "read",
    detail: "src/client/retry.ts",
    ms: 700,
  },
  {
    kind: "tool",
    title: "Edit src/client/retry.ts",
    toolKind: "edit",
    detail: "src/client/retry.ts (+22 -6)",
    ms: 1100,
  },
  {
    kind: "tool",
    title: "Run tests",
    toolKind: "execute",
    detail: "npm test -- retry",
    ms: 1500,
  },
  {
    kind: "text",
    text: `Finished **${title}**. Tests pass (18/18). Summary: added jittered exponential backoff with a 30s ceiling, and a test that pins the retry schedule.`,
  },
];

/** The orchestrator's answer when its workers report back. */
export const orchestratorWrapUp = (taskName: string): Beat[] => [
  {
    kind: "thought",
    text: "Both workers settled cleanly. Checking each success criterion against their evidence.",
  },
  {
    kind: "tool",
    title: "fleet_record_criterion",
    toolKind: "think",
    detail: "3/3 criteria met",
    ms: 800,
  },
  {
    kind: "text",
    text: `**${taskName}** is ready for your review. All three success criteria are met, with test output attached to each. Approve it to close the task, or send it back with a note and I'll pick it up from here.`,
  },
];
