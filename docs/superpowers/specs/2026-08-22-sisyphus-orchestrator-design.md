# A Sisyphus-shaped orchestrator for Fleet

Date: 2026-08-22
Status: design, no code changed
Studied: `code-yeongyu/oh-my-openagent` @ `0902c4a8`, plus the `ulw-loop` skill it ships

The ask: make Fleet's orchestrator work like OmO's **Sisyphus** — the agent that
"just works until the task is done".

I read the implementation rather than the marketing. The headline is that **we
already have the half of Sisyphus that is machinery, and we have it in a
stronger form.** What we are missing is the half that is discipline, and most of
that lands as protocol — schemas that refuse vague input — rather than as new
infrastructure.

---

## 1. What Sisyphus actually is

### 1.1 There is no loop in the code

I expected a control loop and there isn't one:

> There is no `while`, `for`, or recursive call around Sisyphus's agent
> invocation anywhere in the codebase.

The loop is a **turn-boundary contract**:

1. Sisyphus fires background workers and its prompt tells it to **"END YOUR
   RESPONSE"**.
2. The harness injects a `<system-reminder>` when a worker finishes.
3. That reminder starts the next turn, and Sisyphus picks up where it left off.

That is *exactly* Fleet's propose/dispose: the Lead dispatches, ends its turn,
and the engine wakes it on settle. We did not copy this from them and we arrived
at the same shape, which is reassuring — it is the shape the problem has.

Ours is the more durable version. Theirs lives in a running harness process;
ours is `settleSeq > wakeSeq` in SQLite, so a Host restart mid-flight still owes
exactly one wake.

### 1.2 Its state is files the model must remember to read

```
.omo/ulw-loop/brief.md      original brief and durable constraints
.omo/ulw-loop/goals.json    goals with embedded successCriteria
.omo/ulw-loop/ledger.jsonl  append-only audit trail
```

with the instruction:

> After compaction or context loss, re-read brief + goals + ledger FIRST, then
> `status --json`. Recover from artifacts; never re-plan from scratch.

This is the right *idea* — durable state outside the context window — executed
in the only way available to a plugin that cannot change its host. We already
have `runs`, `run_steps` and `run_notes` in SQLite behind a deterministic engine.
Ours cannot be forgotten, because the engine reads it whether or not the model
remembers to.

### 1.3 Its retry caps are prompt text

> After three materially different approaches have failed: 1. Stop editing
> immediately. 2. Revert to a known-good state. 3. Document each attempt...

and

> Cap at 5 cycles per goal. Cap identical same-criterion failures at 3.

Nothing enforces these. The model is asked to count. We have `maxWakes`,
`emptyWakeCount` and `onStepFailure` enforced by the scheduler.

### 1.4 So what is genuinely better there

Five things, and they are all about **what "done" means**:

1. **Criteria are data, and vagueness is rejected.**
   Each criterion carries `id`, `scenario` (tool + inputs + binary pass/fail),
   `expectedEvidence` (an artifact path), adversarial classes, and a stop
   condition. *"Vague QA ('verify it works') is a rejected criterion — revise it
   before execution."*

2. **Every goal declares when to stop, in observable terms.**
   *"Every goal also declares, in one line, WHEN TO STOP: 'stop right away when
   `<the exact observable state that ends this goal>`'. A goal without that line
   is rejected."*

3. **Evidence is bound to the tree it was captured at.**
   PASS records carry `@tree:<short-tree>` from `git rev-parse --short
   "HEAD^{tree}"`. Changed tracked content invalidates the evidence; a rebase
   that keeps the tree identical keeps it valid. *"NEVER relabel, pin, refresh,
   or regenerate prior output to a moved HEAD."*

4. **A worker's report is a claim to disprove.**
   *"do NOT trust the worker's report. Read the diff yourself, re-run its tests,
   and run LSP diagnostics on the changed files. Treat 'done' as a claim to
   disprove."* and *"NEVER record `--status pass` from a worker's self-report."*

