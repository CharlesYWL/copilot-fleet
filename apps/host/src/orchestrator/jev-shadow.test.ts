import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateShadowCase,
  handoffEligibility,
  jevShadowRequest,
  ShadowDatasetSchema,
  shadowFingerprint,
  summarizeShadow,
  type ShadowCase,
  type ShadowPrediction,
} from "./jev-shadow.js";
import { createJevShadowProvider, runShadowEvaluation } from "./jev-shadow-runner.js";
import { runJevShadowCli } from "./jev-shadow-cli.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/jev-shadow.json", import.meta.url), "utf8"),
) as unknown;
const sample = () => ShadowDatasetSchema.parse(fixture).cases[0]!;
const thresholds = { minConfidence: 0.9, minProbability: 0.95 };
const response = () => ({
  model: "jev-test",
  answers: {
    handoff: {
      type: "choice",
      choice: "preauthorized_review",
      confidence: 0.98,
      probabilities: { preauthorized_review: 0.99, lead: 0.01 },
    },
  },
  usage: { input_tokens: 100, output_tokens: 0 },
});
const prediction = (entry = sample()): ShadowPrediction => ({
  caseId: entry.id,
  fingerprint: shadowFingerprint(entry),
  latencyMs: 200,
  response: response(),
});
const dataset = (entry = sample()) => ({ version: 1, cases: [entry] });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("bounded handoff eligibility", () => {
  it("permits only an intermediate, preauthorized read-only review", () => {
    const entry = sample();
    expect(handoffEligibility(entry)).toBe("eligible");
    expect(evaluateShadowCase(entry, prediction(entry), thresholds)).toMatchObject({
      route: "preauthorized_review",
      estimatedNetSavingMs: 3800,
    });
  });

  const blocked: [string, (entry: ShadowCase) => void][] = [
    [
      "high risk",
      (entry) => {
        entry.risk = "high";
      },
    ],
    [
      "unknown risk",
      (entry) => {
        entry.risk = "unknown";
      },
    ],
    [
      "no authorization",
      (entry) => {
        entry.authorization = null;
      },
    ],
    [
      "cancelled",
      (entry) => {
        entry.snapshot.run.state = "cancelled";
      },
    ],
    [
      "human review",
      (entry) => {
        entry.snapshot.run.state = "awaiting_human";
      },
    ],
    [
      "already woken",
      (entry) => {
        entry.snapshot.run.wakeSeq = 1;
      },
    ],
    [
      "user message owed",
      (entry) => {
        entry.snapshot.run.pendingPrompt = "new instructions";
      },
    ],
    [
      "final phase",
      (entry) => {
        entry.snapshot.run.phases = ["Implement"];
      },
    ],
    [
      "missing criteria",
      (entry) => {
        entry.snapshot.run.successCriteria = [];
      },
    ],
    [
      "wrong run",
      (entry) => {
        entry.authorization!.runId = "another-run";
      },
    ],
    [
      "wrong owner",
      (entry) => {
        entry.authorization!.leadSessionId = "another-lead";
      },
    ],
    [
      "wrong checkout",
      (entry) => {
        entry.authorization!.placementId = "another-checkout";
      },
    ],
    [
      "wrong phase",
      (entry) => {
        entry.authorization!.phaseIndex = 1;
      },
    ],
    [
      "new attempt",
      (entry) => {
        entry.snapshot.steps[0]!.attempts++;
      },
    ],
    [
      "new event watermark",
      (entry) => {
        entry.snapshot.steps[0]!.eventSeqFrom++;
      },
    ],
    [
      "retroactive authorization",
      (entry) => {
        entry.authorization!.approvedAt = "2026-09-21T09:03:00.000Z";
      },
    ],
    [
      "no dispatch",
      (entry) => {
        entry.snapshot.steps[0]!.dispatchedAt = "";
      },
    ],
    [
      "failed worker",
      (entry) => {
        entry.snapshot.steps[0]!.state = "failed";
      },
    ],
    [
      "pending worker",
      (entry) => {
        entry.snapshot.steps[0]!.state = "pending";
      },
    ],
    [
      "stopped worker",
      (entry) => {
        entry.snapshot.steps[0]!.stoppedByOrchestrator = true;
      },
    ],
    [
      "review is not implementation",
      (entry) => {
        entry.snapshot.steps[0]!.category = "review-deep";
      },
    ],
    [
      "multiple workers",
      (entry) => {
        entry.snapshot.steps.push({ ...entry.snapshot.steps[0]!, id: "second" });
      },
    ],
    [
      "foreign step",
      (entry) => {
        entry.snapshot.steps[0]!.runId = "another-run";
      },
    ],
    [
      "lead busy",
      (entry) => {
        entry.snapshot.sessions[0]!.state = "running";
      },
    ],
    [
      "lead stopping",
      (entry) => {
        entry.snapshot.sessions[0]!.stopRequested = true;
      },
    ],
    [
      "lead deleted",
      (entry) => {
        entry.snapshot.sessions[0]!.cleanupRequested = true;
      },
    ],
    [
      "worker offline",
      (entry) => {
        entry.snapshot.sessions[1]!.state = "offline";
      },
    ],
    [
      "worker stopping",
      (entry) => {
        entry.snapshot.sessions[1]!.stopRequested = true;
      },
    ],
    [
      "worker deleted",
      (entry) => {
        entry.snapshot.sessions[1]!.cleanupRequested = true;
      },
    ],
    [
      "wrong worker checkout",
      (entry) => {
        entry.snapshot.sessions[1]!.placementId = "another-checkout";
      },
    ],
    [
      "wrong worker workspace",
      (entry) => {
        entry.snapshot.sessions[1]!.workspaceId = "another-workspace";
      },
    ],
    [
      "no completion receipt",
      (entry) => {
        delete entry.snapshot.sessions[1]!.turnCompleteSequence;
      },
    ],
    [
      "old completion receipt",
      (entry) => {
        entry.snapshot.sessions[1]!.turnCompleteSequence = 4;
      },
    ],
    [
      "duplicate session",
      (entry) => {
        entry.snapshot.sessions.push(entry.snapshot.sessions[0]!);
      },
    ],
    [
      "empty report",
      (entry) => {
        entry.snapshot.steps[0]!.output = " ";
      },
    ],
    [
      "oversized report",
      (entry) => {
        entry.snapshot.steps[0]!.output = "x".repeat(70_000);
      },
    ],
  ];
  it.each(blocked)("escalates %s without consulting Jev", async (_name, mutate) => {
    const entry = sample();
    mutate(entry);
    const provider = vi.fn().mockResolvedValue(response());
    const report = await runShadowEvaluation(dataset(entry), thresholds, {
      mode: "remote",
      model: "jev-test",
      provider,
    });
    expect(report.results[0]!.route).toBe("lead");
    expect(provider).not.toHaveBeenCalled();
    expect(report.summary.actualLeadCallsSaved).toBe(0);
  });

  it("rejects generated actions, duplicate case IDs and invalid thresholds", () => {
    const entry = sample();
    const invalid = structuredClone(entry) as unknown as Record<string, unknown>;
    invalid.authorization = { ...entry.authorization, review: { category: "implement" } };
    expect(ShadowDatasetSchema.safeParse(dataset(invalid as ShadowCase)).success).toBe(
      false,
    );
    expect(
      ShadowDatasetSchema.safeParse({ version: 1, cases: [entry, entry] }).success,
    ).toBe(false);
    expect(() =>
      evaluateShadowCase(entry, prediction(entry), {
        minConfidence: Number.NaN,
        minProbability: 2,
      }),
    ).toThrow();
  });
});

