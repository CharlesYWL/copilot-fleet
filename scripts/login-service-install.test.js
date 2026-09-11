import { execFileSync } from "node:child_process";
import {
  copyFileSync,
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
  if($Action -eq 'start' -and $config.kind -eq 'node'){
    [IO.File]::AppendAllText($config.logPath, 'now ${CONFIG_UI_EVENT_MARKER}{"type":"starting"}' + [Environment]::NewLine +
      'now ${CONFIG_UI_EVENT_MARKER}{"type":"retry","port":8788,"nextPort":8789}' + [Environment]::NewLine +
      'now ${CONFIG_UI_EVENT_MARKER}{"type":"ready","url":"http://127.0.0.1:8789"}' + [Environment]::NewLine)
  }
  @{installed=$true;active=($Action -eq 'start');state='ready'}|ConvertTo-Json -Compress
}
`;

function fixture() {
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
        ).toEqual(["node:probe", "node:register", "node:start"]);
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
          "node:probe",
        );
        expect(installedFiles(join(root, "profile")).join("")).not.toContain(secret);
      },
    );
  },
);