5. **Tests alone never prove done.**
   *"A green test suite is supporting evidence, not completion proof."* Proof is
   an observable artifact from a real surface.

Plus a delegation contract worth stealing verbatim: every worker message starts
with `TASK:` and names **DELIVERABLE**, **SCOPE**, **VERIFY**, carries no parent
history by default, and long-running children emit `WORKING:` / `BLOCKED:`.

---

## 2. Where Fleet actually stands

| | OmO Sisyphus | Fleet today |
|---|---|---|
| Turn loop | prompt says END YOUR RESPONSE; harness `<system-reminder>` | propose/dispose; `settleSeq > wakeSeq`, **survives restart** |
| Durable state | JSON/JSONL files the model must re-read | SQLite + engine, **read whether or not the model remembers** |
| Retry caps | prompt asks the model to count | `maxWakes` / `emptyWakeCount` / `onStepFailure`, **enforced** |
| Waiting | `wait_agent` + exponential backoff, burns tokens | event-driven, **free while idle** |
| Workers | in-process subagents, one host | real sessions on real machines, placement-pinned |
| **Success criteria** | structured, vagueness rejected | **absent** — `phases` are names, not criteria |
| **Stop condition** | required, observable | **absent** |
| **Evidence** | artifact + tree stamp, staleness defined | **absent** — `run_notes` is free prose |
| **Verify-don't-trust** | explicit, repeated, load-bearing | **absent** — the envelope hands over worker text to judge |
| **Worker contract** | `TASK:/DELIVERABLE/SCOPE/VERIFY` | **absent** — `prompt` is one free-text blob |

The left column's advantages are all *asked for in prose*. The right column's
advantages are all *enforced by code*. That asymmetry is the whole opportunity:

> **OmO has to ask its model to be disciplined. We can make the discipline
> mechanical.**

A criterion with no observable evidence can be rejected by a Zod schema. A task
whose criteria are unproven can be refused by `fleet_submit_task`. Evidence
whose tree has moved can be marked stale by the engine on the next tick. None of
that depends on the model's good behaviour.

---

## 3. What I propose we build

Five changes, in dependency order. Each is useful alone.

### 3.1 Criteria as data, and a schema that refuses vagueness

**Built.** `RunCriterionSchema` in the protocol, `runs.success_criteria` /
`runs.stop_when` in the store, required by `fleet_plan_task`, enforced by
`fleet_submit_task`, shown under "What done means" in the task detail.

`fleet_plan_task` grows criteria beside its phases:

```ts
successCriteria: z.array(z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).max(40),
  /** Tool + inputs + a binary pass/fail. Not "verify it works". */
  scenario: z.string().min(20).max(600),
  /** The observable this produces. A path, a status line, a diff, a count. */
  expectedEvidence: z.string().min(10).max(300),
  essential: z.boolean().default(true),
})).min(1).max(8),
/** One line. The exact observable state that ends this task. */
stopWhen: z.string().min(10).max(300),
```

The minimum lengths are doing real work: they are the cheapest available
approximation of "revise it before execution". Store on `runs`; surface in the
task detail so a person reads the same contract the orchestrator is held to.

Two things worth recording from building it:

- **The schema is satisfiable.** A minimum length that no model reliably clears
  would brick planning outright and would pass every unit test in the suite, so
  it was checked against a live orchestrator rather than argued about. Given
  "find out how many test files this repository has", it wrote a criterion that
  parsed first time, and submitted with the command it had run as the evidence.
- **`blocked` does not open the gate.** It is the honest answer when something
  could not be checked, and honesty is worth encouraging, but it is still not
  evidence that the thing works. A criterion that cannot be met at all goes to
  `fleet_escalate`, because dropping one is a person's decision.

### 3.2 Evidence as rows, stamped with the tree