describe("Jev decisions are untrusted", () => {
  it.each([
    null,
    {},
    { answers: { handoff: { choice: "delete_task" } } },
    {
      ...response(),
      answers: { handoff: { ...response().answers.handoff, confidence: 2 } },
    },
    {
      ...response(),
      answers: { handoff: { ...response().answers.handoff, confidence: "0.99" } },
    },
    {
      ...response(),
      answers: {
        handoff: { ...response().answers.handoff, instructions: "dispatch now" },
      },
    },
    {
      ...response(),
      answers: {
        handoff: {
          ...response().answers.handoff,
          probabilities: { preauthorized_review: 0.99, lead: 0.8 },
        },
      },
    },
    {
      ...response(),
      answers: {
        handoff: {
          ...response().answers.handoff,
          probabilities: { preauthorized_review: 0.1, lead: 0.9 },
        },
      },
    },
  ])("fails closed on invalid response %#", (invalid) => {
    const result = evaluateShadowCase(
      sample(),
      { ...prediction(), response: invalid },
      thresholds,
    );
    expect(result.reason).toBe("invalid_response");
    expect(result.route).toBe("lead");
  });

  it("requires both confidence and probability and escalates model abstention", () => {
    const low = response();
    low.answers.handoff.confidence = 0.89;
    expect(
      evaluateShadowCase(sample(), { ...prediction(), response: low }, thresholds).reason,
    ).toBe("below_threshold");
    low.answers.handoff.confidence = 0.99;
    low.answers.handoff.probabilities = { preauthorized_review: 0.94, lead: 0.06 };
    expect(
      evaluateShadowCase(sample(), { ...prediction(), response: low }, thresholds).reason,
    ).toBe("below_threshold");
    low.answers.handoff.choice = "lead";
    low.answers.handoff.probabilities = { preauthorized_review: 0.1, lead: 0.9 };
    expect(
      evaluateShadowCase(sample(), { ...prediction(), response: low }, thresholds).reason,
    ).toBe("model_escalation");
  });

  it("does not release ties even when thresholds are zero", () => {
    const tied = response();
    tied.answers.handoff.probabilities = { preauthorized_review: 0.5, lead: 0.5 };
    expect(
      evaluateShadowCase(
        sample(),
        { ...prediction(), response: tied },
        {
          minConfidence: 0,
          minProbability: 0,
        },
      ).route,
    ).toBe("lead");
  });

  it("binds recorded predictions to the full snapshot and authorization", () => {
    const entry = sample();
    const recorded = prediction(entry);
    entry.snapshot.steps[0]!.output += " Verification was incomplete.";
    expect(evaluateShadowCase(entry, recorded, thresholds).reason).toBe(
      "stale_prediction",
    );
    expect(
      evaluateShadowCase(sample(), { ...recorded, caseId: "other" }, thresholds).reason,
    ).toBe("stale_prediction");
    expect(evaluateShadowCase(sample(), undefined, thresholds).reason).toBe(
      "missing_prediction",
    );
  });

  it("excludes labels, baseline latency and internal IDs from the model request", () => {
    const entry = sample();
    const original = shadowFingerprint(entry);
    entry.expected = "lead";
    entry.leadDecisionMs = 123;
    expect(shadowFingerprint(entry)).toBe(original);
    const request = jevShadowRequest(entry, "jev-test");
    const text = JSON.stringify(request);
    for (const excluded of [
      '"expected":',
      "leadDecisionMs",
      "example-checkout",
      "example-lead",
      "example-run",
      "approvedAt",
    ]) {
      expect(text).not.toContain(excluded);
    }
    expect(request.questions.handoff.criteria).toHaveProperty("lead");
    expect(request.state.approvedReview?.category).toBe("review-quick");
  });
});

