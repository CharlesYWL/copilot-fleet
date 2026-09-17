import { createHash } from "node:crypto";
import {
  commandSupervisorReadiness,
  prepareCommandProcess,
  readCommandProcessReceipt,
} from "./command-supervisor.js";
import type { CommandSupervisor } from "./command-execution-manager.js";

export const nativeCommandSupervisor: CommandSupervisor = {
  readiness: commandSupervisorReadiness,
  prepare: (input) =>
    prepareCommandProcess({
      ...input,
      startExpiresAt: new Date(input.startExpiresAt).toISOString(),
    }),
  recover: async (directory, expected, descriptor, persistIdentity) => {
    const receipt = await readCommandProcessReceipt(directory);
    if (
      expected &&
      receipt.identity &&
      ["executionId", "attemptId", "jobId", "commandSha256"].some(
        (key) =>
          (expected as Record<string, unknown>)[key] !==
          (receipt.identity as unknown as Record<string, unknown>)[key],
      )
    )
      throw new Error("Recovered supervisor identity does not match the journal.");
    if (
      receipt.identity &&
      descriptor &&
      (receipt.identity.executionId !== descriptor.executionId ||
        receipt.identity.attemptId !== descriptor.attemptId ||
        receipt.identity.commandSha256 !==
          createHash("sha256").update(descriptor.command).digest("hex"))
    )
      throw new Error(
        "Recovered supervisor manifest does not match the approved execution.",
      );
    if (receipt.identity) persistIdentity?.(receipt.identity);
    return receipt.result ?? undefined;
  },
};
