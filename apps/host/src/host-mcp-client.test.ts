import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CopilotSdk from "@github/copilot-sdk";
import {
  CopilotHostMcpClient,
  hostMcpSourceDigest,
  hostMcpUnavailable,
  listConfiguredHostMcps,
} from "./host-mcp-client.js";

const runtime = vi.hoisted(() => {
  const session = {
    rpc: {
      mcp: {
        startServer: vi.fn(),
        listTools: vi.fn(),
        oauth: { login: vi.fn() },
        resources: { read: vi.fn(), list: vi.fn() },
      },
      tools: {
        initializeAndValidate: vi.fn(),
        getCurrentMetadata: vi.fn(),
        execute: vi.fn(),
      },
    },
  };
  return {
    session,
    start: vi.fn(),
    stop: vi.fn(),
    forceStop: vi.fn(),
    createSession: vi.fn(),
    config: vi.fn(),
  };
});

vi.mock("@github/copilot-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof CopilotSdk>();
  return {
    ...actual,
    CopilotClient: class {
      start = runtime.start;
      stop = runtime.stop;
      forceStop = runtime.forceStop;
      createSession = runtime.createSession;
      rpc = { mcp: { config: { list: runtime.config } } };
    },
  };
});

const clients: CopilotHostMcpClient[] = [];
const create = () => {
  const client = new CopilotHostMcpClient({
    name: "figma",
    url: "https://mcp.figma.com/mcp",
    tools: ["whoami"],
    readOnly: false,
    resources: ["skill://figma/figma-design-to-code/SKILL.md"],
    nodeIds: [],
    sessionIds: [],
  });
  clients.push(client);
  return client;
};
beforeEach(() => {
  vi.resetAllMocks();
  runtime.createSession.mockResolvedValue(runtime.session);
  runtime.config.mockResolvedValue({ servers: { figma: {}, unrelated: {} } });
  runtime.session.rpc.mcp.listTools.mockResolvedValue({ tools: [{ name: "whoami" }] });
  runtime.session.rpc.mcp.oauth.login.mockResolvedValue({});
  runtime.session.rpc.tools.getCurrentMetadata.mockResolvedValue({
    tools: [
      {
        name: "figma-whoami",
        mcpServerName: "figma",
        mcpToolName: "whoami",
        description: "Identity",
        input_schema: { type: "object" },
      },
    ],
  });
  runtime.session.rpc.tools.execute.mockResolvedValue({
    resultType: "success",
    contents: [{ type: "text", text: "identity" }],
  });
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.useRealTimers();
});

