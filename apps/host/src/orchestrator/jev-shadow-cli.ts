import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ShadowDatasetSchema, ShadowThresholdsSchema } from "./jev-shadow.js";
import { createJevShadowProvider, runShadowEvaluation } from "./jev-shadow-runner.js";

const HELP = `Offline Jev handoff evaluation (never dispatches or skips a Lead turn).

--dataset <absolute path>       Curated version-1 dataset
--predictions <absolute path>   Saved report/predictions for local replay (default mode)
--min-confidence <0..1>         Explicit evaluation threshold; no production default
--min-probability <0..1>        Explicit evaluation threshold; no production default
--send-to-jev                   Consent to upload eligible cases to TypeSafe
--model <id>                   Required with --send-to-jev; pin for reproducible results
--schema                       Print the dataset JSON schema, without network access
--help                         Show this help

Remote mode requires TYPESAFE_API_KEY. Review/redact the dataset before opting in.
Only the bounded objective, criteria, phases, worker brief/report and approved review
are sent. Labels, timings, session records and identifiers are not sent.
JSON reports contain predictions and metrics, not source text or provider errors.
`;

async function readJson(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error("Use an absolute input file path");
  const info = await stat(path);
  const limit = 8 * 1024 * 1024;
  if (!info.isFile() || info.size > limit)
    throw new Error("Input must be a file <=8 MiB");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > limit) throw new Error("Input exceeds 8 MiB");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function runJevShadowCli(args: string[]): Promise<string> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      dataset: { type: "string" },
      predictions: { type: "string" },
      "min-confidence": { type: "string" },
      "min-probability": { type: "string" },
      "send-to-jev": { type: "boolean" },
      model: { type: "string" },
      schema: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return HELP;
  if (values.schema) return JSON.stringify(z.toJSONSchema(ShadowDatasetSchema), null, 2);
  if (
    !values.dataset ||
    !values["min-confidence"]?.trim() ||
    !values["min-probability"]?.trim()
  ) {
    throw new Error("Dataset and both explicit thresholds are required");
  }
  const thresholds = ShadowThresholdsSchema.parse({
    minConfidence: Number(values["min-confidence"]),
    minProbability: Number(values["min-probability"]),
  });
  const remote = values["send-to-jev"] === true;
  if (
    (remote && (values.predictions || !values.model)) ||
    (!remote && (!values.predictions || values.model))
  ) {
    throw new Error("Choose local replay or explicit remote evaluation, not both");
  }
  const dataset = ShadowDatasetSchema.parse(await readJson(values.dataset));
  const report = await runShadowEvaluation(
    dataset,
    thresholds,
    remote
      ? {
          mode: "remote",
          model: values.model!,
          provider: createJevShadowProvider(process.env.TYPESAFE_API_KEY ?? ""),
        }
      : { mode: "replay", predictions: await readJson(values.predictions!) },
  );
  return JSON.stringify(report, null, 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${await runJevShadowCli(process.argv.slice(2))}\n`);
  } catch {
    // Parser and SDK diagnostics can echo dataset content or credentials.
    console.error(
      "Jev shadow evaluation failed. Check local inputs and --help; no live work changed.",
    );
    process.exitCode = 1;
  }
}