A `run_evidence` table: `runId`, `criterionId`, `status` (pass/fail/blocked),
`observable`, `treeHash`, `stepId`, `createdAt`.

Fleet knows each step's placement and therefore its checkout, so the Host can
compute `git rev-parse --short HEAD^{tree}` itself rather than trusting the model
to stamp it. Then:

- **Staleness is derived, not remembered.** Evidence whose `treeHash` differs
  from the placement's current tree renders as stale, and the engine can say so
  on the next tick. OmO can only instruct against relabelling; we can detect it.
- The UI gets something real to show under a task: which criteria are proven,
  against which tree, by which step.

### 3.3 `fleet_submit_task` becomes a gate rather than a report

**Half built.** It now refuses when an essential criterion is reported `unmet`,
`blocked`, or left out entirely, and records the evidence next to the summary a
person reads. What it cannot yet do is check the claim: it takes the
orchestrator's word that a criterion was met. §3.2 is what closes that — until
then the gate forces a written observation per criterion rather than proving it.

Today it takes a `summary` and hands over. It should refuse when an `essential`
criterion has no non-stale `pass`. The refusal names the criteria, which turns
the model's "am I done?" into a question with a mechanical answer.

This is where we beat the source material: their completion gate is *"the
decisive test is whether the user's problem is ACTUALLY SOLVED"*, addressed to a
model. Ours can be a `409` with a list.

### 3.4 The worker contract in the tool signature

**Built.** `fleet_start_work` no longer takes a prompt; the Host composes one
from the four fields, and appends the instruction to verify before answering —
which is the line most likely to be dropped by a model in a hurry, and the one
that decides whether a worker checks its own work.

`fleet_start_work` replaces its free-text `prompt`:

```ts
deliverable: z.string().min(10),   // what must come back
scope: z.string().min(10),         // files, dirs, boundaries
verify: z.string().min(10),        // the command or channel that proves it
context: z.string().optional(),    // what the worker cannot discover
```

The Host composes the actual prompt from these, in the `TASK:` shape. Two wins
over a blob: a call with no `verify` is rejected before a machine is spent on
it, and the worker's brief becomes uniform enough to render in the UI.

**Minimums, not maximums — and the asymmetry is the design.** These fields
originally carried both, and the ceilings were invisible: the constraints lived
on the handler's schema while the descriptions lived on a second, hand-written
schema that `mcp-routes` advertised, which carried no lengths at all. So
`context` told a caller to repeat everything decided elsewhere, named no
ceiling, and then refused the dispatch against a `6_000` it had never been
shown. The refusal was Zod's default `message` — a JSON array of issue objects,
which reads as a malfunction rather than as something the caller did, and never
says the one thing that decides what to do next: that no worker was started and
no budget was spent.

Visibility was the first fix: the second schema is gone, and `mcp-routes` now
advertises `StartWorkSchema.shape` itself, so a constraint cannot exist without
reaching the caller as JSON Schema. But it only made the wrong rule legible. A
maximum on a brief buys brevity, and brevity is not worth a refused dispatch —
an orchestrator relaying what a person said, what an earlier worker found, and
the constraints agreed along the way is doing precisely what `context` is for,
and being stopped for it teaches it to send the worker less than the worker
needed. So the ceilings came off the free-text fields here, in `fleet_plan_task`,
`fleet_advance_task`, `fleet_submit_task`, `fleet_escalate`, `fleet_follow_up`
and `RunCriterionSchema`. The floors stay: they are what refuse a brief nobody
could check, which is the thing this tool exists to do.

Size is bounded once, at the transport. Fastify defaults to a 1 MB body and the
MCP route had taken that default, which made the worst refusal in the system
reachable — a bare `413` that never reaches the MCP layer, leaving the caller a
transport error naming no tool, no reason, and no hint that its worker never
started. `MCP_BODY_LIMIT` raises it to 32 MB, far above any brief, so what
remains is a resource limit rather than an opinion about length.

