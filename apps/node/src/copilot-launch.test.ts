import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copilotSpawnTarget,
  findAgencyCommand,
  resolveCopilotLaunch,
} from "./copilot-launch.js";
import { detectAgentKinds } from "./agent-kinds/index.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Copilot launcher selection", () => {
  it("leaves standard Copilot unchanged and does not probe Agency when disabled", async () => {
    const findAgency = vi.fn();
    expect(await resolveCopilotLaunch(false, "custom-copilot", findAgency)).toEqual({
      command: "custom-copilot",
      args: [],
      provider: "copilot",
    });
    expect(findAgency).not.toHaveBeenCalled();
  });

  it("uses the Agency executable and a separate Copilot subcommand argument", async () => {
    const command = "C:\\Program Files\\Agency\\agency.exe";
    expect(
      await resolveCopilotLaunch(true, "custom-copilot", async () => command),
    ).toMatchObject({ command, args: ["copilot"], provider: "agency" });
  });

  it("reports a missing installation and respects the configured fallback", async () => {
    const launch = await resolveCopilotLaunch(
      true,
      "custom-copilot",
      async () => undefined,
    );
    expect(launch).toMatchObject({
      command: "custom-copilot",
      args: [],
      provider: "copilot",
    });
    expect(launch.notice).toMatch(/not found.*PATH.*Falling back to standard Copilot/);
  });

  it("preserves the existing environment override for standard Copilot", async () => {
    vi.stubEnv("FLEET_COPILOT_COMMAND", "environment-copilot");
    expect((await resolveCopilotLaunch(false, "")).command).toBe("environment-copilot");
  });

  it("does not turn a detection error into a silent fallback", async () => {
    await expect(
      resolveCopilotLaunch(true, "copilot", async () => {
        throw new Error("Cannot access the Agency installation");
      }),
    ).rejects.toThrow("Cannot access the Agency installation");
  });
});

describe("node-local Agency discovery", () => {
  it("advertises Hermes only when installed and notices later installs without caching absence", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-hermes-discovery-"));
    directories.push(root);
    const env = { PATH: root, PATHEXT: ".EXE;.CMD" };
    expect(await detectAgentKinds(env)).toEqual([{ kind: "copilot" }]);
    await writeFile(
      join(root, process.platform === "win32" ? "hermes.exe" : "hermes"),
      "",
      { mode: 0o755 },
    );
    expect(await detectAgentKinds(env)).toEqual([
      { kind: "copilot" },
      { kind: "hermes" },
    ]);
  });

  it("uses PATH order, accepts spaces, and notices an installation without restarting", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-agency-"));
    directories.push(root);
    const first = join(root, "first tools");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);
    const env = { PATH: [first, second].join(delimiter), PATHEXT: ".EXE;.CMD" };
    expect(await findAgencyCommand(env)).toBeUndefined();
    const name = process.platform === "win32" ? "agency.exe" : "agency";
    const later = join(second, name);
    await writeFile(later, "", { mode: 0o755 });
    expect(await findAgencyCommand(env)).toBe(later);
    const earlier = join(first, name);
    await writeFile(earlier, "", { mode: 0o755 });
    expect(await findAgencyCommand(env)).toBe(earlier);
  });

  it("does not treat a directory or an empty PATH entry as an installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-agency-"));
    directories.push(root);
    await mkdir(join(root, process.platform === "win32" ? "agency.exe" : "agency"));
    expect(await findAgencyCommand({ PATH: root, PATHEXT: ".EXE" })).toBeUndefined();
    expect(await findAgencyCommand({ PATH: "" })).toBeUndefined();
  });

  it.skipIf(process.platform !== "win32")("finds a Windows command shim", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-agency-"));
    directories.push(root);
    const command = join(root, "agency.cmd");
    await writeFile(command, "");
    expect(await findAgencyCommand({ PATH: `"${root}"`, PATHEXT: ".EXE;.CMD" })).toBe(
      command,
    );
    expect(copilotSpawnTarget(command)).toEqual({
      command: /\s/.test(command) ? `"${command}"` : command,
      shell: true,
    });
  });

  it.skipIf(process.platform === "win32")(
    "reports an installed but non-executable Agency",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "fleet-agency-"));
      directories.push(root);
      const command = join(root, "agency");
      await writeFile(command, "");
      await chmod(command, 0o600);
      await expect(findAgencyCommand({ PATH: root })).rejects.toMatchObject({
        code: "EACCES",
      });
    },
  );

  it("launches native executables directly even when their paths contain spaces", () => {
    const command = "C:\\Program Files\\Agency\\agency.exe";
    expect(copilotSpawnTarget(command)).toEqual({ command, shell: false });
  });
});