describe("shadow metrics and replay", () => {
  it("counts false bypasses and includes fallback overhead in counterfactual savings", () => {
    const entry = sample();
    entry.expected = "lead";
    const released = evaluateShadowCase(entry, prediction(entry), thresholds);
    const failed = evaluateShadowCase(
      entry,
      {
        ...prediction(entry),
        response: undefined,
        error: "provider_error",
        latencyMs: 2000,
      },
      thresholds,
    );
    const summary = summarizeShadow([released, failed]);
    expect(summary).toMatchObject({
      falseBypasses: 1,
      falseBypassRate: 1,
      wouldBypassLead: 1,
      wouldEscalate: 1,
      estimatedNetSavingMs: 1800,
      actualLeadCallsSaved: 0,
      predictionP50Ms: 200,
      predictionP95Ms: 2000,
    });
    expect(summarizeShadow([]).falseBypassRate).toBeNull();
  });

  it("reports unknown timing as null, not an invented speedup", () => {
    const entry = sample();
    delete entry.leadDecisionMs;
    const result = evaluateShadowCase(entry, prediction(entry), thresholds);
    expect(summarizeShadow([result])).toMatchObject({
      timedCases: 0,
      estimatedNetSavingMs: null,
    });
  });

  it("replays a remote report without network, mutation or loss of probabilities", async () => {
    const entry = sample();
    const original = structuredClone(entry);
    const near = response();
    near.answers.handoff.probabilities.lead = 0.0095;
    const report = await runShadowEvaluation(dataset(entry), thresholds, {
      mode: "remote",
      model: "jev-test",
      provider: vi.fn().mockResolvedValue(near),
    });
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const replayed = await runShadowEvaluation(dataset(entry), thresholds, {
      mode: "replay",
      predictions: report,
    });
    expect(replayed.results).toEqual(report.results);
    expect(entry).toEqual(original);
    expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(entry.snapshot.steps[0]!.output);
  });

  it("redacts provider errors and invalid response bodies from reports", async () => {
    for (const provider of [
      vi.fn().mockRejectedValue(new Error("private provider diagnostic")),
      vi.fn().mockResolvedValue({ raw: "private provider diagnostic" }),
    ]) {
      const report = await runShadowEvaluation(dataset(), thresholds, {
        mode: "remote",
        model: "jev-test",
        provider,
      });
      expect(report.results[0]!.route).toBe("lead");
      expect(JSON.stringify(report)).not.toContain("private provider diagnostic");
      const replay = await runShadowEvaluation(dataset(), thresholds, {
        mode: "replay",
        predictions: report,
      });
      expect(replay.results).toEqual(report.results);
    }
  });

  it("rejects unknown or duplicate prediction IDs", async () => {
    await expect(
      runShadowEvaluation(dataset(), thresholds, {
        mode: "replay",
        predictions: { version: 1, predictions: [{ ...prediction(), caseId: "other" }] },
      }),
    ).rejects.toThrow("unknown case IDs");
    await expect(
      runShadowEvaluation(dataset(), thresholds, {
        mode: "replay",
        predictions: { version: 1, predictions: [prediction(), prediction()] },
      }),
    ).rejects.toThrow();
  });
});