Truncating instead of refusing was considered and rejected: it is the same bug
wearing a friendlier face, since a worker handed a clipped brief never finds out
what it was not told and has no way to notice. `mcp-routes.test.ts` dispatches a
200,000-character context and asserts the worker's prompt contains all of it.

Also verified live. Given "find out which port this project listens on", the
orchestrator filled all four without prompting — a `verify` that named the
greps it would run and required the citation to be checked against real file
contents, and a `context` that told the worker the stack was unknown and worth
determining first. The report came back with a volunteered caveat: the port
value exists but nothing in the tree reads it. That caveat is the behaviour the
whole design is aiming at, and it was not asked for.

**One thing this exposed, now fixed:** `apps/host/tsconfig.server.json` and
`apps/node/tsconfig.json` excluded `src/**/*.test.ts`, so service tests were
never typechecked. Renaming these fields broke every test call site and the
suite stayed green, because the tests call the tools directly and the composed
prompt merely contained `undefined` where a field used to be. Both packages now
carry a `tsconfig.test.json` that includes tests with `noEmit`, wired into
`npm run typecheck`; `dist` is unchanged because the build still uses the
emitting config. Closing it turned up a genuine type bug of the same vintage —
`registerNode`'s signature meant `agents` to be optional but left it in the
`Omit`, so the intersection could not loosen it — plus about two dozen fixtures
that had drifted behind fields added since they were written.

### 3.5 A custom agent that carries the durable half

Verified feasible in `2026-08-22-orchestrator-custom-agent.md`: an agent file in
the Lead's scratch cwd, selected over ACP with `set_config_option` before the
first prompt, surviving resume.

What goes in it is exactly the part that is true on every wake — the role, the
verify-don't-trust rule, the delegation contract, the stop rules. What stays a
prompt is what is true *this* wake: the envelope. Today both arrive as prose in
the same message and the durable half is re-sent and re-inferred every time.

**How the file reaches the machine.** Discovery is `cwd`-relative and the Host
has no access to a Node's disk, so something has to write it there.
`start_session` carries `localPath`, `prompt`, `yolo` and `mcpServers` — there is
no file-writing command in the protocol and no reason to add a general one.

**The agents ship with the Node, and the Node reports what it has.**

An earlier draft of this section had the Host push the markdown on the start
command, on the grounds that Node-side text would drift between machines. That
objection does not survive contact with the code: the Host already compares
`node.revision` against `hostRevision` and renders a Node as `stale` with a
self-update button (`nodeUpdateState`, protocol `index.ts:691`). Agents shipped
with the Node join a drift problem that is already managed and already visible,
rather than creating a new one.

Shipping them Node-side is also the only version that scales past one prompt.
The interesting artefact is not the orchestrator's prompt — it is a **catalog of
roles**: an orchestrator, an implementer, a reviewer, a debugger, an explorer.
Pushing 50KB of markdown down the socket on every `start_session` to deliver
that would be absurd.

Three things this has to get right.

**1. The catalog is a node capability, reported upward.** A Node already reports
`capabilities`, and a session already reports `commands` and `configOptions`.
Agents belong in exactly that family:

```ts
/** Agent definitions this Node can select for a session. */
agents: z.array(z.object({
  name: z.string().regex(/^[a-z0-9-]+$/).max(40),
  description: z.string().max(200),
})).default([]),
```

Without this the Host dispatches "use `fleet-orchestrator`" blind and discovers
on a stale machine, at runtime, that no such agent exists. With it, placement
selection can *require* an agent the way it already requires an online node, the
UI can show which machines can host an orchestrator, and a missing agent becomes
a scheduling fact rather than a failed session.

`start_session` then carries only a name:

```ts
/** An agent from this Node's catalog. Empty for an ordinary session. */
agent: z.string().max(40).default(""),
```

