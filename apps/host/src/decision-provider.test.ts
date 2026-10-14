import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionProviderSchema } from "@fleet/protocol";
import {
  DECISION_RESPONSE_BYTES,
  decisionPayload,
  evaluateDecision,
  parseDecisionAnswer,
  publicDecisionAddress,
} from "./decision-provider.js";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));

const validAnswer = () => ({
  model: "actual-decision-model",
  answers: {
    profile: {
      type: "choice",
      choice: "ordinary",
      probabilities: { ordinary: 0.9, deep: 0.1 },
      confidence: 0.8,
    },
  },
  usage: { input_tokens: 123, output_tokens: 2 },
});
const brief = {
  category: "implement",
  title: "Repair one behavior",
  deliverable: "A bounded patch",
  scope: "One component",
  verify: "The regression check passes",
};
const provider = DecisionProviderSchema.parse({
  id: "foundry",
  name: "Foundry",
  kind: "foundry",
  endpoint: "https://demo.services.ai.azure.com",
  model: "Exact-Deployment",
});
const payload = () =>
  decisionPayload(provider.model, brief, [
    { id: "ordinary", description: "Ordinary implementation." },
    { id: "deep", description: "Cross-component recovery work." },
  ]);
let responseBody: string;
let status: number;
let retryAfter: string | undefined;
let transportError: Error | undefined;
let sentBodies: string[];

class TestResponse extends EventEmitter {
  statusCode = status;
  headers = retryAfter ? { "retry-after": retryAfter } : {};
  destroyed = false;
  destroy() {
    this.destroyed = true;
    return this;
  }
}

beforeEach(() => {
  responseBody = JSON.stringify(validAnswer());
  status = 200;
  retryAfter = undefined;
  transportError = undefined;
  sentBodies = [];
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  mocks.request.mockImplementation(
    (_url: URL, _options: RequestOptions, callback: (response: TestResponse) => void) => {
      const req = new EventEmitter();
      return Object.assign(req, {
        end: (body: string) => {
          sentBodies.push(body);
          queueMicrotask(() => {
            if (transportError) {
              req.emit("error", transportError);
              return;
            }
            const res = new TestResponse();
            callback(res);
            if (!res.destroyed) res.emit("data", Buffer.from(responseBody));
            if (!res.destroyed) res.emit("end");
          });
        },
      });
    },
  );
});
afterEach(() => vi.resetAllMocks());

describe("decision response validation", () => {
  it("validates exact submitted choices and records missing usage as unknown", () => {
    expect(parseDecisionAnswer(validAnswer(), ["ordinary", "deep"])).toEqual({
      profileId: "ordinary",
      probabilities: { ordinary: 0.9, deep: 0.1 },
      returnedModel: "actual-decision-model",
      usage: { inputTokens: 123, outputTokens: 2 },
    });
    const { usage: _usage, ...withoutUsage } = validAnswer();
    expect(parseDecisionAnswer(withoutUsage, ["ordinary", "deep"]).usage).toBeNull();
  });

  it("rejects unknown, missing, non-finite, inconsistent and incomplete distributions", () => {
    for (const profile of [
      { type: "choice", choice: "unlisted", probabilities: { ordinary: 0.9, deep: 0.1 } },
      { type: "choice", choice: "deep", probabilities: { ordinary: 0.9, deep: 0.1 } },
      { type: "choice", choice: "ordinary", probabilities: { ordinary: 1 } },
      { type: "choice", choice: "ordinary", probabilities: { ordinary: 1, deep: NaN } },
      { type: "choice", choice: "ordinary", probabilities: { ordinary: 0.9, deep: 0.9 } },
      {
        type: "choice",
        choice: "ordinary",
        probabilities: { ordinary: 0.9, deep: -0.1 },
      },
      {
        type: "choice",
        choice: "ordinary",
        probabilities: { ordinary: 0.8, deep: 0.1, unknown: 0.1 },
      },
      { type: "score", score: 1 },
    ])
      expect(() =>
        parseDecisionAnswer({ ...validAnswer(), answers: { profile } }, [
          "ordinary",
          "deep",
        ]),
      ).toThrow();
  });
});

