import { z } from "zod";
import type {
  PrMaintenanceBatch,
  PrMaintenanceCheckpoint,
  PrMaintenanceRegistration,
} from "@fleet/protocol";
import {
  WorkContractError,
  WorkOrderSchema,
  WorkReportSchema,
  extractWorkReport,
  fleetSettlement,
} from "@fleet/prm-skill/fleet";
import { PrMaintenanceError } from "./pr-maintenance-store.js";

type BatchCheckpoint = Extract<PrMaintenanceCheckpoint, { kind: "batch" }>;

/** Map prm work-contract failures onto the maintenance error codes callers expect. */
export function workContract<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof WorkContractError)
      throw new PrMaintenanceError(error.code, error.message);
    if (error instanceof z.ZodError)
      throw new PrMaintenanceError(
        "invalid_work_contract",
        error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
          .join("; "),
      );
    throw error;
  }
}

/**
 * The largest observation the orchestrator may still paste into a checkpoint.
 * Anything bigger is ingested by the Host from the helper's claim-bound Fleet
 * command, so a lead turn never carries bulk provider evidence.
 */
export const LEAD_OBSERVATION_RELAY_BYTES = 32_768;

/**
 * Checkpoint kinds the orchestrator may no longer send. The Host ingests
 * helper output from its claim-bound Fleet command and settles work-order
 * batches from the worker's own report, so the lead never relays large
 * observations or hand-builds per-finding settlements, and an observation
 * failure has one recovery path: the next review runs the same helper again.
 * Store internals still use these shapes; only the lead's tool refuses them.
 */
export function leadRelayRefusal(
  checkpoint: PrMaintenanceCheckpoint,
  record?: Pick<PrMaintenanceRegistration, "batches">,
): { code: string; message: string } | undefined {
  const relay = {
    code: "observation_relay_refused",
    message:
      "The Host ingests the helper's stdout from its claim-bound Fleet command: pass observationClaim as maintenanceObservation when creating it, and recover a lost receipt with only executionId. After a failed observation the next review runs the same helper again; that is the only recovery path. Do not paste large observations into a checkpoint.",
  };
  switch (checkpoint.kind) {
    case "observation":
    case "fallback":
      return new TextEncoder().encode(JSON.stringify(checkpoint.observation)).byteLength >
        LEAD_OBSERVATION_RELAY_BYTES
        ? relay
        : undefined;
    case "alternate_attempt":
    case "alternate_observation":
      return relay;
    case "prepare_batch":
      return {
        code: "work_order_required",
        message:
          "Prepare routine work with prepare_work_order; the Host renders the worker prompt and settles the worker's report itself.",
      };
    case "batch":
      return record?.batches.find((batch) => batch.id === checkpoint.batchId)?.workOrder
        ? {
            code: "host_settlement",
            message:
              "The Host settles work-order batches from the worker's report when the attempt ends. If it could not (see the batch's settlementError), use work_report — the only recovery path.",
          }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The batch checkpoints that settle a work-order batch from its worker's
 * prm.work-report/1.
 *
 * The Host calls this itself when the batch's attempt settles, reading the
 * report from the worker's own output, so the orchestrator never relays or
 * hand-builds a settlement. The same function is the single recovery path when
 * that automatic read fails: the lead supplies a recovered report. Either way
 * the report is only a claim; the registry's settlement guards still require
 * the correlated terminal RunStep, known effect evidence and allowance use.
 */
export function workReportCheckpoints(input: {
  batch: PrMaintenanceBatch;
  generation: number;
  workerSessionId: string;
  /** Worker output of the settled attempt, read when no report is supplied. */
  output?: () => string;
  report?: unknown;
}): BatchCheckpoint[] {
  const { batch } = input;
  if (!batch.workOrder)
    throw new PrMaintenanceError(
      "not_a_work_order",
      "This batch was prepared with a hand-written prompt before work orders; reconcile it from provider evidence.",
    );
  const workOrder = workContract(() => WorkOrderSchema.parse(batch.workOrder));
  let rawReport = input.report;
  if (rawReport === undefined) {
    if (!batch.stepId || !input.output)
      throw new PrMaintenanceError(
        "execution_unsettled",
        "The batch has no accepted attempt to read a report from.",
      );
    const extracted = extractWorkReport(input.output());
    if ("error" in extracted)
      throw new PrMaintenanceError(
        "report_missing",
        `${extracted.error} Recover with work_report and the report you read from the worker or the PR.`,
      );
    rawReport = extracted.report;
  }
  const report = workContract(() => WorkReportSchema.parse(rawReport));
  const settlement = workContract(() =>
    fleetSettlement({
      batch,
      workOrder,
      report,
      workerActor: `fleet-worker:${input.workerSessionId}`,
    }),
  );
  const base = {
    kind: "batch" as const,
    batchId: batch.id,
    generation: input.generation,
    findings: settlement.findings,
    effects: settlement.effects,
    executionSettled: true,
    evidence: settlement.evidence,
    usedMutations: settlement.usedMutations,
    published: settlement.published,
  };
  return [
    ...(batch.state === "accepted" && settlement.state !== "uncertain"
      ? [{ ...base, state: "reconciling" as const, usedMutations: undefined }]
      : []),
    // A needs_human finding raises the PR's design decision during settlement.
    { ...base, state: settlement.state },
  ];
}
