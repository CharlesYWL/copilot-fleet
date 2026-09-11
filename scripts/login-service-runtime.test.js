import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { afterEach, expect, it } from "vitest";
import { run } from "./login-service-runner.mjs";

const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
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
});
it("does not replace a missing Node identity", async () => {
  const manifest = fixture("node", 'throw new Error("must not run");');
  writeFileSync(
    join(manifest.repositoryPath, "apps", "node", "dist", "config.js"),
    "export const loadCredentials=async()=>undefined;",
  );
  await expect(run(manifest)).rejects.toThrow("refusing replacement enrollment");
  expect(existsSync(manifest.logPath)).toBe(false);
});
