import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DecisionProviderSchema,
  WorkerExecutionProfilesSchema,
  WORKER_ROUTING_SETTINGS_KEY,
  type DecisionProvider,
  type DecisionProviderDraft,
  type WorkerExecutionProfile,
} from "@fleet/protocol";
import { fleet } from "./orchestrator/fleet-harness.js";
import {
  DECISION_REQUEST_BYTES,
  DecisionProviderError,
  type DecisionPayload,
  type RoutingBrief,
} from "./decision-provider.js";
import { ROUTING_FIELD_LIMITS } from "./routing-brief.js";
import { WorkerModelRoutingService } from "./worker-model-routing.js";
import { MAX_WORKER_ROUTING_CALLS } from "./store.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const profiles = WorkerExecutionProfilesSchema.parse([
  {
    id: "ordinary",
    name: "Ordinary",
    description: "Bounded ordinary implementation.",
    model: "worker-ordinary",
    reasoningEffort: "medium",
  },
  {
    id: "deep",
    name: "Deep",
    description: "Cross-component lifecycle and recovery.",
    model: "worker-deep",
    reasoningEffort: "high",
  },
]);
const brief: RoutingBrief = {
  category: "implement",
  title: "Repair recovery",
  deliverable: "A patch preserving recovery behavior",
  scope: "Recovery paths, no authentication redesign",
  verify: "Existing regression checks pass",
};
const actor = "operator:";

const connection = (
  id: string,
  kind: "foundry" | "typesafe" = "foundry",
): DecisionProvider =>
  DecisionProviderSchema.parse({
    id,
    name: id,
    kind,
    endpoint:
      kind === "foundry"
        ? "https://demo.services.ai.azure.com"
        : "https://api.typesafe.ai",
    model: kind === "foundry" ? `Exact-Deployment-${id}` : "jev-latest",
  });
function evaluation(payload: DecisionPayload, probability = 0.9) {
  const choices = Object.keys(payload.questions.profile.criteria);
  return {
    profileId: choices[0]!,
    probabilities: Object.fromEntries(
      choices.map((id, index) => [
        id,
        index === 0 ? probability : (1 - probability) / (choices.length - 1),
      ]),
    ),
    returnedModel: "underlying-decision-model",
    usage: { inputTokens: 100, outputTokens: 2 },
  };
}

