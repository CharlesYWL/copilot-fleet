/**
 * A stand-in for `copilot --acp --stdio` that exercises process ownership.
 *
 * It answers just enough ACP for a session to start, and on startup launches a
 * long-lived grandchild the way a real agent leaves a dev server or a
 * background shell behind. Both PIDs are written to the file named by
 * FLEET_FAKE_AGENT_PID_FILE so a test can check that stopping the session also
 * ended the grandchild.
 *
 * `--version` and `--help` answer like a current Copilot CLI, because the Node
 * probes both before it launches anything.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import process from "node:process";
import console from "node:console";

if (process.argv.includes("--version")) {
  console.log("GitHub Copilot CLI 1.0.99");
} else if (process.argv.includes("--help")) {
  console.log("--context");
} else {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const pidFile = process.env.FLEET_FAKE_AGENT_PID_FILE;
  if (pidFile)
    writeFileSync(
      pidFile,
      JSON.stringify({ agent: process.pid, grandchild: grandchild.pid }),
    );

  // The grandchild keeps this process alive after stdin closes, the way a real
  // agent's background work does, so only a signal can end it.
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result =
      request.method === "initialize"
        ? { protocolVersion: 1, agentCapabilities: { loadSession: false } }
        : request.method === "session/new"
          ? { sessionId: `fixture-${process.pid}`, configOptions: [] }
          : request.method === "session/prompt"
            ? { stopReason: "end_turn" }
            : { configOptions: [] };
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
    );
  });
}
