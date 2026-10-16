import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type CliDeps } from "./cli.js";
import type { HelperInput, ProviderResult } from "./engine.js";
import { sha256 } from "./state.js";

const PR_URL = "https://github.com/octo/widgets/pull/7";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NEW_HEAD = "c".repeat(40);
const REV = (n: number) => String(n).padStart(64, "0");

type Source = {
  kind: string;
  id: string;
  revision: string;
  body: string;
  groupKey?: string;
};

const identity = {
  host: "github.com",
  repositoryId: "R_base",
  repository: "octo/widgets",
  prNumber: 7,
  headRepositoryId: "R_base",
  headRepository: "octo/widgets",
  headRef: "refs/heads/feature",
  baseRepositoryId: "R_base",
  baseRepository: "octo/widgets",
  baseRef: "refs/heads/main",
};

/** A complete provider result in the shape the bundled helper returns. */
const providerResult = (
  options: {
    sources?: Source[];
    headSha?: string;
    state?: "open" | "merged" | "closed";
    checks?: Array<{ key: string; state: "pending" | "passed" | "failed" | "unknown" }>;
    mergeability?: "mergeable" | "conflicting" | "unknown";
    fingerprint?: string;
  } = {},
): ProviderResult => {
  const sources = options.sources ?? [];
  const headSha = options.headSha ?? HEAD;
  return {
    observation: {
      attemptedAt: new Date(now).toISOString(),
      complete: true,
      requestsConsumed: 6,
      elapsedMs: 900,
      helperState: {
        resume: null,
        previousThreads: [{ id: "T1", stateHash: REV(9), revision: 0 }],
      },
      checksComplete: true,
      reviewsComplete: true,
      identity,
      snapshotId: options.fingerprint ?? `fp-${sources.length}-${headSha.slice(0, 4)}`,
      headSha,
      baseSha: BASE,
      state: options.state ?? "open",
      draft: false,
      fingerprint: options.fingerprint ?? `fp-${sources.length}-${headSha.slice(0, 4)}`,
      mergeability: options.mergeability ?? "mergeable",
      checks: (options.checks ?? [{ key: "ci", state: "passed" }]).map((check) => ({
        ...check,
        headSha,
        evidence: `check ${check.key}`,
      })),
      reviews: [],
      sources: sources.map((source) => ({
        id: `${source.kind}:${source.id}`,
        revision: source.revision,
        groupKey: source.groupKey ?? `${source.kind}:${source.id}`,
        evidence: `${PR_URL}; source ${source.id}`,
      })),
      knownSelfEffectIds: [],
      evidence: "fixture",
    },
    snapshot: {
      actionableSources: sources.map((source) => ({
        kind: source.kind,
        id: source.id,
        body: source.body,
        actor: "reviewer",
        url: `${PR_URL}#${source.id}`,
        path: "src/parse.ts",
        line: 10,
        contentHash: sha256(JSON.stringify(source.body)),
      })),
    },
  };
};

let now = Date.parse("2026-10-15T12:00:00.000Z");
let dir: string;
let state: string;
let providerQueue: Array<ProviderResult | Error>;
let helperInputs: HelperInput[];

const deps = (): CliDeps => ({
  parseUrl: (url) => {
    if (!url.startsWith("https://github.com/")) throw new Error("not a PR URL");
    return { provider: "github", url: url.toLowerCase() };
  },
  observe: async (input) => {
    helperInputs.push(input);
    const next = providerQueue.shift();
    if (!next) throw new Error("no fixture queued");
    if (next instanceof Error) throw next;
    return next;
  },
  now: () => now,
  readStdin: async () => "",
  env: {},
  skillDir: join(dir, "skill"),
});

const prm = async (...args: string[]) => {
  const output = await run([...args, "--state", state], deps());
  return output.body as Record<string, any>;
};

const writeJson = async (name: string, value: unknown) => {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value));
  return path;
};

const setup = async (mode = "repair") => {
  expect((await prm("init")).ok).toBe(true);
  const added = await prm(
    "add",
    PR_URL,
    "--mode",
    mode,
    ...(mode === "observe" ? [] : ["--checkout", join(dir, "checkout")]),
    "--verify",
    "npm test",
  );
  expect(added.ok).toBe(true);
  return added.job.jobId as string;
};