async function setup(disk = false, rateIntervalMs = 0) {
  const f = fleet();
  const app = Fastify({ logger: false });
  const directory = disk
    ? await mkdtemp(join(tmpdir(), "fleet-worker-routing-"))
    : undefined;
  const credentialPath = directory ? join(directory, "decision-keys.json") : undefined;
  const evaluate = vi.fn(
    async (
      _provider: DecisionProvider,
      _key: string,
      payload: DecisionPayload,
      _signal: AbortSignal,
    ) => evaluation(payload),
  );
  const routing = new WorkerModelRoutingService(f.store, app.log, credentialPath, {
    evaluate,
    rateIntervalMs,
    now: () => Date.now(),
  });
  f.service.workerModelRouting = routing;
  await routing.initialize();
  cleanups.push(async () => {
    routing.reset();
    await app.close();
    f.store.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const configure = async (
    providers: DecisionProvider[] = [connection("primary")],
    mode: "off" | "shadow" | "route" = "route",
    policyProfiles: WorkerExecutionProfile[] = profiles,
    minProbability = 0.5,
    timeoutMs = 5000,
  ) => {
    const drafts: DecisionProviderDraft[] = [];
    for (const provider of providers) {
      const draft: DecisionProviderDraft = {
        provider,
        keyAction: "replace",
        key: `private-fixture-key-${provider.id}`,
      };
      const result = await routing.test(draft, actor);
      expect(result.success).toBe(true);
      drafts.push({ provider, keyAction: "replace", testToken: result.testToken });
    }
    const result = await routing.update(
      {
        expectedRevision: routing.view().revision,
        mode,
        providers: drafts,
        profiles: policyProfiles,
        minProbability,
        timeoutMs,
      },
      actor,
    );
    evaluate.mockClear();
    return result;
  };
  return { ...f, app, directory, credentialPath, routing, evaluate, configure };
}

describe("operator configuration and write-only credentials", () => {
  it("tests unsaved connections without starting a worker or saving fields", async () => {
    const h = await setup();
    const result = await h.routing.test(
      {
        provider: connection("new-model"),
        keyAction: "replace",
        key: "private-fixture-key",
      },
      actor,
    );
    expect(result).toMatchObject({
      success: true,
      returnedModel: "underlying-decision-model",
    });
    expect(h.routing.view()).toMatchObject({
      revision: 0,
      mode: "off",
      providers: [],
      profiles: [],
    });
    expect(h.store.listSessions()).toHaveLength(1);
    expect(h.store.listRuns()).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("private-fixture-key");
  });

  it("saves the tested key after the browser clears its password input, without paying twice", async () => {
    const h = await setup(true);
    const view = await h.configure();
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(view.providers[0]).toMatchObject({ ready: true, keyConfigured: true });
    const serialized = JSON.stringify({
      view,
      backup: h.store.exportHostBackup({ enrollmentToken: "" }),
      settings: h.store.getSetting("workerModelRouting.settings"),
      state: h.store.getSetting("workerModelRouting.providerState"),
    });
    expect(serialized).not.toContain("private-fixture-key-primary");
    expect(await readFile(h.credentialPath!, "utf8")).toContain(
      "private-fixture-key-primary",
    );
    const restarted = new WorkerModelRoutingService(
      h.store,
      h.app.log,
      h.credentialPath,
      { evaluate: h.evaluate, rateIntervalMs: 0 },
    );
    await restarted.initialize();
    expect(restarted.view().providers[0]?.ready).toBe(true);
    await restarted.decide(brief);
    expect(h.evaluate).toHaveBeenCalledTimes(1);
  });

  it("keeps, replaces and physically clears saved keys with revision checks", async () => {
    const h = await setup(true);
    await h.configure();
    const current = h.routing.view();
    await expect(
      h.routing.update(
        {
          expectedRevision: 0,
          mode: "off",
          minProbability: 0.5,
          timeoutMs: 5000,
          profiles,
          providers: [{ provider: connection("primary"), keyAction: "keep" }],
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "stale_revision" });
    const kept = await h.routing.update(
      {
        expectedRevision: current.revision,
        mode: "route",
        minProbability: 0.7,
        timeoutMs: 5000,
        profiles,
        providers: [{ provider: connection("primary"), keyAction: "keep" }],
      },
      actor,
    );
    expect(kept.providers[0]).toMatchObject({ keyConfigured: true, ready: true });
    const cleared = await h.routing.update(
      {
        expectedRevision: kept.revision,
        mode: "off",
        minProbability: 0.7,
        timeoutMs: 5000,
        profiles,
        providers: [{ provider: connection("primary"), keyAction: "clear" }],
      },
      actor,
    );
    expect(cleared.providers[0]).toMatchObject({ keyConfigured: false, ready: false });
    expect(await readFile(h.credentialPath!, "utf8")).not.toContain(
      "private-fixture-key-primary",
    );
  });

  it("does not reuse test proof for a changed deployment, key, actor or restored Host", async () => {
    const h = await setup();
    const draft: DecisionProviderDraft = {
      provider: connection("primary"),
      keyAction: "replace",
      key: "private-fixture-key",
    };
    const result = await h.routing.test(draft, actor);
    const request = {
      expectedRevision: 0,
      mode: "route" as const,
      minProbability: 0.5,
      timeoutMs: 5000,
      profiles,
      providers: [{ ...draft, testToken: result.testToken }],
    };
    for (const providers of [
      [
        {
          ...draft,
          provider: { ...draft.provider, model: "Changed" },
          testToken: result.testToken,
        },
      ],
      [{ ...draft, key: "different-key", testToken: result.testToken }],
    ])
      await expect(
        h.routing.update({ ...request, providers }, actor),
      ).rejects.toMatchObject({ code: "test_stale" });
    await expect(
      h.routing.update(request, "administrator:someone-else"),
    ).rejects.toMatchObject({ code: "test_stale" });
    h.store.replaceHostBackup(h.store.exportHostBackup({ enrollmentToken: "" }));
    await expect(
      h.routing.update(
        {
          ...request,
          expectedRevision: h.routing.view().revision,
          providers: [
            {
              provider: draft.provider,
              keyAction: "replace",
              testToken: result.testToken,
            },
          ],
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "key_required" });
    expect(h.routing.view()).toMatchObject({ mode: "off", suspended: true });
  });

  it("requires new keys for a new destination and a tested connection for Route", async () => {
    const h = await setup();
    await h.configure();
    await expect(
      h.routing.test(
        {
          provider: {
            ...connection("primary"),
            endpoint:
              "https://another.services.ai.azure.com/providers/microsoft/v1/systemone",
          },
          keyAction: "keep",
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "key_destination_changed" });
    await expect(
      h.routing.update(
        {
          expectedRevision: h.routing.view().revision,
          mode: "route",
          minProbability: 0.5,
          timeoutMs: 5000,
          profiles,
          providers: [
            {
              provider: connection("primary"),
              keyAction: "replace",
              key: "untested-replacement",
            },
          ],
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "test_required" });
    expect(h.routing.view().providers[0]?.ready).toBe(true);
  });

  it("protects the credential directory and file on the actual platform", async () => {
    const h = await setup(true);
    await h.configure();
    if (process.platform !== "win32") {
      expect((await stat(h.directory!)).mode & 0o777).toBe(0o700);
      expect((await stat(h.credentialPath!)).mode & 0o777).toBe(0o600);
      return;
    }
    const path = h.credentialPath!.replace(/'/g, "''");
    const { stdout } = await promisify(execFile)(
      `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop';$file=[System.IO.FileInfo]'${path}';$acl=$file.GetAccessControl();$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;access=$_.AccessControlType.ToString()}});@{me=$me;protected=$acl.AreAccessRulesProtected;sddl=$acl.Sddl;rules=$rules}|ConvertTo-Json -Depth 4 -Compress`,
      ],
      { windowsHide: true },
    );
    const acl: {
      me: string;
      protected: boolean;
      rules: { sid: string; access: string }[];
    } = JSON.parse(stdout);
    expect(acl.rules.every((rule) => rule.access === "Allow")).toBe(true);
    expect(new Set(acl.rules.map((rule) => rule.sid)), stdout).toEqual(
      new Set([acl.me, "S-1-5-18", "S-1-5-32-544"]),
    );
  });

  it("redacts arbitrary transport exceptions and echoed credentials", async () => {
    const h = await setup();
    const warn = vi.spyOn(h.app.log, "warn");
    h.evaluate.mockRejectedValueOnce(
      new Error("private-fixture-key in an upstream exception"),
    );
    const failure = await h.routing.test(
      {
        provider: connection("primary"),
        keyAction: "replace",
        key: "private-fixture-key",
      },
      actor,
    );
    expect(JSON.stringify({ failure, logs: warn.mock.calls })).not.toContain(
      "private-fixture-key",
    );
    h.evaluate.mockImplementationOnce(async (_provider, _key, payload) => ({
      ...evaluation(payload),
      returnedModel: "echo-private-fixture-key",
    }));
    const result = await h.routing.test(
      {
        provider: connection("primary"),
        keyAction: "replace",
        key: "private-fixture-key",
      },
      actor,
    );
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-fixture-key");
  });
});

describe("ordered decision-model fallback", () => {
  it("makes zero automatic calls while Off and ignores explicit profile hints", async () => {
    const h = await setup();
    await h.configure([connection("primary")], "off");
    expect(
      await h.routing.decide({ ...brief, profile: "not-a-profile" }),
    ).toBeUndefined();
    expect(h.evaluate).not.toHaveBeenCalled();
  });

  it("allows explicit profiles across categories and skips classification in both active modes", async () => {
    const h = await setup();
    await h.configure([connection("primary")], "shadow");
    const explicit = await h.routing.decide({
      ...brief,
      category: "explore",
      profile: "deep",
    });
    expect(explicit).toMatchObject({
      source: "explicit",
      profileId: "deep",
      model: "worker-deep",
    });
    expect(h.evaluate).not.toHaveBeenCalled();
    await expect(
      h.routing.decide({ ...brief, profile: "unknown" }),
    ).rejects.toMatchObject({ code: "unknown_profile" });
  });

  it("records shadow predictions without applying them, and selects a single candidate locally", async () => {
    const h = await setup();
    h.store.setDefaultModel("ordinary-default");
    await h.configure([connection("primary")], "shadow");
    const shadow = await h.routing.decide(brief);
    expect(shadow).toMatchObject({
      source: "shadow",
      profileId: "ordinary",
      model: "worker-ordinary",
      fallbackReason: "shadow",
    });
    expect(h.service.workerSelectionFor(shadow!)).toMatchObject({
      source: "shadow",
      model: "ordinary-default",
    });
    h.evaluate.mockClear();
    await h.configure([connection("primary")], "shadow", [profiles[1]!]);
    const single = await h.routing.decide({ ...brief, category: "review-deep" });
    expect(single).toMatchObject({ source: "shadow", profileId: "deep" });
    expect(h.evaluate).not.toHaveBeenCalled();
  });

  it("falls back from a failed Foundry deployment to a second Foundry model and then TypeSafe", async () => {
    const h = await setup();
    await h.configure([
      connection("primary"),
      connection("second-foundry"),
      connection("typesafe", "typesafe"),
    ]);
    h.evaluate
      .mockRejectedValueOnce(new DecisionProviderError("deployment", 404))
      .mockRejectedValueOnce(new DecisionProviderError("provider_error", 500));
    const receipt = await h.routing.decide(brief);
    expect(receipt).toMatchObject({
      source: "decision",
      profileId: "ordinary",
      model: "worker-ordinary",
    });
    expect(receipt?.attempts.map((attempt) => [attempt.kind, attempt.success])).toEqual([
      ["foundry", false],
      ["foundry", false],
      ["typesafe", true],
    ]);
    expect(h.evaluate.mock.calls.map(([provider]) => provider.id)).toEqual([
      "primary",
      "second-foundry",
      "typesafe",
    ]);
  });

  it("tries another decision model below threshold, then defaults when none qualifies", async () => {
    const h = await setup();
    await h.configure(
      [connection("primary"), connection("secondary", "typesafe")],
      "route",
      profiles,
      0.8,
    );
    h.evaluate.mockImplementation(async (_provider, _key, payload) =>
      evaluation(payload, 0.6),
    );
    const receipt = await h.routing.decide(brief);
    expect(receipt).toMatchObject({
      source: "fallback",
      fallbackReason: "low_probability",
    });
    expect(receipt?.attempts).toHaveLength(2);
    expect(h.service.workerSelectionFor(receipt!).profileId).toBeUndefined();
  });

  it("reserves time for the fallback when the primary never responds", async () => {
    const h = await setup();
    await h.configure(
      [connection("primary"), connection("secondary", "typesafe")],
      "route",
      profiles,
      0.5,
      500,
    );
    vi.useFakeTimers();
    h.evaluate.mockImplementation(async (provider, _key, payload) =>
      provider.id === "primary" ? new Promise(() => {}) : evaluation(payload),
    );
    const pending = h.routing.decide(brief);
    await vi.advanceTimersByTimeAsync(250);
    const result = await pending;
    expect(result?.source).toBe("decision");
    expect(result?.attempts.map((attempt) => attempt.code ?? "success")).toEqual([
      "timeout",
      "success",
    ]);
    expect(result?.durationMs).toBe(250);
  });

  it("caps the entire fallback chain, including rate-limit waiting", async () => {
    const h = await setup();
    await h.configure(
      [connection("primary"), connection("secondary")],
      "route",
      profiles,
      0.5,
      500,
    );
    vi.useFakeTimers();
    h.evaluate.mockImplementation(async () => new Promise(() => {}));
    const pending = h.routing.decide(brief);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({
      source: "fallback",
      fallbackReason: "timeout",
      durationMs: 500,
    });
  });

  it("does not skip an ordered fallback just because its permit needs part of the shared budget", async () => {
    const h = await setup(true);
    await h.configure(
      [connection("primary"), connection("secondary")],
      "route",
      profiles,
      0.5,
      600,
    );
    const paced = new WorkerModelRoutingService(h.store, h.app.log, h.credentialPath, {
      evaluate: h.evaluate,
      rateIntervalMs: 400,
      now: () => Date.now(),
    });
    await paced.initialize();
    vi.useFakeTimers();
    h.evaluate.mockRejectedValueOnce(new DecisionProviderError("deployment", 404));
    const pending = paced.decide(brief);
    await vi.advanceTimersByTimeAsync(400);
    expect(await pending).toMatchObject({ source: "decision", durationMs: 400 });
    expect(h.evaluate.mock.calls.map(([provider]) => provider.id)).toEqual([
      "primary",
      "secondary",
    ]);
    paced.reset();
  });

  it("retries throttling at most once within budget but never retries invalid requests", async () => {
    const h = await setup();
    await h.configure();
    h.evaluate.mockRejectedValueOnce(new DecisionProviderError("throttled", 429, 0));
    expect((await h.routing.decide(brief))?.source).toBe("decision");
    expect(h.evaluate).toHaveBeenCalledTimes(2);
    h.evaluate
      .mockClear()
      .mockRejectedValue(new DecisionProviderError("invalid_request", 422));
    expect((await h.routing.decide(brief))?.fallbackReason).toBe("provider_error");
    expect(h.evaluate).toHaveBeenCalledTimes(1);
  });

  it("invalidates authentication readiness and skips that model on later assignments", async () => {
    const h = await setup();
    await h.configure([connection("primary"), connection("secondary", "typesafe")]);
    h.evaluate.mockRejectedValueOnce(new DecisionProviderError("authentication", 401));
    expect((await h.routing.decide(brief))?.source).toBe("decision");
    expect(h.routing.view().providers[0]?.ready).toBe(false);
    h.evaluate.mockClear();
    await h.routing.decide(brief);
    expect(h.evaluate.mock.calls.map(([provider]) => provider.id)).toEqual(["secondary"]);
  });

  it("clips an oversized brief and still routes it, and handles an empty profile list", async () => {
    const h = await setup();
    await h.configure();
    const result = await h.routing.decide({ ...brief, deliverable: "é".repeat(17_000) });
    expect(result?.source).toBe("decision");
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    const sent = h.evaluate.mock.calls[0]![2];
    expect(sent.state.deliverable.length).toBeLessThanOrEqual(
      ROUTING_FIELD_LIMITS.deliverable,
    );
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(
      DECISION_REQUEST_BYTES,
    );
    h.evaluate.mockClear();
    await h.configure([connection("primary")], "route", []);
    expect(
      (await h.routing.decide({ ...brief, category: "explore" }))?.fallbackReason,
    ).toBe("no_candidates");
    expect(h.evaluate).not.toHaveBeenCalled();
  });

  it("considers every profile by description, including profiles saved with legacy category restrictions", async () => {
    const h = await setup();
    await h.configure();
    const configuration = h.store.getWorkerModelRouting();
    h.store.setSetting(
      WORKER_ROUTING_SETTINGS_KEY,
      JSON.stringify({
        ...configuration,
        profiles: configuration.profiles.map((profile) => ({
          ...profile,
          categories: ["implement"],
        })),
      }),
    );
    const result = await h.routing.decide({ ...brief, category: "explore" });
    expect(result).toMatchObject({ source: "decision", profileId: "ordinary" });
    expect(h.evaluate.mock.calls[0]?.[2].state.category).toBe("explore");
    expect(h.evaluate.mock.calls[0]?.[2].questions.profile.criteria).toEqual(
      Object.fromEntries(profiles.map((profile) => [profile.id, profile.description])),
    );
    expect(h.routing.view().profiles.every((profile) => !("categories" in profile))).toBe(
      true,
    );
  });

  it("sends the decision model a cleaned brief with the task context and records the call", async () => {
    const h = await setup();
    await h.configure();
    const result = await h.routing.decide(
      {
        ...brief,
        title: "Review 8536a1fcd0de149d659af95cd6a94abf8d348441",
        scope: "Read C:\\Users\\someone\\.copilot\\session-state\\files\\HANDOFF.md only",
        taskContext: {
          name: "S07 authoring",
          objective: "Deliver one reviewed PR",
          phase: "3 of 3: Review and publish",
          plan: "Inspect → Implement → Review and publish",
        },
      },
      { runId: "run-1" },
    );
    expect(result?.source).toBe("decision");
    const payload = h.evaluate.mock.calls[0]?.[2];
    expect(payload?.state).toMatchObject({
      category: "implement",
      title: "Review <hash>",
      scope: "Read <path> only",
      task: {
        name: "S07 authoring",
        objective: "Deliver one reviewed PR",
        phase: "3 of 3: Review and publish",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("8536a1fc");
    expect(JSON.stringify(payload)).not.toContain("someone");

    const [call] = h.store.listWorkerRoutingCalls({ runId: "run-1" });
    expect(call).toMatchObject({
      runId: "run-1",
      category: "implement",
      source: "decision",
      profileId: "ordinary",
      mode: "route",
    });
    expect(call?.request).toEqual({
      state: payload?.state,
      questions: payload?.questions,
    });
    expect(call?.receipt.attempts).toHaveLength(1);
    expect(JSON.stringify(call)).not.toContain("private-fixture-key");
  });

  it("records fallbacks and explicit picks, but nothing while routing is off", async () => {
    const h = await setup();
    await h.configure();
    h.evaluate.mockRejectedValueOnce(new DecisionProviderError("provider_error", 500));
    await h.routing.decide(brief, { runId: "run-fallback" });
    await h.routing.decide({ ...brief, profile: "deep" }, { runId: "run-explicit" });
    const calls = h.store.listWorkerRoutingCalls();
    expect(
      calls.map((entry) => [entry.runId, entry.source, entry.fallbackReason]),
    ).toEqual([
      ["run-explicit", "explicit", ""],
      ["run-fallback", "fallback", "provider_error"],
    ]);
    expect(calls[1]?.receipt.attempts[0]).toMatchObject({ code: "provider_error" });
    // An explicit pick never reaches the provider, so there is no request to keep.
    expect(calls[0]?.request).toBeUndefined();

    await h.configure([connection("primary")], "off");
    expect(await h.routing.decide(brief, { runId: "run-off" })).toBeUndefined();
    expect(h.store.listWorkerRoutingCalls({ runId: "run-off" })).toEqual([]);
  });

  it("never lets a failed debug write hold up or refuse a dispatch", async () => {
    const h = await setup();
    await h.configure();
    vi.spyOn(h.store, "recordWorkerRoutingCall").mockImplementation(() => {
      throw new Error("disk full");
    });
    const result = await h.routing.decide(brief, { runId: "run-x" });
    expect(result?.source).toBe("decision");
  });

  it("keeps only the newest debug rows", async () => {
    const h = await setup();
    await h.configure();
    for (let index = 0; index < MAX_WORKER_ROUTING_CALLS + 5; index++)
      h.store.recordWorkerRoutingCall({
        id: `call-${index}`,
        runId: "run-cap",
        category: "implement",
        receipt: {
          version: 1,
          mode: "route",
          source: "fallback",
          policyRevision: 1,
          createdAt: new Date().toISOString(),
          durationMs: 1,
          attempts: [],
          fallbackReason: "timeout",
        },
      });
    const kept = h.store.listWorkerRoutingCalls({ runId: "run-cap", limit: 500 });
    expect(kept[0]?.id).toBe(`call-${MAX_WORKER_ROUTING_CALLS + 4}`);
    expect(h.store.countWorkerRoutingCalls()).toBe(MAX_WORKER_ROUTING_CALLS);
  });

  it("keeps the 32 KiB backstop for text that grows when encoded, without calling the provider", async () => {
    const h = await setup();
    await h.configure();
    // A control character becomes six bytes in JSON, so a brief that fits every
    // field cap can still exceed the request limit.
    const expanding = "\u0001".repeat(5_000);
    const result = await h.routing.decide({
      ...brief,
      title: expanding,
      deliverable: expanding,
      scope: expanding,
      verify: expanding,
      taskContext: {
        name: expanding,
        objective: expanding,
        phase: expanding,
        plan: expanding,
      },
    });
    expect(result?.fallbackReason).toBe("over_size");
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.store.listWorkerRoutingCalls()[0]).toMatchObject({
      source: "fallback",
      fallbackReason: "over_size",
    });
  });

  it("freezes defaults and the profile policy, and discards late decisions after disable", async () => {
    const h = await setup();
    h.store.setDefaultModel("frozen-default");
    await h.configure();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.evaluate.mockImplementation(async (_provider, _key, payload) => {
      await gate;
      return evaluation(payload);
    });
    const pending = h.routing.decide(brief);
    h.store.setDefaultModel("later-default");
    h.store.setWorkerModelRouting({ ...h.store.getWorkerModelRouting(), mode: "off" });
    release!();
    const receipt = await pending;
    expect(receipt).toMatchObject({
      source: "fallback",
      fallbackReason: "disabled",
      defaults: { model: "frozen-default" },
    });
    expect(h.service.workerSelectionFor(receipt!).model).toBe("frozen-default");
  });

  it("bounds simultaneous HTTP work at two", async () => {
    const h = await setup();
    await h.configure();
    let active = 0;
    let maximum = 0;
    h.evaluate.mockImplementation(async (_provider, _key, payload) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return evaluation(payload);
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => h.routing.decide(brief)),
    );
    expect(maximum).toBe(2);
    expect(results.every((result) => result?.source === "decision")).toBe(true);
  });
});

describe("operator-reviewed profile proposals", () => {
  it("never applies a lead proposal, preserves stable revision checks and rejects stale approval", async () => {
    const h = await setup();
    await h.configure();
    const before = h.routing.view();
    const proposed = profiles.map((profile) => ({
      ...profile,
      name: `${profile.name} revised`,
    }));
    const proposal = h.routing.propose(
      {
        expectedRevision: before.revision,
        reason: "A clearer distinction between ordinary and deep behavior.",
        profiles: proposed,
      },
      h.leadId,
      "Lead",
    );
    expect(h.routing.view().profiles).toEqual(profiles);
    expect(h.routing.view().proposals).toHaveLength(1);
    const applied = h.routing.reviewProposal(proposal.id, "apply", before.revision);
    expect(applied.profiles).toEqual(proposed);
    expect(applied.revision).toBe(before.revision + 1);
    expect(applied.proposals).toHaveLength(0);
    const stale = h.routing.propose(
      {
        expectedRevision: applied.revision,
        reason: "A second bounded edit proposed for review.",
        profiles,
      },
      h.leadId,
      "Lead",
    );
    h.store.setWorkerModelRouting({
      ...h.store.getWorkerModelRouting(),
      revision: applied.revision + 1,
    });
    expect(() => h.routing.reviewProposal(stale.id, "apply", applied.revision)).toThrow();
    expect(
      h.routing.reviewProposal(stale.id, "reject", applied.revision).proposals,
    ).toHaveLength(0);
  });
});
