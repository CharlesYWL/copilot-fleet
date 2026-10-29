// Disposable Node-parent fixture for the POSIX parent-loss test. It prepares and
// releases one command, signals readiness on stdout, then waits to be killed.
import { readFile } from "node:fs/promises";
import { prepareCommandProcess } from "./command-supervisor.js";

const input = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const prepared = await prepareCommandProcess(input);
await prepared.release();
process.stdout.write("released\n");
await prepared.result;
