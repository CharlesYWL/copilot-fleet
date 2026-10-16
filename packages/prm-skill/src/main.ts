import { installedSkillDir, readAllStdin, run } from "./cli.js";
import { observePr, parsePrUrl } from "./provider.mjs";

const output = await run(process.argv.slice(2), {
  parseUrl: parsePrUrl,
  observe: observePr,
  now: Date.now,
  readStdin: readAllStdin,
  env: process.env,
  skillDir: installedSkillDir(),
});
process.stdout.write(`${JSON.stringify(output.body, null, 2)}\n`);
process.exitCode = output.exitCode;
