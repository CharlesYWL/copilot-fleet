import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import { setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  spawnManagedProcess,
  stopProcessTree,
} from "../apps/node/src/process-quiescence.js";
import { ensureNodeGithubAuth, run } from "./login-service-runner.mjs";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, open: vi.fn(actual.open) };
});

const temporary = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const windowsIt = it.skipIf(process.platform !== "win32");
const managed = () => ({
  spawnManagedProcess: vi.fn(spawnManagedProcess),
  stopProcessTree: vi.fn(stopProcessTree),
});
const logged = (manifest) =>
  existsSync(manifest.logPath) ? readFileSync(manifest.logPath, "utf8") : "";
const observe = (result) =>
  result.then(
    (code) => ({ code }),
    (error) => ({ error }),
  );

function fakeManager(exitCode = 7, stayAlive = false) {
  return {
    spawnManagedProcess: vi.fn(() => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      child.unref = vi.fn();
      if (stayAlive) return child;
      process.nextTick(() => {
        child.stdout.end();
        child.stderr.end("managed diagnostic\n");
        child.emit("close", exitCode, null);
      });
      return child;
    }),
    stopProcessTree: vi.fn(async () => {}),
  };
}

function interceptLogStream(transform) {
  const open = fsPromises.open;
  vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const create = handle.createWriteStream.bind(handle);
    handle.createWriteStream = (options) => transform(create(options));
    return handle;
  });
}
function fixture(kind, main) {
  // Resolve the existing dotenv dependency without adding fixture dependencies.
  const directory = mkdtempSync(join(resolve("scripts"), ".login-runtime-"));
  temporary.push(directory);
  const nodeRoot = join(directory, "apps", "node");
  const hostRoot = join(directory, "apps", "host", "dist", "server");
  mkdirSync(join(nodeRoot, "dist"), { recursive: true });
  mkdirSync(hostRoot, { recursive: true });
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(nodeRoot, "dist", "config.js"),
    `export const configDirectory = () => ${JSON.stringify(directory)};
     export const loadCredentials = async () => ({nodeId:"existing-node"});`,
  );
  writeFileSync(
    join(nodeRoot, "dist", "process-quiescence.js"),
    `export * from ${JSON.stringify(pathToFileURL(resolve("apps/node/src/process-quiescence.ts")).href)};`,
  );
  copyFileSync(resolve("apps/node/supervisor.mjs"), join(nodeRoot, "supervisor.mjs"));
  writeFileSync(
    kind === "node" ? join(nodeRoot, "dist", "main.js") : join(hostRoot, "server.js"),
    main,
  );
  return {
    kind,
    repositoryPath: directory,
    accountSid: "same-user-fixture",
    nodePath: process.execPath,
    runtimeArgs: [],
    logPath: join(directory, "runtime.log"),
  };
}
it("launches the production Host and preserves its exit code", async () => {
  const manifest = fixture(
    "host",
    'console.log("mode=" + process.env.NODE_ENV); process.exitCode=17;',
  );
  await expect(run(manifest)).resolves.toBe(17);
  expect(readFileSync(manifest.logPath, "utf8")).toContain("mode=production");
});
it("handles planned exit-75 updates inside the Node supervisor", async () => {
  const manifest = fixture(
    "node",
    `
    import {existsSync,readFileSync,writeFileSync} from "node:fs";
    const count=existsSync("count")?Number(readFileSync("count","utf8"))+1:1;
    writeFileSync("count",String(count)); process.exitCode=count===1?75:0;`,
  );
  await expect(run(manifest)).resolves.toBe(0);
  expect(readFileSync(join(manifest.repositoryPath, "count"), "utf8")).toBe("2");
  expect(readFileSync(manifest.logPath, "utf8")).toContain("node exited for an update");
  expect(logged(manifest)).not.toContain("Crash recovery retry");
}, 30_000);
it("runs the replacement build with the same service arguments without reinstalling", async () => {
  const replacement = `
    import {writeFileSync} from "node:fs";
    writeFileSync("replacement.json", JSON.stringify({
      revision: "new222222222", mode: process.env.NODE_ENV,
      restart: process.env.FLEET_RESTART_MODE, args: process.argv.slice(2)
    }));`;
  const manifest = fixture(
    "node",
    `
    import {writeFileSync} from "node:fs";
    writeFileSync(import.meta.filename, ${JSON.stringify(replacement)});
    process.exitCode = 75;`,
  );
  manifest.runtimeArgs = ["--config-port=8799"];
  await expect(run(manifest)).resolves.toBe(0);
  expect(
    JSON.parse(readFileSync(join(manifest.repositoryPath, "replacement.json"), "utf8")),
  ).toEqual({
    revision: "new222222222",
    mode: "production",
    restart: "exit",
    args: ["--config-port=8799"],
  });
}, 30_000);
it("does not replace a missing Node identity", async () => {
  const manifest = fixture("node", 'throw new Error("must not run");');
  writeFileSync(
    join(manifest.repositoryPath, "apps", "node", "dist", "config.js"),
    "export const loadCredentials=async()=>undefined;",
  );
  const processManager = fakeManager();
  await expect(run(manifest, { processManager })).rejects.toThrow(
    "refusing replacement enrollment",
  );
  expect(processManager.spawnManagedProcess).not.toHaveBeenCalled();
  expect(existsSync(manifest.logPath)).toBe(false);
});

