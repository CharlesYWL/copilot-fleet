import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionFileReadRequest, SessionFileReadResult } from "@fleet/protocol";
import { SessionFileReader, type SessionFileReaderOptions } from "./session-files.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const root of cleanups.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * A home directory holding a workspace, a folder outside it, Fleet's own
 * configuration and a Copilot home — the layout a Chats session sees.
 */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "fleet-session-files-"));
  cleanups.push(home);
  const workspace = join(home, "workspace");
  const outside = join(home, "outside");
  const config = join(home, "config");
  const coordinator = join(config, "coordinators", "lead");
  const copilotHome = join(home, ".copilot");
  const state = join(copilotHome, "session-state", "copilot-session");
  for (const directory of [
    join(workspace, "docs"),
    outside,
    coordinator,
    join(state, "files"),
    join(copilotHome, "session-state", "other-session"),
    join(copilotHome, "skills", "demo"),
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(join(workspace, "docs", "report.txt"), "quarterly report");
  await writeFile(join(outside, "secret.txt"), "not yours");
  await writeFile(join(config, "node.json"), '{"privateKey":"never"}');
  await writeFile(join(coordinator, "notes.md"), "lead notes");
  await writeFile(join(copilotHome, "config.json"), '{"token":"never"}');
  await writeFile(join(state, "files", "plan.md"), "the plan");
  await writeFile(
    join(copilotHome, "session-state", "other-session", "plan.md"),
    "someone else",
  );
  await writeFile(join(copilotHome, "skills", "demo", "SKILL.md"), "a skill");
  const options: SessionFileReaderOptions = {
    homeDirectory: home,
    copilotHome,
    protectedRoots: [config],
    coordinatorDirectory: () => coordinator,
  };
  return { home, workspace, outside, config, coordinator, copilotHome, state, options };
}

function request(
  change: Partial<SessionFileReadRequest> & Pick<SessionFileReadRequest, "path">,
): SessionFileReadRequest {
  return {
    requestId: randomUUID(),
    sessionId: "session",
    roots: [],
    protectedRoots: [],
    agentSessionId: "",
    coordinator: false,
    offset: 0,
    length: 1024,
    version: "",
    ...change,
  };
}

function text(result: SessionFileReadResult): string {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return Buffer.from(result.data, "base64").toString("utf8");
}

function refusal(result: SessionFileReadResult) {
  if (result.ok) throw new Error(`Expected a refusal, read ${result.path}`);
  return { code: result.code, error: result.error };
}

describe("session file reader", () => {
  it("reads a path relative to the working directory, in chunks pinned to one version", async () => {
    const { workspace, options } = await fixture();
    const reader = new SessionFileReader(options);
    const first = await reader.read(
      request({ path: "docs/report.txt", roots: [workspace], length: 9 }),
    );
    expect(text(first)).toBe("quarterly");
    if (!first.ok) return;
    expect(first).toMatchObject({
      name: "report.txt",
      size: 16,
      offset: 0,
      path: await realpath(join(workspace, "docs", "report.txt")),
    });
    const rest = await reader.read(
      request({
        path: first.path,
        roots: [workspace],
        offset: 9,
        length: 1024,
        version: first.version,
      }),
    );
    expect(text(rest)).toBe(" report");

    const info = await reader.read(
      request({ path: "docs/report.txt", roots: [workspace], length: 0 }),
    );
    expect(info).toMatchObject({ ok: true, size: 16, data: "" });
  });

  it("refuses a file that changed since the first read", async () => {
    const { workspace, options } = await fixture();
    const reader = new SessionFileReader(options);
    const first = await reader.read(
      request({ path: "docs/report.txt", roots: [workspace], length: 4 }),
    );
    if (!first.ok) throw new Error(first.error);
    await writeFile(join(workspace, "docs", "report.txt"), "a different, longer report");
    const next = await reader.read(
      request({
        path: first.path,
        roots: [workspace],
        offset: 4,
        version: first.version,
      }),
    );
    expect(refusal(next).code).toBe("changed");
  });

  it("refuses files outside the session's folders, however they are reached", async () => {
    const { workspace, outside, options } = await fixture();
    const reader = new SessionFileReader(options);
    await symlink(
      outside,
      join(workspace, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const path of [
      join(outside, "secret.txt"),
      "../outside/secret.txt",
      join("escape", "secret.txt"),
    ]) {
      expect(refusal(await reader.read(request({ path, roots: [workspace] })))).toEqual({
        code: "forbidden",
        error: expect.stringContaining("outside the folders"),
      });
    }
  });

  it("never reads Fleet's identity or Copilot's configuration from a home-directory session", async () => {
    const { home, config, copilotHome, options } = await fixture();
    const reader = new SessionFileReader(options);
    for (const path of [
      join(config, "node.json"),
      join(copilotHome, "config.json"),
      join(copilotHome, "session-state", "other-session", "plan.md"),
    ]) {
      expect(refusal(await reader.read(request({ path, roots: [home] })))).toEqual({
        code: "forbidden",
        error: expect.stringContaining("own configuration"),
      });
    }
    expect(
      refusal(
        await reader.read(
          request({
            path: join(home, "workspace", "docs", "report.txt"),
            roots: [home],
            protectedRoots: [join(home, "workspace")],
          }),
        ),
      ).code,
    ).toBe("forbidden");
  });

  it("opens an orchestrator's scratch directory and the session's own state folder, and only those", async () => {
    const { workspace, config, coordinator, state, options } = await fixture();
    const reader = new SessionFileReader(options);
    const lead = { roots: [workspace], coordinator: true };
    expect(
      text(await reader.read(request({ path: join(coordinator, "notes.md"), ...lead }))),
    ).toBe("lead notes");
    expect(
      refusal(await reader.read(request({ path: join(config, "node.json"), ...lead })))
        .code,
    ).toBe("forbidden");
    expect(
      refusal(
        await reader.read(
          request({ path: join(coordinator, "notes.md"), roots: [workspace] }),
        ),
      ).code,
    ).toBe("forbidden");

    const owned = { roots: [workspace], agentSessionId: "copilot-session" };
    expect(
      text(
        await reader.read(request({ path: join(state, "files", "plan.md"), ...owned })),
      ),
    ).toBe("the plan");
    expect(
      refusal(
        await reader.read(
          request({
            path: join(state, "..", "other-session", "plan.md"),
            ...owned,
          }),
        ),
      ).code,
    ).toBe("forbidden");
    expect(
      refusal(
        await reader.read(
          request({
            path: join(state, "files", "plan.md"),
            roots: [workspace],
            agentSessionId: "../copilot-session",
          }),
        ),
      ).code,
    ).toBe("forbidden");
  });

  it("lets a working directory inside a protected folder open itself but not its parent", async () => {
    const { config, copilotHome, options } = await fixture();
    const reader = new SessionFileReader(options);
    const skill = join(copilotHome, "skills", "demo");
    expect(text(await reader.read(request({ path: "SKILL.md", roots: [skill] })))).toBe(
      "a skill",
    );
    expect(
      refusal(await reader.read(request({ path: "node.json", roots: [config] }))),
    ).toEqual({
      code: "forbidden",
      error: expect.stringContaining("own configuration"),
    });
  });

  it("resolves against a live session's working directory and expands the home directory", async () => {
    const { workspace, options } = await fixture();
    const reader = new SessionFileReader({ ...options, liveRoots: () => [workspace] });
    expect(text(await reader.read(request({ path: "docs/report.txt" })))).toBe(
      "quarterly report",
    );
    expect(
      text(
        await reader.read(
          request({ path: "~/workspace/docs/report.txt", roots: [workspace] }),
        ),
      ),
    ).toBe("quarterly report");
    expect(
      refusal(
        await new SessionFileReader(options).read(request({ path: "docs/report.txt" })),
      ),
    ).toMatchObject({ code: "invalid" });
  });

  it("says what is wrong with a missing file, a folder, an oversized file and a busy Node", async () => {
    const { workspace, options } = await fixture();
    const roots = [workspace];
    const reader = new SessionFileReader(options);
    expect(
      refusal(await reader.read(request({ path: "docs/missing.txt", roots }))).code,
    ).toBe("not_found");
    expect(refusal(await reader.read(request({ path: "docs", roots }))).code).toBe(
      "not_a_file",
    );
    expect(
      refusal(await reader.read(request({ path: "docs/report.txt", roots, offset: 17 })))
        .code,
    ).toBe("invalid");
    expect(
      refusal(
        await new SessionFileReader({ ...options, maxBytes: 8 }).read(
          request({ path: "docs/report.txt", roots }),
        ),
      ).code,
    ).toBe("too_large");
    expect(
      refusal(
        await new SessionFileReader({ ...options, maxConcurrentReads: 0 }).read(
          request({ path: "docs/report.txt", roots }),
        ),
      ).code,
    ).toBe("busy");
  });
});
