import { describe, expect, it } from "vitest";
import { NodeSchema, SessionSchema, type Placement } from "@fleet/protocol";
import { localResume } from "./session-info";

const session = SessionSchema.parse({
  id: "fleet-id",
  workspaceId: "w1",
  workspaceName: "repo",
  placementId: "p1",
  nodeId: "n1",
  nodeName: "devbox",
  state: "stopped",
  initialPrompt: "Fix it",
  currentActivity: "",
  lastText: "",
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  agentSessionId: "native-id",
});
const node = NodeSchema.parse({
  id: "n1",
  name: "devbox",
  os: "win32",
  arch: "x64",
  version: "0.5.0",
  capabilities: ["real"],
  maxSessions: 3,
  activeSessions: 0,
  lastHeartbeat: session.updatedAt,
  online: true,
});
const placement: Placement = {
  id: "p1",
  workspaceId: "w1",
  nodeId: "n1",
  localPath: "Q:\\Repos\\O'Brien [work] $draft",
};

describe("localResume", () => {
  it("quotes Windows paths and native IDs, and stops if the directory cannot be entered", () => {
    const result = localResume(
      { ...session, agentSessionId: "native'id; Write-Error 'oops" },
      node,
      placement,
    );
    expect(result.shell).toBe("PowerShell");
    expect(result.command).toBe(
      "& {\n" +
        "  Set-Location -LiteralPath 'Q:\\Repos\\O''Brien [work] $draft' -ErrorAction Stop\n" +
        "  copilot --resume='native''id; Write-Error ''oops'\n" +
        "}",
    );
    expect(result.command).not.toContain(session.id);
  });

  it.each(["linux", "darwin"])(
    "quotes a %s path without interpolating shell syntax",
    (os) => {
      const result = localResume(
        session,
        { ...node, os },
        { ...placement, localPath: "/home/user/it's $(not a command)" },
      );
      expect(result.command).toBe(
        "cd -- '/home/user/it'\\''s $(not a command)' &&\ncopilot --resume='native-id'",
      );
    },
  );

  it("does not substitute the Fleet ID when the native ID is missing", () => {
    const result = localResume({ ...session, agentSessionId: "" }, node, placement);
    expect(result.command).toBeUndefined();
    expect(result.reason).toContain("native session ID");
  });

  it("does not invent a directory or platform from another node", () => {
    expect(localResume(session, node).reason).toContain("placement");
    expect(localResume(session, { ...node, id: "another" }, placement).reason).toContain(
      "operating system",
    );
    expect(
      localResume(session, node, { ...placement, nodeId: "another" }).reason,
    ).toContain("placement");
    expect(localResume(session, { ...node, os: "unknown" }, placement).reason).toContain(
      "unknown",
    );
  });

  it("never produces a command for demo sessions", () => {
    expect(
      localResume(session, { ...node, capabilities: ["mock"] }, placement).command,
    ).toBeUndefined();
    expect(
      localResume({ ...session, agentSessionId: "mock-123" }, node, placement).command,
    ).toBeUndefined();
  });
});