it("does not attempt recovery when Node configuration cannot load", async () => {
  const manifest = fixture("node", "");
  rmSync(join(manifest.repositoryPath, "apps", "node", "dist", "config.js"));
  const processManager = fakeManager();
  await expect(run(manifest, { processManager })).rejects.toThrow();
  expect(processManager.spawnManagedProcess).not.toHaveBeenCalled();
  expect(existsSync(manifest.logPath)).toBe(false);
});

it.each(["missing", "changed", "running"])(
  "rechecks identity and idle state before recovery: %s",
  async (state) => {
    const manifest = fixture("node", "");
    const identity = join(manifest.repositoryPath, "identity.json");
    writeFileSync(identity, '{"nodeId":"original-node"}');
    writeFileSync(
      join(manifest.repositoryPath, "apps", "node", "dist", "config.js"),
      `import {existsSync,readFileSync} from "node:fs";
       export const configDirectory=()=>${JSON.stringify(manifest.repositoryPath)};
       export const loadCredentials=async()=>existsSync(${JSON.stringify(identity)})
         ?JSON.parse(readFileSync(${JSON.stringify(identity)},"utf8")):undefined;`,
    );
    const manager = fakeManager();
    manager.stopProcessTree.mockImplementation(async () => {
      if (state === "missing") rmSync(identity);
      if (state === "changed") writeFileSync(identity, '{"nodeId":"different-node"}');
      if (state === "running")
        writeFileSync(join(manifest.repositoryPath, "node.lock"), String(process.pid));
    });
    await expect(
      run(manifest, { processManager: manager, retryDelaysMs: [1] }),
    ).rejects.toThrow(
      state === "missing"
        ? "Node identity is missing"
        : state === "changed"
          ? "Node identity changed"
          : "Another Fleet Node is running",
    );
    expect(manager.spawnManagedProcess).toHaveBeenCalledTimes(1);
    if (state === "running")
      expect(readFileSync(join(manifest.repositoryPath, "node.lock"), "utf8")).toBe(
        String(process.pid),
      );
  },
);

windowsIt(
  "recovers a crash only after orphaned descendants stop, preserving identity, arguments and environment",
  async () => {
    vi.stubEnv("GH_CONFIG_DIR", "saved-login-profile");
    const manifest = fixture(
      "node",
      `
      import {spawn} from "node:child_process";
      import {existsSync,readFileSync,writeFileSync} from "node:fs";
      const count=existsSync("count")?Number(readFileSync("count","utf8"))+1:1;
      writeFileSync("count",String(count));
      console.log("stdout-attempt="+count); console.error("stderr-attempt="+count);
      if (count===1) {
        const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
        writeFileSync("descendant",String(child.pid)); child.unref();
        process.exitCode=17;
      } else {
        let oldTreeAlive=false;
        try { process.kill(Number(readFileSync("descendant","utf8")),0); oldTreeAlive=true; } catch {}
        writeFileSync("recovered.json",JSON.stringify({
          oldTreeAlive, mode:process.env.NODE_ENV, restart:process.env.FLEET_RESTART_MODE,
          profile:process.env.GH_CONFIG_DIR, args:process.argv.slice(2)
        }));
      }`,
    );
    manifest.runtimeArgs = ["--config-port=8799", "--name=node with spaces"];
    const manager = managed();
    await expect(
      run(manifest, { processManager: manager, retryDelaysMs: [1] }),
    ).resolves.toBe(0);
    expect(manager.spawnManagedProcess).toHaveBeenCalledTimes(2);
    expect(manager.stopProcessTree).toHaveBeenCalledTimes(2);
    for (const [, requireOwnership] of manager.stopProcessTree.mock.calls)
      expect(requireOwnership).toBe(true);
    expect(
      JSON.parse(readFileSync(join(manifest.repositoryPath, "recovered.json"), "utf8")),
    ).toEqual({
      oldTreeAlive: false,
      mode: "production",
      restart: "exit",
      profile: "saved-login-profile",
      args: manifest.runtimeArgs,
    });
    const log = logged(manifest);
    expect(log).toContain("code=17, signal=none");
    expect(log).toContain("process tree verified terminated");
    expect(log).toContain("Crash recovery retry 1/1 in 1ms");
    expect(log).toContain("stdout-attempt=1");
    expect(log).toContain("stderr-attempt=2");
    expect(log).not.toContain("fleet-process-tree-quiesced:");
  },
  30_000,
);

