// Disposable Node-parent fixture. Never targets a process it did not create.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  commandSupervisorReadiness,
  prepareCommandProcess,
} from "./command-supervisor.ts";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
if (input.mode === "readiness" || input.mode === "missing") {
  // Change after the TS loader starts: a false SystemRoot can also stop Node's
  // own dependency loader, which would test the wrong failure boundary.
  if (input.mode === "missing")
    process.env.SystemRoot = join(input.root, "missing-windows");
  const ready = await commandSupervisorReadiness();
  let prepareFailed = false;
  try {
    const prepared = await prepareCommandProcess(input.command);
    await prepared.cancel();
  } catch {
    prepareFailed = true;
  }
  await writeFile(
    join(input.root, "fixture-result.json"),
    JSON.stringify({ ready, prepareFailed }),
  );
} else {
  const prepared = await prepareCommandProcess(input.command);
  if (input.mode !== "before_ack") {
    await prepared.release();
    await writeFile(join(input.root, "released.json"), JSON.stringify(prepared.identity));
  }
  // In before_ack mode the manager neither acknowledges readiness nor releases.
  // The test observes the supervisor's durable ready.json, then kills only us.
  if (input.mode === "blocked") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  await prepared.result;
}
