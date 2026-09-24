import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";

/**
 * The launcher end to end: real npm, real git, real process trees.
 *
 * The unit tests prove the decisions with stand-ins; this proves the one thing
 * they cannot, that the command the operator started really is stopped — the
 * whole tree, on Windows too — and really comes back on the new commit, in
 * place, after the update the Host asked for.
 */

const repository = resolve(import.meta.dirname, "..");
const temporary = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function directory(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${describe}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

/** A stand-in Host: it records itself, and the first version asks for an update. */
const host = (version) => `const fs = require("node:fs");
const net = require("node:net");
fs.appendFileSync("events.log", "host ${version} pid=" + process.pid + "\\n");
if (${JSON.stringify(version)} === "v1") {
  const socket = net.connect(process.env.FLEET_LAUNCHER_ENDPOINT);
  socket.on("connect", () => socket.write(JSON.stringify({
    token: process.env.FLEET_LAUNCHER_TOKEN,
    type: "update",
    updateId: "e2e-update",
    statusFile: process.env.E2E_STATUS_FILE,
  }) + "\\n"));
  socket.on("data", (reply) => fs.appendFileSync("events.log", "reply " + reply));
}
setInterval(() => {}, 1000);
`;

it("pulls, builds and brings npm run dev back in place on the new commit", async () => {
  const origin = directory("fleet-launcher-origin-");
  git(origin, "init", "--initial-branch=main");
  git(origin, "config", "user.email", "fleet@example.com");
  git(origin, "config", "user.name", "Fleet Test");
  writeFileSync(
    join(origin, "package.json"),
    JSON.stringify({
      name: "launcher-e2e",
      version: "1.0.0",
      private: true,
      scripts: { "dev:bare": "node host.js", build: "node build.js" },
    }),
  );
  writeFileSync(
    join(origin, "build.js"),
    'require("node:fs").writeFileSync("built", "yes");',
  );
  // The launcher under test, pointed at this checkout and at this repository's
  // built update code rather than at a node_modules the fixture does not have.
  writeFileSync(
    join(origin, "launch.mjs"),
    `import { main } from ${JSON.stringify(pathToFileURL(join(repository, "scripts", "launcher.mjs")).href)};
main(process.argv.slice(2), {
  root: process.cwd(),
  loadUpdater: () => import(${JSON.stringify(pathToFileURL(join(repository, "packages", "protocol", "dist", "updater.js")).href)}),
});
`,
  );
  writeFileSync(join(origin, "host.js"), host("v1"));
  writeFileSync(join(origin, ".gitignore"), "events.log\nbuilt\npackage-lock.json\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "v1");

  const checkout = directory("fleet-launcher-checkout-");
  execFileSync("git", ["clone", origin, checkout], { stdio: "ignore" });

  writeFileSync(join(origin, "host.js"), host("v2"));
  git(origin, "commit", "-am", "v2");
  const target = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: origin,
    encoding: "utf8",
  }).trim();

  const statusFile = join(directory("fleet-launcher-status-"), "self-update.json");
  const launcher = spawn(process.execPath, [join(checkout, "launch.mjs"), "dev"], {
    cwd: checkout,
    env: { ...process.env, E2E_STATUS_FILE: statusFile },
    stdio: "ignore",
  });
  const events = () =>
    existsSync(join(checkout, "events.log"))
      ? readFileSync(join(checkout, "events.log"), "utf8")
      : "";
  try {
    const first = Number(
      (await until(() => /host v1 pid=(\d+)/.exec(events()), 60_000, "the first run"))[1],
    );
    const status = await until(
      () => {
        try {
          const record = JSON.parse(readFileSync(statusFile, "utf8"));
          return ["restarting", "up_to_date", "failed"].includes(record.stage) &&
            record.revision
            ? record
            : undefined;
        } catch {
          return undefined;
        }
      },
      120_000,
      "the update to reach its restart",
    );
    // The launcher launches; only the new Host, once serving, may call the
    // update done — and this stand-in Host does not.
    expect(status).toMatchObject({
      updateId: "e2e-update",
      stage: "restarting",
      confirmRestart: "host",
      revision: target,
      restartCommand: "npm run dev",
    });
    await until(() => /host v2 pid=\d+/.test(events()), 60_000, "the new run");
    expect(events()).toContain('reply {"ok":true}');
    expect(readFileSync(join(checkout, "built"), "utf8")).toBe("yes");
    // Replaced, not joined: the run that asked for the update is gone.
    await until(() => !alive(first), 20_000, "the first run to stop");
  } finally {
    if (process.platform === "win32") {
      spawnSync(
        win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(launcher.pid), "/T", "/F"],
        { stdio: "ignore" },
      );
    } else {
      // The launcher passes this on to the process group it started.
      launcher.kill("SIGTERM");
    }
    await until(
      () => launcher.exitCode !== null || launcher.signalCode !== null,
      20_000,
      "the launcher to stop",
    );
  }
}, 240_000);