windowsIt(
  "caps crash recovery at four retries and retains the final nonzero exit",
  async () => {
    const manifest = fixture("node", 'console.error("crash");process.exitCode=19;');
    const manager = managed();
    await expect(
      run(manifest, { processManager: manager, retryDelaysMs: [1, 2, 3, 4] }),
    ).resolves.toBe(19);
    expect(manager.spawnManagedProcess).toHaveBeenCalledTimes(5);
    expect(manager.stopProcessTree).toHaveBeenCalledTimes(5);
    const log = logged(manifest);
    expect(log).toContain("Starting attempt 5/5");
    expect(log).toContain("Crash recovery retry 4/4 in 4ms");
    expect(log).toContain("Crash recovery exhausted after 4 retries");
  },
  60_000,
);

windowsIt.each(["SIGINT", "SIGTERM"])(
  "stops an active managed child intentionally on %s without restarting",
  async (signal) => {
    const manifest = fixture(
      "node",
      'console.log("stop-ready");setInterval(()=>{},1000);',
    );
    const signalSource = new EventEmitter();
    const manager = managed();
    const result = observe(
      run(manifest, { processManager: manager, signalSource, retryDelaysMs: [1] }),
    );
    try {
      await expect
        .poll(() => logged(manifest), { timeout: 15_000 })
        .toContain("stop-ready");
      signalSource.emit(signal);
      await expect(result).resolves.toEqual({ code: 0 });
      expect(manager.spawnManagedProcess).toHaveBeenCalledTimes(1);
      expect(logged(manifest)).toContain(`Stopped by ${signal}; no further retries`);
      expect(logged(manifest)).not.toContain("Crash recovery retry");
      expect(signalSource.listenerCount(signal)).toBe(0);
    } finally {
      signalSource.emit(signal);
      await result;
    }
  },
  45_000,
);

it.each(["SIGINT", "SIGTERM"])(
  "cancels a pending backoff on %s instead of launching another attempt",
  async (signal) => {
    const manifest = fixture("node", "");
    const signalSource = new EventEmitter();
    const manager = fakeManager();
    const result = observe(run(manifest, { processManager: manager, signalSource }));
    try {
      await expect
        .poll(() => logged(manifest))
        .toContain("Crash recovery retry 1/4 in 5000ms");
      signalSource.emit(signal);
      await expect(result).resolves.toEqual({ code: 0 });
      expect(manager.spawnManagedProcess).toHaveBeenCalledTimes(1);
      expect(logged(manifest)).toContain(`Stopped by ${signal}; no further retries`);
      expect(signalSource.listenerCount(signal)).toBe(0);
    } finally {
      signalSource.emit(signal);
      await result;
    }
  },
);

it("fails closed on synchronous and emitted spawn errors", async () => {
  for (const synchronous of [true, false]) {
    const manifest = fixture("node", "");
    const manager = fakeManager();
    if (synchronous) {
      manager.spawnManagedProcess.mockImplementation(() => {
        throw new Error("spawn rejected");
      });
    } else {
      const spawn = manager.spawnManagedProcess.getMockImplementation();
      manager.spawnManagedProcess.mockImplementation((...args) => {
        const child = spawn(...args);
        process.nextTick(() => child.emit("error", new Error("spawn rejected")));
        return child;
      });
    }
    await expect(
      run(manifest, { processManager: manager, retryDelaysMs: [1] }),
    ).rejects.toThrow("spawn rejected");
    expect(manager.spawnManagedProcess).toHaveBeenCalledTimes(1);
    expect(logged(manifest)).toContain("Recovery halted; no retry: spawn rejected");
  }
});

windowsIt(
  "refuses recovery after wrapper death without ownership proof",
  async () => {
    const manifest = fixture(
      "node",
      'console.log("wrapper-ready");setInterval(()=>{},1000);',
    );
    const manager = managed();
    manager.spawnManagedProcess.mockImplementation((...args) => {
      const child = spawnManagedProcess(...args);
      child.stdout.once("data", () => child.kill());
      return child;
    });
    await expect(
      run(manifest, { processManager: manager, retryDelaysMs: [1] }),
    ).rejects.toThrow("Process-tree termination was not verified; refusing recovery");
    expect(manager.spawnManagedProcess).toHaveBeenCalledTimes(1);
    expect(logged(manifest)).toContain("reconciliation is required");
    expect(logged(manifest)).not.toContain("Crash recovery retry");
  },
  30_000,
);