**2. Bundling does not put the file where Copilot looks.** Discovery is
`cwd`-relative — verified, not assumed. So the Node still copies the chosen
definition into `<cwd>/.github/agents/<name>.agent.md` before `session/new`, and
again on `session/load` for the same reason it re-supplies `mcpServers`. Shipping
them with the Node changes where the bytes come from, not where they must land.

The alternative, installing into `~/.copilot/agents/`, is less code and worse:
it would put Fleet's agents in front of the operator's own Copilot sessions on
that machine.

**3. The catalog must be extensible, and not with other people's text.** The
obvious wish is to bundle agents we admire — OmO's Hephaestus was the example
raised. We cannot: OmO is Sustainable-Use-licensed, `@fleet/node` is published,
and bundling their prose is distribution, which is the case that licence
restricts (§5).

The better answer serves the wish anyway. The Node reads two sources:

- **built-in**, shipped in the package — agents we wrote;
- **a user directory** on the node, `<config>/agents/*.agent.md`, merged into the
  same catalog and reported upward identically.

Then anyone can run Hephaestus, or their own house reviewer, by dropping the
file on their own machine under whatever terms they accepted — and Fleet
distributes nobody's text but its own. A user-dropped agent shadowing a built-in
by name is the operator overriding us on their machine, which is the right
default.

This also makes the catalog naturally per-machine, which is a fact rather than a
problem: a Node can offer a role only it is equipped for.

**Where this goes next: categories become roles.** `fleet_start_work` already
takes a `category` — `implement`, `test`, `explore`, `review-quick`,
`review-deep` — and today that decides only placement (whether the step takes the
write lock) and whether the session is a `worker` or a `reviewer`. It does not
touch how the worker thinks.

Once a Node has a catalog, the obvious mapping is `category → agent`: an
implementer, a reviewer, an explorer, each with its own instructions and its own
`tools:` list. That is worth wanting for a reason beyond prompt quality — the
`tools:` gate is real (§1.5 of the custom-agent spec), so a review worker can be
given an agent with no write tools at all. "A reviewer does not edit the tree"
stops being a convention we hope holds and becomes something the agent
definition enforces.

Deliberately not in the first cut: get the orchestrator working, then extend the
same mechanism outward. But the catalog should be designed as a catalog from the
start rather than as one special file, which is precisely the argument for
shipping it with the Node.

---

## 4. What I deliberately would not copy

- **The synchronous wait loop.** `wait_agent` with doubling backoff exists
  because their harness has no durable wake. Ours does. Adopting it would burn
  tokens to learn something an event already tells us.
- **File-based state.** `.omo/**` is a workaround for a plugin that cannot own a
  database. We own one.
- **Fourteen per-model prompt files.** Justified for a product spanning many
  harnesses and model families. We run one harness. Start with one prompt, and
  add a variant only when a specific model demonstrably misbehaves — otherwise
  it is fourteen files to keep in step for a difference nobody measured.
- **Their runtime prompt reconciler.** It fixes a TUI model-switch bug specific
  to a prompt baked at registration. Our agent file is read per session; if we
  ever bake per-model text we will need the same idea, and not before.

---

## 5. On reusing their prompt text

Their prompts are readable — plain TypeScript in a public repo, functions like
`buildGrok4SisyphusPrompt()` that concatenate tagged blocks. We should **not**
vendor that text, for three independent reasons.

**Licensing.** OmO ships under the **Sustainable Use License**, not an open
source licence. It permits use and modification "only for your own internal
business purposes or for non-commercial or personal use", permits distribution
"only if you do so free of charge for non-commercial purposes", and requires
that anyone receiving a copy also receives the terms, plus a prominent notice on
any modification. `copilot-fleet` is a **public** repository with no licence
file of its own. Copying their prose into it is distribution, and it would bind
part of this project to those terms.

**It would not work.** Their prompts are wired to their harness:
`lsp_diagnostics`, `background_output(task_id="bg_...")`,
`task(task_id="ses_...")`, `todowrite`, the Oracle / explore / librarian agents,
`omo-agent-toolkit ulw-loop`. None of that exists here. A verbatim copy would
instruct our orchestrator to call tools that are not there.