const begin = async () => {
  const begun = await prm("begin");
  expect(begun.ok).toBe(true);
  return begun.pass.passId as string;
};

const comment: Source = {
  kind: "thread_comment",
  id: "C1",
  revision: REV(2),
  body: "Handle null input.",
};
const question: Source = {
  kind: "thread_comment",
  id: "C2",
  revision: REV(3),
  body: "Why this name?",
};

beforeEach(async () => {
  now = Date.parse("2026-10-15T12:00:00.000Z");
  dir = await mkdtemp(join(tmpdir(), "prm-test-"));
  await mkdir(join(dir, "skill"));
  state = join(dir, "state");
  providerQueue = [];
  helperInputs = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("state store", () => {
  it("initializes once and refuses state inside the skill folder", async () => {
    expect((await prm("init")).created).toBe(true);
    expect((await prm("init")).created).toBe(false);
    const inside = await run(["init", "--state", join(dir, "skill", "state")], deps());
    expect(inside.body).toMatchObject({
      ok: false,
      error: { code: "invalid_state_root" },
    });
    const relative = await run(["init", "--state", "relative/dir"], deps());
    expect(relative.body).toMatchObject({
      ok: false,
      error: { code: "invalid_state_root" },
    });
  });

  it("reports a missing store instead of silently starting over", async () => {
    await prm("init");
    await rm(join(state, "store.json"));
    expect(await prm("status")).toMatchObject({
      ok: false,
      error: { code: "state_missing" },
    });
    expect(await prm("init")).toMatchObject({
      ok: false,
      error: { code: "state_missing" },
    });
  });

  it("reports a corrupt store and leaves it in place", async () => {
    await prm("init");
    await writeFile(join(state, "store.json"), "{ not json");
    expect(await prm("status")).toMatchObject({
      ok: false,
      error: { code: "state_corrupt" },
    });
    expect(await readFile(join(state, "store.json"), "utf8")).toBe("{ not json");
  });

  it("returns state_busy while another writer holds the lock and never steals it", async () => {
    await prm("init");
    await mkdir(join(state, "writer.lock"));
    await writeFile(
      join(state, "writer.lock", "owner.json"),
      JSON.stringify({ lockId: "L1", pid: 1 }),
    );
    const busy = await prm("add", PR_URL, "--mode", "observe");
    expect(busy).toMatchObject({ ok: false, error: { code: "state_busy" } });
    expect(busy.error.details.lock.lockId).toBe("L1");
    expect(await prm("recover", "--lock", "other")).toMatchObject({
      ok: false,
      error: { code: "recovery_conflict" },
    });
    expect((await prm("recover", "--lock", "L1")).ok).toBe(true);
    expect((await prm("add", PR_URL, "--mode", "observe")).ok).toBe(true);
  });

  it("replays an operation ID and rejects reuse with a different payload", async () => {
    await prm("init");
    const first = await prm("add", PR_URL, "--mode", "observe", "--op", "op-1");
    const again = await prm("add", PR_URL, "--mode", "observe", "--op", "op-1");
    expect(again).toMatchObject({ ok: true, replayed: true, revision: first.revision });
    expect(again.job.jobId).toBe(first.job.jobId);
    const conflict = await prm(
      "add",
      PR_URL,
      "--mode",
      "answer",
      "--checkout",
      dir,
      "--op",
      "op-1",
    );
    expect(conflict).toMatchObject({ ok: false, error: { code: "operation_conflict" } });
  });

  it("rejects a store copied to another directory", async () => {
    await prm("init");
    const copy = join(dir, "copy");
    await mkdir(copy);
    await writeFile(join(copy, "store.json"), await readFile(join(state, "store.json")));
    const output = await run(["status", "--state", copy], deps());
    expect(output.body).toMatchObject({
      ok: false,
      error: { code: "state_root_changed" },
    });
  });
});

describe("registration", () => {
  it("requires a checkout for answer and repair modes and rejects duplicates", async () => {
    await prm("init");
    expect(await prm("add", PR_URL, "--mode", "repair")).toMatchObject({
      ok: false,
      error: { code: "invalid_args" },
    });
    expect(await prm("add", "https://example.com/x", "--mode", "observe")).toMatchObject({
      ok: false,
      error: { code: "invalid_pr_url" },
    });
    expect((await prm("add", PR_URL, "--mode", "observe")).ok).toBe(true);
    expect(await prm("add", PR_URL, "--mode", "observe")).toMatchObject({
      ok: false,
      error: { code: "job_exists" },
    });
  });
});

describe("passes and observation", () => {
  it("allows one active pass and limits visits", async () => {
    const jobId = await setup("observe");
    const passId = await begin();
    expect(await prm("begin")).toMatchObject({
      ok: false,
      error: { code: "pass_active" },
    });
    for (let visit = 0; visit < 5; visit++) {
      providerQueue.push(providerResult());
      expect((await prm("observe", "--pass", passId, "--job", jobId)).ok).toBe(true);
    }
    expect(await prm("observe", "--pass", passId, "--job", jobId)).toMatchObject({
      ok: false,
      error: { code: "visit_budget_exhausted" },
    });
    expect((await prm("end", "--pass", passId)).ok).toBe(true);
    expect((await prm("begin")).ok).toBe(true);
  });

  it("discovers by URL, then pins identity and passes continuation state", async () => {
    const jobId = await setup("observe");
    const passId = await begin();
    providerQueue.push(providerResult({ sources: [comment] }));
    const observed = await prm("observe", "--pass", passId, "--job", jobId);
    expect(observed).toMatchObject({
      ok: true,
      outcome: "action_needed",
      complete: true,
    });
    expect(observed.obligations[0]).toMatchObject({
      sourceId: "thread_comment:C1",
      change: "new",
      body: "Handle null input.",
      path: "src/parse.ts",
    });
    expect(helperInputs[0]!.pr).toEqual({ url: PR_URL });
    providerQueue.push(providerResult({ sources: [comment] }));
    const again = await prm("observe", "--pass", passId, "--job", jobId);
    expect(again.obligations[0].change).toBe("carried");
    expect(helperInputs[1]!.pr).toMatchObject({
      headRef: "refs/heads/feature",
      repositoryId: "R_base",
    });
    expect(helperInputs[1]!.previousThreads).toEqual([
      { id: "T1", stateHash: REV(9), revision: 0 },
    ]);
  });

  it("charges only consumed requests and keeps the remainder for the pass", async () => {
    const jobId = await setup("observe");
    const passId = await begin();
    providerQueue.push(providerResult());
    await prm("observe", "--pass", passId, "--job", jobId);
    const status = await prm("status");
    expect(status.activePass.requestsRemaining).toBe(40 - 6);
  });

  it("records ready only with complete passing evidence and no open items", async () => {
    const jobId = await setup("observe");
    const passId = await begin();
    providerQueue.push(providerResult({ checks: [{ key: "ci", state: "pending" }] }));
    const pending = await prm("observe", "--pass", passId, "--job", jobId);
    expect(pending.outcome).toBe("waiting");
    expect(pending.readinessBlockers).toContain("check ci is pending");
    providerQueue.push(providerResult());
    const ready = await prm("observe", "--pass", passId, "--job", jobId);
    expect(ready).toMatchObject({ outcome: "ready", readyChanged: true });
  });

  it("pauses with an auth hold on authentication failures", async () => {
    const jobId = await setup("observe");
    const passId = await begin();
    providerQueue.push({
      observation: {
        attemptedAt: new Date(now).toISOString(),
        complete: false,
        failure: "auth",
        evidence: "GitHub helper v1: authentication_required",
      },
    });
    const observed = await prm("observe", "--pass", passId, "--job", jobId);
    expect(observed).toMatchObject({
      ok: true,
      outcome: "blocked",
      complete: false,
      failure: "auth",
    });
    expect(observed.job).toMatchObject({
      lifecycle: "paused",
      holds: [{ kind: "auth" }],
    });
  });

  it("pauses after three consecutive failures and records helper crashes", async () => {
    const jobId = await setup("observe");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const passId = await begin();
      providerQueue.push(new Error("gh not found"));
      const observed = await prm("observe", "--pass", passId, "--job", jobId);
      expect(observed).toMatchObject({ ok: true, complete: false });
      await prm("end", "--pass", passId);
      now += 16 * 60_000;
    }
    const status = await prm("status");
    expect(status.jobs[0]).toMatchObject({
      lifecycle: "paused",
      holds: [{ kind: "failures" }],
    });
  });

  it("enters terminal state on merge", async () => {
    const jobId = await setup("observe");
    const passId = await begin();
    providerQueue.push(providerResult({ state: "merged" }));
    expect(await prm("observe", "--pass", passId, "--job", jobId)).toMatchObject({
      outcome: "terminal",
      state: "merged",
    });
    expect((await prm("release", "--job", jobId)).ok).toBe(true);
    expect((await prm("status")).jobs).toEqual([]);
  });
});

describe("plan, work order and report", () => {
  const planFile = (findings: unknown[], extra: Record<string, unknown> = {}) =>
    writeJson("plan.json", { summary: "Fix review feedback.", findings, ...extra });

  const observeWith = async (
    jobId: string,
    passId: string,
    sources: Source[],
    headSha = HEAD,
  ) => {
    providerQueue.push(providerResult({ sources, headSha }));
    return prm("observe", "--pass", passId, "--job", jobId);
  };

  const reportFile = (
    batchId: string,
    findings: unknown[],
    effects: unknown[] = [],
    mutationAttempts = 2,
  ) =>
    writeJson("report.json", {
      schema: "prm.work-report/1",
      batchId,
      summary: "Done.",
      mutationAttempts,
      findings,
      effects,
    });

  it("builds an immutable work order pinned to the observed head", async () => {
    const jobId = await setup("repair");
    const passId = await begin();
    await observeWith(jobId, passId, [comment, question]);
    const plan = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        {
          sourceId: "thread_comment:C1",
          task: "repair",
          instructions: "Return [] for null.",
        },
        {
          sourceId: "thread_comment:C2",
          task: "answer",
          instructions: "Explain the convention.",
        },
      ]),
    );
    expect(plan).toMatchObject({ ok: true, refused: false });
    expect(plan.workOrder).toMatchObject({
      schema: "prm.work-order/1",
      mode: "repair",
      pr: { headSha: HEAD, baseSha: BASE, headRef: "refs/heads/feature" },
      permissions: { modifyCode: true, push: true, reply: true, resolveThreads: false },
      verification: ["npm test"],
      allowances: { repairBatchesRemaining: 2 },
    });
    expect(plan.workOrder.findings[0]).toMatchObject({
      body: "Handle null input.",
      revision: REV(2),
    });
    const second = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C2", task: "answer", instructions: "x" },
      ]),
    );
    expect(second).toMatchObject({ ok: false, error: { code: "batch_outstanding" } });
  });

  it("refuses plans that are not grounded in the current observation or mode", async () => {
    const jobId = await setup("answer");
    const passId = await begin();
    const early = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C1", task: "answer", instructions: "x" },
      ]),
    );
    expect(early).toMatchObject({ ok: false, error: { code: "observe_first" } });
    await observeWith(jobId, passId, [comment]);
    const unknown = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:ZZ", task: "answer", instructions: "x" },
      ]),
    );
    expect(unknown).toMatchObject({ ok: false, error: { code: "invalid_plan" } });
    const repair = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C1", task: "repair", instructions: "x" },
      ]),
    );
    expect(repair).toMatchObject({ ok: false, error: { code: "mode_forbids" } });
    now += 31 * 60_000;
    const stale = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C1", task: "answer", instructions: "x" },
      ]),
    );
    expect(stale.ok).toBe(false);
  });

  it("records triage decisions that settle at the current revision only", async () => {
    const jobId = await setup("observe");
    const passId = await begin();
    await observeWith(jobId, passId, [comment, question]);
    const triage = await prm(
      "triage",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await writeJson("triage.json", {
        decisions: [
          { sourceId: "thread_comment:C1", decision: "no_action", reason: "Bot noise." },
          {
            sourceId: "thread_comment:C2",
            decision: "needs_human",
            reason: "Owner decides.",
          },
        ],
      }),
    );
    expect(triage).toMatchObject({
      ok: true,
      recorded: { no_action: 1, needs_human: 1 },
      openObligations: [{ sourceId: "thread_comment:C2", waitingOnHuman: true }],
    });
    const again = await observeWith(jobId, passId, [comment, question]);
    expect(again).toMatchObject({ outcome: "needs_human", alreadySettled: 1 });
    expect(
      again.obligations.map((entry: { sourceId: string }) => entry.sourceId),
    ).toEqual(["thread_comment:C2"]);
    const edited = await observeWith(jobId, passId, [
      { ...comment, revision: REV(7) },
      question,
    ]);
    expect(edited.outcome).toBe("action_needed");
    expect(edited.obligations[0]).toMatchObject({
      sourceId: "thread_comment:C1",
      change: "changed",
    });
  });

  it("observe mode never plans work", async () => {
    const jobId = await setup("observe");
    const passId = await begin();
    await observeWith(jobId, passId, [comment]);
    const plan = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C1", task: "answer", instructions: "x" },
      ]),
    );
    expect(plan).toMatchObject({ ok: false, error: { code: "mode_forbids" } });
  });

  it("design holds block planning until a human resumes", async () => {
    const jobId = await setup("repair");
    const passId = await begin();
    await observeWith(jobId, passId, [comment]);
    const held = await prm(
      "hold",
      "--job",
      jobId,
      "--kind",
      "design",
      "--reason",
      "Changes the public API.",
      "--source",
      "thread_comment:C1",
    );
    const plan = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C1", task: "repair", instructions: "x" },
      ]),
    );
    expect(plan).toMatchObject({ ok: false, error: { code: "job_held" } });
    expect(
      await prm("resume", "--job", jobId, "--clear", held.hold.holdId),
    ).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(
      (
        await prm(
          "resume",
          "--job",
          jobId,
          "--clear",
          held.hold.holdId,
          "--confirm-human",
          "Keep the API; fix locally.",
        )
      ).ok,
    ).toBe(true);
    await observeWith(jobId, passId, [comment]);
    const allowed = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C1", task: "repair", instructions: "x" },
      ]),
    );
    expect(allowed.ok).toBe(true);
  });

  it("validates reports against the order and suppresses settled sources on the next read", async () => {
    const jobId = await setup("repair");
    const passId = await begin();
    await observeWith(jobId, passId, [comment, question]);
    const plan = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C1", task: "repair", instructions: "Return []." },
        { sourceId: "thread_comment:C2", task: "answer", instructions: "Explain." },
      ]),
    );
    const batchId = plan.batchId as string;
    const bad = await prm(
      "report",
      "--batch",
      batchId,
      "--input",
      await reportFile(batchId, [
        {
          sourceId: "thread_comment:C1",
          revision: REV(2),
          outcome: "addressed",
          stage: "published",
        },
      ]),
    );
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_report" } });
    expect(bad.error.details.problems[0]).toContain("verifiedHeadSha");

    const report = await prm(
      "report",
      "--batch",
      batchId,
      "--input",
      await reportFile(
        batchId,
        [
          {
            sourceId: "thread_comment:C1",
            revision: REV(2),
            outcome: "addressed",
            stage: "replied",
            verifiedHeadSha: NEW_HEAD,
            publishedCommit: NEW_HEAD,
            responseIds: ["R1"],
          },
          {
            sourceId: "thread_comment:C2",
            revision: REV(3),
            outcome: "addressed",
            stage: "replied",
            verifiedHeadSha: NEW_HEAD,
            responseIds: ["R2"],
          },
        ],
        [
          { kind: "push", state: "known", commit: NEW_HEAD },
          {
            kind: "thread_comment",
            state: "known",
            providerId: "R1",
            actor: "me",
            body: "Fixed in cccc.",
          },
          {
            kind: "thread_comment",
            state: "known",
            providerId: "R2",
            actor: "me",
            body: "It follows FooBar.",
          },
        ],
        3,
      ),
    );
    expect(report).toMatchObject({ ok: true, batchState: "succeeded", holds: [] });
    expect(report.job.budgets.mutationAttemptsRemaining).toBe(97);

    await observeWith(
      jobId,
      passId,
      [{ kind: "thread_comment", id: "R1", revision: REV(4), body: "Fixed in cccc." }],
      NEW_HEAD,
    );
    const input = helperInputs.at(-1)!;
    expect(input.handledSources).toEqual([
      { kind: "thread_comment", id: "C1", revision: REV(2), headSha: NEW_HEAD },
      { kind: "thread_comment", id: "C2", revision: REV(3), headSha: NEW_HEAD },
    ]);
    expect(input.knownEffects).toHaveLength(2);
    expect(input.knownEffects[0]).toMatchObject({
      kind: "thread_comment",
      id: "R1",
      actor: "me",
    });
    const status = await prm("show", "--job", jobId);
    expect(status.obligations).toEqual([]);
  });

  it("does not re-plan a reported fix while the PR still shows the pre-fix head", async () => {
    const jobId = await setup("repair");
    const passId = await begin();
    await observeWith(jobId, passId, [comment]);
    const plan = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C1", task: "repair", instructions: "x" },
      ]),
    );
    await prm(
      "report",
      "--batch",
      plan.batchId,
      "--input",
      await reportFile(
        plan.batchId,
        [
          {
            sourceId: "thread_comment:C1",
            revision: REV(2),
            outcome: "addressed",
            stage: "published",
            verifiedHeadSha: NEW_HEAD,
            publishedCommit: NEW_HEAD,
          },
        ],
        [{ kind: "push", state: "known", commit: NEW_HEAD }],
        1,
      ),
    );
    const stale = await observeWith(jobId, passId, [comment], HEAD);
    expect(stale.outcome).toBe("waiting");
    expect(stale.obligations[0]).toMatchObject({ awaitingPublication: true });
    expect(stale.next).toContain("pre-fix head");
    const confirmed = await observeWith(jobId, passId, [comment], NEW_HEAD);
    expect(confirmed).toMatchObject({
      outcome: "ready",
      alreadySettled: 1,
      obligations: [],
    });
  });

  it("holds uncertain effects and refuses to clear them until the batch is re-reported", async () => {
    const jobId = await setup("repair");
    const passId = await begin();
    await observeWith(jobId, passId, [comment]);
    const plan = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C1", task: "repair", instructions: "x" },
      ]),
    );
    const batchId = plan.batchId as string;
    const findings = [
      {
        sourceId: "thread_comment:C1",
        revision: REV(2),
        outcome: "incomplete",
        stage: "committed",
        verifiedHeadSha: NEW_HEAD,
      },
    ];
    const uncertain = await prm(
      "report",
      "--batch",
      batchId,
      "--input",
      await reportFile(batchId, findings, [{ kind: "push", state: "uncertain" }], 1),
    );
    expect(uncertain).toMatchObject({
      batchState: "uncertain",
      holds: [{ kind: "uncertain_effect" }],
    });
    const holdId = uncertain.holds[0].holdId;
    expect(
      await prm("resume", "--job", jobId, "--clear", holdId, "--confirm-human", "ok"),
    ).toMatchObject({
      ok: false,
      error: { code: "effects_unsettled" },
    });
    const settled = await prm(
      "report",
      "--batch",
      batchId,
      "--input",
      await reportFile(batchId, findings, [{ kind: "push", state: "not_performed" }], 1),
    );
    expect(settled.batchState).toBe("partial");
    expect(
      (await prm("resume", "--job", jobId, "--clear", holdId, "--confirm-human", "ok"))
        .ok,
    ).toBe(true);
  });

  it("holds on repeated no-progress repairs of the same problem", async () => {
    const jobId = await setup("repair");
    const passId = await begin();
    const failRepair = async () => {
      await observeWith(jobId, passId, [comment]);
      const plan = await prm(
        "plan",
        "--pass",
        passId,
        "--job",
        jobId,
        "--input",
        await planFile([
          { sourceId: "thread_comment:C1", task: "repair", instructions: "x" },
        ]),
      );
      expect(plan.refused).toBe(false);
      await prm(
        "report",
        "--batch",
        plan.batchId,
        "--input",
        await reportFile(
          plan.batchId,
          [
            {
              sourceId: "thread_comment:C1",
              revision: REV(2),
              outcome: "failed",
              stage: "modified",
            },
          ],
          [],
          0,
        ),
      );
    };
    await failRepair();
    await failRepair();
    await observeWith(jobId, passId, [comment]);
    const third = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C1", task: "repair", instructions: "x" },
      ]),
    );
    expect(third).toMatchObject({ ok: true, refused: true, code: "no_progress" });
  });

  it("holds when the worker reports actions outside its permissions", async () => {
    const jobId = await setup("answer");
    const passId = await begin();
    await observeWith(jobId, passId, [question]);
    const plan = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C2", task: "answer", instructions: "x" },
      ]),
    );
    const violation = await prm(
      "report",
      "--batch",
      plan.batchId,
      "--input",
      await reportFile(
        plan.batchId,
        [
          {
            sourceId: "thread_comment:C2",
            revision: REV(3),
            outcome: "addressed",
            stage: "replied",
            responseIds: ["R9"],
          },
        ],
        [{ kind: "push", state: "known", commit: NEW_HEAD }],
        2,
      ),
    );
    expect(violation.ok).toBe(true);
    expect(violation.holds.map((hold: { kind: string }) => hold.kind)).toContain(
      "policy_violation",
    );
  });

  it("blocks a second job that targets an already maintained head branch", async () => {
    const first = await setup("observe");
    const second = (
      await prm("add", "https://github.com/octo/widgets/pull/8", "--mode", "observe")
    ).job.jobId as string;
    const passId = await begin();
    await observeWith(first, passId, []);
    const conflict = await observeWith(second, passId, []);
    expect(conflict).toMatchObject({
      outcome: "blocked",
      job: { holds: [{ kind: "ownership_conflict" }] },
    });
  });

  it("refuses a batch when the repair budget is used up", async () => {
    await prm("init");
    const added = await prm(
      "add",
      PR_URL,
      "--mode",
      "repair",
      "--checkout",
      dir,
      "--repair-batches",
      "1",
    );
    const jobId = added.job.jobId as string;
    const passId = await begin();
    await observeWith(jobId, passId, [comment, question]);
    const first = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C1", task: "repair", instructions: "x" },
      ]),
    );
    expect(first.refused).toBe(false);
    expect(
      (await prm("cancel", "--batch", first.batchId, "--reason", "changed my mind")).ok,
    ).toBe(true);
    const again = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C1", task: "repair", instructions: "x" },
      ]),
    );
    expect(again.refused).toBe(false);
    await prm(
      "report",
      "--batch",
      again.batchId,
      "--input",
      await reportFile(
        again.batchId,
        [
          {
            sourceId: "thread_comment:C1",
            revision: REV(2),
            outcome: "failed",
            stage: "modified",
          },
        ],
        [],
        0,
      ),
    );
    await observeWith(jobId, passId, [comment, question]);
    const over = await prm(
      "plan",
      "--pass",
      passId,
      "--job",
      jobId,
      "--input",
      await planFile([
        { sourceId: "thread_comment:C2", task: "repair", instructions: "x" },
      ]),
    );
    expect(over).toMatchObject({ refused: true, code: "budget_exhausted" });
  });
});

describe("pass recovery", () => {
  it("needs the active pass ID and a human confirmation", async () => {
    await setup("observe");
    const passId = await begin();
    expect(
      await prm("recover", "--pass", "wrong", "--confirm-stopped", "closed it"),
    ).toMatchObject({
      ok: false,
      error: { code: "recovery_conflict" },
    });
    expect(await prm("recover", "--pass", passId)).toMatchObject({
      ok: false,
      error: { code: "invalid_args" },
    });
    expect(
      (
        await prm(
          "recover",
          "--pass",
          passId,
          "--confirm-stopped",
          "I closed that terminal.",
        )
      ).ok,
    ).toBe(true);
    expect((await prm("begin")).ok).toBe(true);
  });
});
