// Disposable Node-parent fixture. Never targets a process it did not create.
import { randomUUID } from "node:crypto";
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
  if (input.mode === "missing") {
    // OpenSSL seeds its generator from the Windows system directory on first
    // use (Node 26 and later). Seed it now, while SystemRoot is still real, so
    // the failure under test is the missing supervisor rather than randomUUID.
    randomUUID();
    // Windows names are case-insensitive, and the inherited key may not be
    // spelled `SystemRoot` (Vitest upper-cases them); replace every spelling.
    for (const key of Object.keys(process.env))
      if (key.toUpperCase() === "SYSTEMROOT") delete process.env[key];
    process.env.SystemRoot = join(input.root, "missing-windows");
  }
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