**The text is not the valuable part.** What transfers is the shape and the
findings, and both are ideas rather than expression.

### The shape

Each variant assembles tagged blocks in a fixed order, several of them generated
from runtime facts (registered agents, available skills, configured categories):

`<role>` · calibration · `<intent>` · `<exploration>` · `<delegation>` ·
`<behavior>` · `<verification>` · `<tasks>` · `<communication>` ·
`<constraints>`

Two things stand out. **Verification gets its own top-level block** rather than
being a line inside "how to work" — it is treated as the definition of done, not
a step. And **intent classification is explicit**, with a rule that
authorisation does not carry across turns. That matters enormously for a woken
orchestrator, which is exactly an agent whose turns are far apart.

### The findings

The most useful thing in the file is its header comment, which records what
they learned actually moves the outcome — and what does not:

- phrasing intensity ("work very hard") changes nothing;
- **an explicit verification loop is the single highest-leverage instruction**;
- **a written definition of done, "because otherwise the model decides done for
  you"**;
- a narration cadence matched to the model's style;
- one anti-pattern nudge aimed at a failure that model actually has.

That is a prompt-engineering result, and results are facts. It also validates
§3.1 and §3.3 above from a different direction: they had to *ask* for a written
definition of done, and we can *require* one.

### Rules worth restating in our own words

- A worker's report is a lead, not evidence.
- "Should pass" means unverified; report only evidence from this turn.
- The delegate's expected outcome is its definition of done — make it
  observable. (Their delegation contract is six sections here — TASK, EXPECTED
  OUTCOME, REQUIRED TOOLS, MUST DO, MUST NOT DO, CONTEXT — and four in
  `ulw-loop`: TASK, DELIVERABLE, SCOPE, VERIFY. §3.4 takes the four-part shape
  because our tool call can carry the rest as structured fields.)
- Classify the current message; do not carry implementation authorisation
  forward.
- A search budget with an explicit stop, so exploration ends on a condition
  rather than on the model losing interest.
- After three materially different failed approaches, stop editing rather than
  continue.

We write our own prose for all of it, against our own tool names, and cite them
in the spec as the source of the idea. That is the same relationship we already
have with any paper or blog post we learn from.

## 6. Suggested order

1. ~~**Custom agent**~~ — done. Smallest, already proven, and it made the rest
   cheaper to express because the policy stopped being re-sent prose.
2. ~~**Criteria + `stopWhen`**~~ — done. The largest single behaviour change.
   The orchestrator now has a definition of done that is not a feeling, and
   cannot hand a task over while an essential one is unmet.
3. ~~**Worker contract**~~ — done. Cheap, and it improved every dispatched
   session immediately.
4. **Evidence rows + tree stamps** — needs the criteria to hang off. Next.
5. **Submit gate** — needs the evidence to check. Half of it now exists: the
   refusal is real, but what it checks is the orchestrator's own report.

## 7. Open questions

- ~~**Does every task deserve criteria?**~~ Answered by building it: yes, and it
  is not ceremony. Asked to count test files — the smallest possible task, no QA
  channel — a live orchestrator wrote one criterion naming the search it would
  run and the count it would produce, and it cost one line. The `essential:
  false` flag is the escape hatch for the parts that are genuinely optional.
  Kept below for the reasoning that led there.
- **Who writes the criteria — the person or the orchestrator?** OmO has the
  agent derive them from the brief and surface assumptions for a one-line veto.
  That fits our "New task" dialog well: the person states an outcome, the
  orchestrator proposes criteria, and the board shows them before work starts.
- **What is the tree hash for a task spanning two placements?** Evidence is
  per-step, so per-step placement is the honest answer, but a run-level "is
  everything proven at the same tree" check then has more than one tree to
  consider.
