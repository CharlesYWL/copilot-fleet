import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_UI_EVENT_MARKER } from "@fleet/protocol";
import { taskName, windowsSid } from "./login-service.mjs";

const roots = [];
const secret = "grant-fixture.should-never-reach-task-files";
const controller = `
param([string]$Action,[string]$Manifest,[string]$ProbeResult)
$ErrorActionPreference='Stop'
$config=[IO.File]::ReadAllText($Manifest)|ConvertFrom-Json
Add-Content -LiteralPath (Join-Path $config.repositoryPath 'operations.log') -Value ($config.kind+':'+$Action)
if($Action -eq 'probe'){
  @{ok=$true;accountSid=$config.accountSid}|ConvertTo-Json -Compress
}else{
  if($Action -in @('start','restart') -and $config.kind -eq 'node'){
    [IO.File]::AppendAllText($config.logPath, 'now ${CONFIG_UI_EVENT_MARKER}{"type":"starting"}' + [Environment]::NewLine +
      'now ${CONFIG_UI_EVENT_MARKER}{"type":"retry","port":8788,"nextPort":8789}' + [Environment]::NewLine +
      'now ${CONFIG_UI_EVENT_MARKER}{"type":"ready","url":"http://127.0.0.1:8789"}' + [Environment]::NewLine)
  }
  @{installed=$true;active=($Action -eq 'start');state='ready'}|ConvertTo-Json -Compress
}
`;

function fixture(installedKind) {
  const root = mkdtempSync(join(resolve("scripts"), ".login-install-"));
  roots.push(root);
  for (const path of [
    "scripts",
    "apps\\node\\dist",
    "apps\\host\\dist\\server",
    "apps\\host\\dist\\ui",
    "profile",
  ]) {
    mkdirSync(join(root, path), { recursive: true });
  }
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  for (const file of [
    "login-service-cli.mjs",
    "login-service.mjs",
    "login-service-runner.mjs",
  ]) {
    copyFileSync(resolve("scripts", file), join(root, "scripts", file));
  }
  writeFileSync(join(root, "scripts", "windows-login-task.ps1"), controller);
  writeFileSync(
    join(root, "scripts", "windows-login-job.ps1"),
    "# No real job or scheduler in this fixture.",
  );
  writeFileSync(join(root, "apps", "node", "dist", "main.js"), "");
  writeFileSync(
    join(root, "apps", "node", "dist", "github-auth.js"),
    `
    import {appendFileSync} from "node:fs";
    export async function ensureGithubAuth({env, interactive}) {
      appendFileSync(${JSON.stringify(join(root, "operations.log"))}, "node:github-auth\\n");
      if (interactive) throw new Error("Piped CLI must not prompt");
      if (env.FLEET_TEST_GH_AUTH_FAIL === "1") throw new Error("GitHub authentication cancelled");
    }`,
  );
  writeFileSync(join(root, "apps", "host", "dist", "server", "server.js"), "");
  writeFileSync(join(root, "apps", "host", "dist", "ui", "index.html"), "fixture");
  writeFileSync(
    join(root, "apps", "node", "dist", "service-enrollment.js"),
    `
    export const serviceRuntimeArgs = args => args.filter(arg => /^--(devtunnel|config-port)=/.test(arg));
    export async function prepareNodeService(args, options) {
      if(!args.includes("--enrollment-grant=${secret}")) throw new Error("Enrollment arguments were not forwarded");
      if(options.existingNode) throw new Error("Fresh setup was incorrectly marked existing");
      await options.verifyContext({copilotCommand:"C:\\\\Tools\\\\copilot.exe"});
      if(args.includes("--name=fail")) throw new Error("Enrollment failed");
      return {nodeId:"fixture-node",runtimeArgs:serviceRuntimeArgs(args)};
    }
  `,
  );
  for (const kind of installedKind ? [installedKind].flat() : []) {
    const directory = join(root, "profile", "CopilotFleet", "login", kind);
    const sid = windowsSid();
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind,
        taskName: taskName(kind, sid),
        accountSid: sid,
        repositoryPath: root,
        nodePath: process.execPath,
        runnerPath: join(root, "scripts", "login-service-runner.mjs"),
        controllerPath: join(root, "scripts", "windows-login-task.ps1"),
        logPath: join(directory, "runtime.log"),
        environment: {},
        runtimeArgs: [],
      }),
    );
  }
  return root;
}