describe("provider-specific bounded HTTP", () => {
  it("uses the Foundry decision path, deployment name and API-key header", async () => {
    await expect(
      evaluateDecision(provider, "test-key", payload(), new AbortController().signal),
    ).resolves.toMatchObject({
      profileId: "ordinary",
    });
    expect(mocks.request).toHaveBeenCalledWith(
      new URL("https://demo.services.ai.azure.com/providers/microsoft/v1/systemone"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "api-key": "test-key" }),
      }),
      expect.any(Function),
    );
    expect(JSON.parse(sentBodies[0]!)).toMatchObject({
      model: "Exact-Deployment",
      state: brief,
    });
    expect(sentBodies[0]).not.toContain("test-key");
    expect(mocks.lookup).toHaveBeenCalledWith("demo.services.ai.azure.com", {
      all: true,
      verbatim: true,
    });
  });

  it("uses the direct TypeSafe endpoint and Bearer API-key header", async () => {
    const typesafe = DecisionProviderSchema.parse({
      ...provider,
      kind: "typesafe",
      endpoint: "https://api.typesafe.ai",
      model: "jev-latest",
    });
    await evaluateDecision(
      typesafe,
      "test-key",
      decisionPayload(typesafe.model, brief, [
        { id: "ordinary", description: "Ordinary" },
        { id: "deep", description: "Deep" },
      ]),
      new AbortController().signal,
    );
    expect(mocks.request).toHaveBeenCalledWith(
      new URL("https://api.typesafe.ai/v1/systemone"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
      expect.any(Function),
    );
    expect(mocks.request.mock.calls[0]?.[1].headers).not.toHaveProperty("api-key");
  });

  it.each([301, 302, 307, 308, 401, 403, 404, 422, 429, 503, 529])(
    "does not follow redirects or expose error bodies for HTTP %s",
    async (code) => {
      status = code;
      responseBody = "private-upstream-error-with-test-key";
      await expect(
        evaluateDecision(provider, "test-key", payload(), new AbortController().signal),
      ).rejects.toMatchObject({
        status: code,
        message: expect.not.stringContaining("test-key"),
      });
      expect(mocks.request).toHaveBeenCalledTimes(1);
    },
  );

  it("limits response bytes and rejects malformed JSON", async () => {
    for (const body of ["not-json", "x".repeat(DECISION_RESPONSE_BYTES + 1)]) {
      responseBody = body;
      await expect(
        evaluateDecision(provider, "test-key", payload(), new AbortController().signal),
      ).rejects.toMatchObject({ code: "invalid_answer" });
    }
  });

  it("rejects private or mixed DNS results before sending the key", async () => {
    for (const addresses of [
      [{ address: "127.0.0.1", family: 4 }],
      [{ address: "169.254.169.254", family: 4 }],
      [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
    ]) {
      mocks.lookup.mockResolvedValueOnce(addresses);
      await expect(
        evaluateDecision(provider, "test-key", payload(), new AbortController().signal),
      ).rejects.toMatchObject({ code: "network" });
    }
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("keeps transport exception details out of public errors", async () => {
    transportError = new Error("private exception containing test-key");
    await expect(
      evaluateDecision(provider, "test-key", payload(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "network",
      message: expect.not.stringContaining("test-key"),
    });
  });

  it("constructs state explicitly, excluding full worker context and credentials", () => {
    const input = {
      ...brief,
      context: "private transcript",
      key: "test-key",
      attachment: "bytes",
    };
    expect(
      decisionPayload(provider.model, input, [{ id: "ordinary", description: "Bounded" }])
        .state,
    ).toEqual(brief);
  });

  it.each([
    "127.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.1.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])("rejects non-public connection targets: %s", (address) =>
    expect(publicDecisionAddress(address)).toBe(false),
  );
});