describe("Host Copilot MCP client", () => {
  it("reads catalog metadata without materializing an MCP or prompting a model", async () => {
    const result = await listConfiguredHostMcps();
    expect(result).toEqual({ figma: {}, unrelated: {} });
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.session.rpc.mcp.startServer).not.toHaveBeenCalled();
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("uses only the pinned Host stdio definition and rejects configuration substitution", async () => {
    const source = {
      command: "host-mcp.exe",
      args: ["local-secret"],
      cwd: "C:\\Host",
      env: { SECRET: "stays-on-host" },
    };
    runtime.config.mockResolvedValue({ servers: { figma: source, unrelated: {} } });
    const config = {
      name: "figma",
      source: "host" as const,
      sourceDigest: hostMcpSourceDigest(source),
      tools: ["whoami"],
      readOnly: false,
      resources: [],
      nodeIds: [],
      sessionIds: [],
      allNodes: true,
    };
    const client = new CopilotHostMcpClient(config);
    clients.push(client);
    await client.listTools();
    const options = runtime.createSession.mock.calls[0]![0];
    expect(options.mcpServers.figma).toMatchObject({
      command: "host-mcp.exe",
      args: ["local-secret"],
      workingDirectory: "C:\\Host",
      env: { SECRET: "stays-on-host" },
      tools: ["whoami"],
    });
    expect(options.availableTools.toArray()).toEqual(["mcp:figma-whoami"]);
    runtime.config.mockResolvedValue({
      servers: { figma: { command: "replacement.exe" } },
    });
    const changed = new CopilotHostMcpClient(config);
    clients.push(changed);
    await expect(changed.listTools()).rejects.toThrow("configuration changed");
    expect(runtime.createSession).toHaveBeenCalledTimes(1);
  });

  it("discovers selected-server tools and resources without executing them or exposing stdio errors", async () => {
    const source = { command: "host-mcp.exe", tools: ["whoami"] };
    runtime.config.mockResolvedValue({ servers: { figma: source } });
    runtime.session.rpc.mcp.resources.list.mockRejectedValueOnce(
      new Error("Method not found"),
    );
    const client = new CopilotHostMcpClient({
      name: "figma",
      source: "host",
      sourceDigest: hostMcpSourceDigest(source),
      tools: [],
      readOnly: false,
      resources: [],
      nodeIds: [],
      sessionIds: [],
      allNodes: true,
    });
    clients.push(client);
    expect((await client.inspect()).tools.map((tool) => tool.name)).toEqual(["whoami"]);
    expect(runtime.session.rpc.tools.execute).not.toHaveBeenCalled();
    const options = runtime.createSession.mock.calls[0]![0];
    expect(options.mcpServers.figma.tools).toEqual(["whoami"]);
    expect(
      options.onPermissionRequest({
        kind: "mcp",
        serverName: "figma",
        toolName: "whoami",
      }).kind,
    ).not.toBe("approved");
    runtime.session.rpc.mcp.resources.list.mockRejectedValueOnce(
      new Error("command failed with private-arg"),
    );
    await expect(client.inspect()).rejects.toThrow(
      "Check that server in Copilot on the Host",
    );
  });

  it("refuses unsafe remote HTTP configurations and reserves relay names", () => {
    expect(
      hostMcpUnavailable("figma", { url: "https://mcp.figma.com/mcp" }),
    ).toBeUndefined();
    expect(
      hostMcpUnavailable("local", { url: "http://127.0.0.1:1234/mcp" }),
    ).toBeUndefined();
    expect(hostMcpUnavailable("local", { command: "server.exe" })).toBeUndefined();
    expect(hostMcpUnavailable("bad", { url: "http://remote.example/mcp" })).toBeDefined();
    expect(
      hostMcpUnavailable("bad", { url: "https://user:secret@example.com/mcp" }),
    ).toBeDefined();
    expect(
      hostMcpUnavailable("fleet-host-figma", { command: "server.exe" }),
    ).toBeDefined();
  });

  it("activates cached OAuth and offers only explicitly selected MCP tools", async () => {
    runtime.session.rpc.mcp.startServer.mockRejectedValueOnce(
      new Error('MCP server "figma" requires authentication'),
    );
    const client = create();
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["whoami"]);
    expect(runtime.session.rpc.mcp.oauth.login).toHaveBeenCalledWith({
      serverName: "figma",
    });
    const options = runtime.createSession.mock.calls[0]![0];
    expect(options.availableTools.toArray()).toEqual(["mcp:figma-whoami"]);
    expect(options.disabledMcpServers).toContain("unrelated");
    expect(options.enableFileHooks).toBe(false);
    expect(options.enableSkills).toBe(false);
    expect(
      options.onPermissionRequest({
        kind: "mcp",
        serverName: "figma",
        toolName: "whoami",
      }).kind,
    ).toBe("approved");
    expect(options.onPermissionRequest({ kind: "shell" }).kind).not.toBe("approved");
    expect(
      options.onPermissionRequest({
        kind: "mcp",
        serverName: "unrelated",
        toolName: "whoami",
      }).kind,
    ).not.toBe("approved");
  });

  it("does not leak an OAuth URL or forward calls when Host sign-in is needed", async () => {
    runtime.session.rpc.mcp.startServer.mockRejectedValueOnce(
      new Error("requires authentication"),
    );
    runtime.session.rpc.mcp.oauth.login.mockResolvedValueOnce({
      authorizationUrl: "https://auth.example/authorize?state=private-state",
    });
    await expect(create().callTool("whoami", {}, () => true)).rejects.toThrow(
      "Authenticate figma in Copilot on the Host",
    );
    expect(runtime.session.rpc.tools.execute).not.toHaveBeenCalled();
  });

  it("preserves MCP text, image, resource links, structured output and errors", async () => {
    const content = [
      { type: "text", text: "design" },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      { type: "resource_link", uri: "https://www.figma.com/asset", name: "screenshot" },
    ];
    runtime.session.rpc.tools.execute.mockResolvedValueOnce({
      resultType: "failure",
      contents: content,
      structuredContent: { detail: "failure" },
    });
    expect(await create().callTool("whoami", {}, () => true)).toEqual({
      content,
      isError: true,
      structuredContent: { detail: "failure" },
    });
    expect(runtime.session.rpc.tools.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects unavailable configuration and tools outside its allowlist", async () => {
    const client = create();
    await expect(client.callTool("delete_file", {}, () => true)).rejects.toThrow(
      "not enabled",
    );
    expect(runtime.start).not.toHaveBeenCalled();
    runtime.session.rpc.tools.getCurrentMetadata.mockResolvedValueOnce({ tools: [] });
    await expect(client.listTools()).rejects.toThrow("unavailable: whoami");
  });

  it("reads granted MCP guidance without providing filesystem or arbitrary resource access", async () => {
    const uri = "skill://figma/figma-design-to-code/SKILL.md";
    runtime.session.rpc.mcp.resources.read.mockResolvedValueOnce({
      contents: [{ uri, text: "# Guidance" }],
    });
    const client = create();
    await expect(client.readResource("file:///credentials", () => true)).rejects.toThrow(
      "not enabled",
    );
    expect(runtime.start).not.toHaveBeenCalled();
    expect(await client.readResource(uri, () => true)).toEqual({
      contents: [{ uri, text: "# Guidance" }],
    });
    expect(runtime.session.rpc.mcp.resources.read).toHaveBeenCalledWith({
      serverName: "figma",
      uri,
    });
    expect(runtime.session.rpc.tools.execute).not.toHaveBeenCalled();
  });

  it("rechecks a queued request's grant before invoking the upstream", async () => {
    let finish!: (value: unknown) => void;
    runtime.session.rpc.tools.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const client = create();
    await client.listTools();
    const first = client.callTool("whoami", {}, () => true);
    await vi.waitFor(() =>
      expect(runtime.session.rpc.tools.execute).toHaveBeenCalledTimes(1),
    );
    let authorized = true;
    const second = client.callTool("whoami", {}, () => authorized);
    const rejected = expect(second).rejects.toThrow("withdrawn");
    authorized = false;
    finish({ resultType: "success", contents: [{ type: "text", text: "ok" }] });
    await first;
    await rejected;
    expect(runtime.session.rpc.tools.execute).toHaveBeenCalledTimes(1);
  });

  it("does not execute a call if startup completes after its timeout", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    runtime.session.rpc.mcp.startServer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const client = create();
    const call = client.callTool("whoami", {}, () => true);
    const rejected = expect(call).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(120_001);
    await rejected;
    finish(undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.session.rpc.tools.execute).not.toHaveBeenCalled();
    expect(runtime.forceStop).toHaveBeenCalledOnce();
  });
});
