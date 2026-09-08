import { spawn } from "node:child_process";
import console from "node:console";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const require = createRequire(import.meta.url);
const compiler = spawn(
  process.execPath,
  [
    require.resolve("typescript/bin/tsc"),
    "--project",
    fileURLToPath(new URL("../packages/protocol/tsconfig.json", import.meta.url)),
    "--watch",
    "--preserveWatchOutput",
  ],
  { stdio: "inherit" },
);
compiler.unref();

let closing = false;
process.once("exit", () => {
  closing = true;
  compiler.kill();
});
compiler.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
compiler.once("exit", (code) => {
  if (!closing) process.exit(code ?? 1);
});

// Keep Vitest's native CLI parsing and shutdown behavior, without shell-quoting
// user arguments through concurrently (which changes --flag=value on Windows).
process.argv.splice(2, 0, "--watch", "--clearScreen=false");
await import("vitest/vitest.mjs");