function launch(root, kind, extra = []) {
  return execFileSync(
    process.execPath,
    [
      join(root, "scripts", "login-service-cli.mjs"),
      kind,
      "--no-build",
      `--enrollment-grant=${secret}`,
      "--host-id=host-1",
      `--host-fingerprint=${"a".repeat(64)}`,
      "--devtunnel=tunnel-1",
      ...extra,
    ],
    {
      env: { ...process.env, LOCALAPPDATA: join(root, "profile") },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

function runAction(root, kind, action) {
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts", "login-service-cli.mjs"), kind, action],
    {
      env: { ...process.env, LOCALAPPDATA: join(root, "profile") },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (result.error) throw result.error;
  return result;
}

function installedFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? installedFiles(path) : [readFileSync(path, "utf8")];
  });
}

describe.skipIf(process.platform !== "win32")(
  "service enrollment CLI integration",
  () => {
    afterEach(() => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it.each([
      ["host", "start", "Host"],
      ["node", "start", "Node"],
      ["host+node", "start", "Host"],
      ["host+node", "restart", "Node"],
      ["host+node", "stop", "Node"],
      ["node", "logs", "Node"],
    ])("explains how to install before %s %s", (kind, action, missing) => {
      const root = fixture();
      const result = runAction(root, kind, action);
      const command = `npm run service -- ${kind} install`;
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `${missing} login startup is not installed for this Windows account.`,
      );
      expect(result.stderr).toContain(
        "start only starts installed tasks; it does not install them.",
      );
      expect(result.stderr).toContain("Stop any manually running Host/Node instances");
      expect(result.stderr).toContain(
        "Install builds, registers, and starts the selected tasks",
      );
      expect(result.stderr).toContain("use the same Windows account");
      if (kind === "host") {
        expect(result.stderr).toContain(`  ${command}\n`);
        expect(result.stderr).not.toContain("--existing-node");
        expect(result.stderr).not.toContain("enrollment command");
      } else {
        expect(result.stderr).toContain("If your Node is already enrolled");
        expect(result.stderr).toContain(`  ${command} --existing-node\n`);
        expect(result.stderr).toContain("For a new Node");
        expect(result.stderr).toContain("Nodes > Connect a machine");
        expect(result.stderr).toContain("service enrollment command");
      }
      expect(existsSync(join(root, "profile", "CopilotFleet"))).toBe(false);
      expect(existsSync(join(root, "operations.log"))).toBe(false);
    });

    it.each(["host", "node"])(
      "suggests installing only the missing %s task in a partial Host+Node installation",
      { timeout: 30_000 },
      (missing) => {
        const root = fixture(missing === "host" ? "node" : "host");
        const result = runAction(root, "host+node", "start");
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`npm run service -- ${missing} install`);
        expect(result.stderr).not.toContain("npm run service -- host+node install");
      },
    );

    it.each([
      ["host", "status"],
      ["node", "status"],
      ["host+node", "status"],
      ["host", "uninstall"],
      ["node", "uninstall"],
      ["host+node", "uninstall"],
    ])("keeps %s %s idempotent when nothing is installed", (kind, action) => {
      const root = fixture();
      const result = runAction(root, kind, action);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const statuses = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
      expect(statuses).toHaveLength(kind === "host+node" ? 2 : 1);
      for (const status of statuses) expect(status.installed).toBe(false);
      expect(existsSync(join(root, "profile", "CopilotFleet"))).toBe(false);
    });

    it(
      "runs one-command Node setup without copying the grant into task metadata or scripts",
      { timeout: 30_000 },
      () => {
        const root = fixture();
        const output = launch(root, "node");
        const directory = join(root, "profile", "CopilotFleet", "login", "node");
        const manifest = JSON.parse(
          readFileSync(join(directory, "manifest.json"), "utf8"),
        );
        expect(manifest.runtimeArgs).toEqual(["--devtunnel=tunnel-1"]);
        expect(manifest.environment.FLEET_COPILOT_COMMAND).toBe("C:\\Tools\\copilot.exe");
        expect(installedFiles(directory).join("")).not.toContain(secret);
        expect(output).not.toContain(secret);
        expect(output).toContain("Prepared Node fixture-node");
        expect(output).toContain("Config UI port 8788 is occupied; trying 8789.");
        expect(output).toContain("Node config UI: http://127.0.0.1:8789");
        expect(
          readFileSync(join(root, "operations.log"), "utf8").trim().split(/\r?\n/),
        ).toEqual(["node:github-auth", "node:probe", "node:register", "node:start"]);
      },
    );

    it(
      "passes enrollment only to the Node when installing Host+Node",
      { timeout: 30_000 },
      () => {
        const root = fixture();
        launch(root, "host+node");
        const installed = join(root, "profile", "CopilotFleet", "login");
        expect(installedFiles(installed).join("")).not.toContain(secret);
        expect(
          JSON.parse(readFileSync(join(installed, "host", "manifest.json"), "utf8"))
            .runtimeArgs,
        ).toEqual([]);
        expect(
          readFileSync(join(root, "operations.log"), "utf8").trim().split(/\r?\n/),
        ).toEqual([
          "host:probe",
          "host:register",
          "host:start",
          "node:github-auth",
          "node:probe",
          "node:register",
          "node:start",
        ]);
      },
    );

    it(
      "does not register or start a task when enrollment fails",
      { timeout: 30_000 },
      () => {
        const root = fixture();
        expect(() => launch(root, "node", ["--name=fail"])).toThrow();
        expect(readFileSync(join(root, "operations.log"), "utf8").trim()).toBe(
          "node:github-auth\nnode:probe",
        );
        expect(installedFiles(join(root, "profile")).join("")).not.toContain(secret);
      },
    );

    it("does not enroll, probe, register, or start after failed authentication", () => {
      const root = fixture();
      writeFileSync(join(root, ".env"), "FLEET_TEST_GH_AUTH_FAIL=1\n");
      expect(() => launch(root, "node")).toThrow("GitHub authentication cancelled");
      expect(readFileSync(join(root, "operations.log"), "utf8").trim()).toBe(
        "node:github-auth",
      );
      expect(installedFiles(join(root, "profile")).join("")).not.toContain(secret);
    });

    it.each(["start", "restart"])(
      "checks authentication before %s of an installed Node",
      (action) => {
        const root = fixture("node");
        const result = runAction(root, "node", action);
        expect(result.status).toBe(0);
        const operations = readFileSync(join(root, "operations.log"), "utf8")
          .trim()
          .split(/\r?\n/);
        expect(operations.indexOf("node:github-auth")).toBeLessThan(
          operations.indexOf(`node:${action}`),
        );
      },
    );

    it("does not stop an installed Node when restart authentication fails", () => {
      const root = fixture("node");
      writeFileSync(join(root, ".env"), "FLEET_TEST_GH_AUTH_FAIL=1\n");
      const result = runAction(root, "node", "restart");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("GitHub authentication cancelled");
      expect(readFileSync(join(root, "operations.log"), "utf8").trim()).toBe(
        "node:github-auth",
      );
    });

    it("checks authentication before stopping either task for a combined restart", () => {
      const root = fixture(["host", "node"]);
      writeFileSync(join(root, ".env"), "FLEET_TEST_GH_AUTH_FAIL=1\n");
      const result = runAction(root, "host+node", "restart");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("GitHub authentication cancelled");
      expect(readFileSync(join(root, "operations.log"), "utf8").trim()).toBe(
        "node:github-auth",
      );
    });
  },
);