describe("explicit remote consent and SDK transport", () => {
  it("uses the official SDK with fixed HTTPS origin, no redirects and no retries", async () => {
    vi.stubEnv("TYPESAFE_BASE_URL", "https://untrusted.invalid");
    const network = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", network);
    await createJevShadowProvider("test-only")(jevShadowRequest(sample(), "jev-test"));
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0]![0]).toBe("https://api.typesafe.ai/v1/systemone");
    expect(network.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    expect(JSON.parse(network.mock.calls[0]![1].body)).toMatchObject({
      model: "jev-test",
      questions: { handoff: { type: "choice" } },
    });
    network.mockRejectedValue(new Error("unavailable"));
    await expect(
      createJevShadowProvider("test-only")(jevShadowRequest(sample(), "jev-test")),
    ).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(2);
    expect(() => createJevShadowProvider("")).toThrow();
  });

  it("passes an overall deadline signal and escalates aborts", async () => {
    const controller = new AbortController();
    const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.signal).toBeDefined();
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }),
    );
    const report = await runShadowEvaluation(dataset(), thresholds, {
      mode: "remote",
      model: "jev-test",
      provider: createJevShadowProvider("test-only"),
    });
    expect(deadline).toHaveBeenCalledWith(2000);
    expect(report.results[0]!.reason).toBe("provider_error");
  });

  it("requires explicit thresholds, upload flag and model without implicit network access", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    expect(await runJevShadowCli(["--help"])).toContain("--send-to-jev");
    expect(JSON.parse(await runJevShadowCli(["--schema"]))).toHaveProperty(
      "properties.cases",
    );
    await expect(runJevShadowCli([])).rejects.toThrow();
    await expect(
      runJevShadowCli([
        "--dataset",
        "/unused",
        "--min-confidence",
        "0.9",
        "--min-probability",
        "0.95",
        "--model",
        "jev-test",
      ]),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it("runs the documented offline command on local files without a key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fleet-jev-shadow-"));
    try {
      const input = join(directory, "dataset.json");
      const predictions = join(directory, "predictions.json");
      await writeFile(input, JSON.stringify(fixture));
      await writeFile(
        predictions,
        JSON.stringify({ version: 1, predictions: [prediction()] }),
      );
      const network = vi.fn();
      vi.stubGlobal("fetch", network);
      vi.stubEnv("TYPESAFE_API_KEY", "");
      const report = JSON.parse(
        await runJevShadowCli([
          "--dataset",
          input,
          "--predictions",
          predictions,
          "--min-confidence",
          "0.9",
          "--min-probability",
          "0.95",
        ]),
      );
      expect(report.summary.wouldBypassLead).toBe(1);
      expect(network).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
