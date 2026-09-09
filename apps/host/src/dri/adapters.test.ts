import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DriLimitsSchema, DriQuerySchema } from "@fleet/protocol";
import { fixtureHar } from "./fixtures.js";
import { dmsProfile } from "./profiles.js";
import { assertProviderPageCapability, ProviderPageSchema } from "./providers.js";
import {
  compileTelemetryReadPlan,
  LocalArtifactReader,
  SdkMcpReadClient,
} from "./adapters.js";

const query = DriQuerySchema.parse({
  id: "query",
  investigationId: "investigation",
  profileId: "dms",
  generation: 1,
  attempt: 1,
  invocationId: "domain",
  createdAt: "2025-01-01T00:00:00.000Z",
  kind: "queries",
  key: "query-key",
  stepId: "step",
  agentId: "agent",
  providerId: "telemetry",
  capability: "telemetry.query",
  purpose: "Compare technical cohorts",
  template: "dms.operation-cohorts.v1",
  parameters: [],
  privateParameterNames: ["environment"],
  parameterHash: "a".repeat(64),
  bounds: DriLimitsSchema.parse({}),
  timeRange: { start: "2025-01-01T00:00:00.000Z", end: "2025-01-01T01:00:00.000Z" },
  state: "running",
  summary: "",
  error: "none",
  rows: 0,
  bytes: 0,
  pages: 0,
  cursor: "",
});
describe("read-only provider adapters", () => {
  it("compiles parameterized narrow telemetry without interpolating caller values or management commands", () => {
    const mapping = {
      table: "FixtureOperations",
      timestamp: "Time",
      environment: "Environment",
      correlation: "Correlation",
      outcome: "Outcome",
      operation: "Operation",
      duration: "Duration",
      signature: "Signature",
    };
    const plan = compileTelemetryReadPlan(dmsProfile, query, mapping);
    expect(plan.text.indexOf("| where Environment")).toBeLessThan(
      plan.text.indexOf("| where Time"),
    );
    expect(plan.text).toContain("| take 200");
    expect(plan.text).toContain("| project Timestamp=Time");
    expect(plan.parameterNames).toEqual([
      "_environment",
      "_start",
      "_end",
      "_correlation",
    ]);
    expect(plan.text).not.toContain("password");
    expect(() =>
      compileTelemetryReadPlan(dmsProfile, query, {
        ...mapping,
        table: "T; .drop table T",
      }),
    ).toThrow();
    expect(() =>
      compileTelemetryReadPlan(
        dmsProfile,
        {
          ...query,
          timeRange: {
            start: "2025-01-01T00:00:00.000Z",
            end: "2025-02-01T00:00:00.000Z",
          },
        },
        mapping,
      ),
    ).toThrow(/bounds/);
  });
  it("projects complete paginated SDK discovery while refusing write dispatch", async () => {
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({
        tools: [
          { name: "get_incident_details_by_id", annotations: { readOnlyHint: true } },
          { name: "update_incident", annotations: { readOnlyHint: true } },
        ],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        tools: [{ name: "get_similar_incidents", annotations: { readOnlyHint: true } }],
      });
    const callTool = vi.fn(async () => ({ content: [] }));
    const client = new SdkMcpReadClient({ listTools, callTool } as unknown as Client);
    const signal = new AbortController().signal;
    expect((await client.discover(signal)).map((tool) => tool.name)).toEqual([
      "get_incident_details_by_id",
      "get_similar_incidents",
    ]);
    expect(listTools).toHaveBeenCalledTimes(2);
    await expect(client.call("update_incident", {}, signal)).rejects.toThrow(
      /allowlisted/,
    );
    expect(callTool).not.toHaveBeenCalled();
  });
  it("rejects evidence claimed outside a provider capability", () => {
    const page = ProviderPageSchema.parse({
      state: "succeeded",
      summary: "Untrusted claim",
      evidence: [
        {
          type: "telemetry",
          finding: "Unsupported root cause",
          observedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(() => assertProviderPageCapability("incident.read", page)).toThrow(/scope/);
  });
  it("reads only bounded approved local artifacts and rejects traversal, expiry and absence", async () => {
    const directory = join(process.cwd(), ".dri-test-work", randomUUID());
    mkdirSync(directory, { recursive: true });
    try {
      writeFileSync(join(directory, "synthetic.har"), fixtureHar);
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const reader = new LocalArtifactReader(
        directory,
        new Map([
          [
            "artifact:approved",
            {
              relativePath: "synthetic.har",
              mediaType: "application/json" as const,
              expiresAt,
            },
          ],
          [
            "artifact:traversal",
            {
              relativePath: "..\\..\\outside",
              mediaType: "application/json" as const,
              expiresAt,
            },
          ],
          [
            "artifact:expired",
            {
              relativePath: "synthetic.har",
              mediaType: "application/json" as const,
              expiresAt: "2000-01-01T00:00:00.000Z",
            },
          ],
        ]),
      );
      const signal = new AbortController().signal;
      const artifact = await reader.read(
        "artifact:approved",
        DriLimitsSchema.parse({}),
        signal,
      );
      expect(artifact.size).toBe(Buffer.byteLength(fixtureHar));
      await expect(
        reader.read("artifact:traversal", DriLimitsSchema.parse({}), signal),
      ).rejects.toThrow(/outside/);
      await expect(
        reader.read("artifact:expired", DriLimitsSchema.parse({}), signal),
      ).rejects.toThrow(/expired/);
      await expect(
        reader.read("artifact:missing", DriLimitsSchema.parse({}), signal),
      ).rejects.toThrow(/missing/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
