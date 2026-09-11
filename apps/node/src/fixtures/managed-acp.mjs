import { createInterface } from "node:readline";
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";

if (process.argv.includes("--version")) {
  console.log("GitHub Copilot CLI 1.0.84");
} else if (process.argv.includes("--help")) {
  console.log("--allow-all");
} else {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result =
      request.method === "initialize"
        ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
        : request.method === "session/new"
          ? { sessionId: `fixture-${process.pid}`, configOptions: [] }
          : request.method === "session/prompt"
            ? { stopReason: "end_turn" }
            : { configOptions: [] };
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
    );
    const text = request.params?.prompt?.[0]?.text ?? "";
    if (text.startsWith("stderr:"))
      process.stderr.write(
        "legitimate stderr before exit\nfleet-process-tree-quiesced:unrelated-diagnostic\nlegitimate unterminated stderr",
      );
    const code = /^(?:stderr:)?exit:(\d+)$/.exec(text)?.[1];
    if (code !== undefined) setTimeout(() => process.exit(Number(code)), 150);
  });
}