it("does not hide cleanup failure or start a successor", async () => {
  const manifest = fixture("node", "");
  const manager = fakeManager();
  manager.stopProcessTree.mockRejectedValue(new Error("cleanup timed out"));
  await expect(
    run(manifest, { processManager: manager, retryDelaysMs: [1] }),
  ).rejects.toThrow("cleanup timed out");
  expect(manager.spawnManagedProcess).toHaveBeenCalledTimes(1);
  const child = manager.spawnManagedProcess.mock.results[0].value;
  expect(child.kill).toHaveBeenCalledOnce();
  expect(child.unref).toHaveBeenCalledOnce();
  expect(logged(manifest)).toContain("managed diagnostic");
  expect(logged(manifest)).toContain("Recovery halted; no retry");
});

it("fails closed when an intentional stop cannot terminate a still-running child", async () => {
  const manifest = fixture("node", "");
  const manager = fakeManager(7, true);
  manager.stopProcessTree.mockRejectedValue(new Error("cleanup timed out"));
  const signalSource = new EventEmitter();
  const result = observe(run(manifest, { processManager: manager, signalSource }));
  try {
    await expect.poll(() => manager.spawnManagedProcess.mock.calls.length).toBe(1);
    signalSource.emit("SIGTERM");
    const outcome = await result;
    expect(outcome.error?.message).toContain("cleanup timed out");
    expect(manager.spawnManagedProcess).toHaveBeenCalledTimes(1);
    expect(manager.spawnManagedProcess.mock.results[0].value.kill).toHaveBeenCalledOnce();
  } finally {
    signalSource.emit("SIGTERM");
    await result;
  }
});

windowsIt(
  "keeps large stdout/stderr bounded and intact under log backpressure",
  async () => {
    const manifest = fixture(
      "node",
      `process.stdout.write("~".repeat(2000000));process.stderr.write("^".repeat(2000000));`,
    );
    let maximumBuffered = 0;
    interceptLogStream((output) => {
      const write = output.write.bind(output);
      output.write = (...args) => {
        const result = write(...args);
        maximumBuffered = Math.max(maximumBuffered, output.writableLength);
        return result;
      };
      const performWrite = output._write.bind(output);
      output._write = (...args) => {
        setTimeout(() => performWrite(...args), 10);
      };
      return output;
    });
    await expect(run(manifest)).resolves.toBe(0);
    const log = logged(manifest);
    expect(log.match(/~/g)).toHaveLength(2000000);
    expect(log.match(/\^/g)).toHaveLength(2000000);
    expect(log).toContain("process tree verified terminated");
    expect(log).not.toContain("fleet-process-tree-quiesced:");
    expect(maximumBuffered).toBeLessThan(256 * 1024);
  },
  30_000,
);

windowsIt(
  "propagates a runtime log error and verifies cleanup instead of retrying",
  async () => {
    const manifest = fixture(
      "node",
      'console.log("log-failure-ready");setInterval(()=>{},1000);',
    );
    const manager = managed();
    interceptLogStream((output) => {
      output.once("pipe", (source) => {
        source.once("data", () => output.emit("error", new Error("log write failed")));
      });
      return output;
    });
    await expect(
      run(manifest, { processManager: manager, retryDelaysMs: [1] }),
    ).rejects.toThrow("log write failed");
    expect(manager.spawnManagedProcess).toHaveBeenCalledTimes(1);
    expect(manager.stopProcessTree).toHaveBeenCalledWith(
      manager.spawnManagedProcess.mock.results[0].value,
      true,
    );
  },
  45_000,
);

it("checks the saved task profile and checkout environment without changing the parent environment", async () => {
  const manifest = fixture("node", "");
  writeFileSync(
    join(manifest.repositoryPath, "apps", "node", "dist", "github-auth.js"),
    `import {writeFileSync} from "node:fs";
     export async function ensureGithubAuth({env, interactive}) {
       writeFileSync(${JSON.stringify(join(manifest.repositoryPath, "auth.json"))},
         JSON.stringify({host:env.GH_HOST,profile:env.GH_CONFIG_DIR,interactive}));
     }`,
  );
  writeFileSync(
    join(manifest.repositoryPath, ".env"),
    "GH_HOST=checkout.example.com\nGH_CONFIG_DIR=checkout-profile\n",
  );
  manifest.environment = { GH_HOST: "saved.example.com", GH_CONFIG_DIR: "saved-profile" };
  const before = { host: process.env.GH_HOST, profile: process.env.GH_CONFIG_DIR };
  await ensureNodeGithubAuth(manifest);
  expect(
    JSON.parse(readFileSync(join(manifest.repositoryPath, "auth.json"), "utf8")),
  ).toEqual({ host: "saved.example.com", profile: "saved-profile", interactive: false });
  expect({ host: process.env.GH_HOST, profile: process.env.GH_CONFIG_DIR }).toEqual(
    before,
  );
});
