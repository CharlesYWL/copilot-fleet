import {
  CreateOrchestrationSchema,
  terminalSessionStates,
  type DriClassification,
  type OrchestrationCreationResult,
  type RunCreationReceipt,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import { DriCoordinator } from "../dri/coordinator.js";
import { classifyDriRequest } from "../dri/classifier.js";
import { contentHash, DriError } from "../dri/safety.js";
import type { OrchestratorEngine } from "./engine.js";

function taskBrief(name: string, objective: string, workspace: string): string {
  return [
    `<fleet-task name=${JSON.stringify(name)} workspace=${JSON.stringify(workspace)}>`,
    objective,
    "</fleet-task>",
    "",
    `Plan this with fleet_plan_task using the task name "${name}", then dispatch the`,
    "work for its first phase and end your turn.",
  ].join("\n");
}

export class OrchestrationCreationService {
  constructor(
    private readonly service: FleetService,
    private readonly engine: OrchestratorEngine,
    private readonly dri: DriCoordinator = new DriCoordinator(service),
    /** Test/demo composition only. Never accepted from an API request or environment. */
    private readonly fixtureRouting = false,
  ) {}

  async shutdown(): Promise<void> {
    await this.dri.shutdown();
  }

  preview(input: unknown): DriClassification {
    return classifyDriRequest(input);
  }

  create(
    raw: unknown,
    context: { leadSessionId?: string; standalone?: boolean } = {},
  ): OrchestrationCreationResult {
    const input = CreateOrchestrationSchema.parse(raw);
    const classification = this.preview(input);
    if (classification.requiresConfirmation || classification.needsIncident)
      return { kind: "confirmation_required", classification };

    const { store } = this.service;
    const leadId = context.leadSessionId ?? input.leadSessionId ?? "";
    const scope = [context.standalone ? "standalone" : "lead", leadId];
    const { requestId, ...request } = input;
    const inputHash = contentHash([scope, request]);
    // Legacy regular callers without a key keep their original create-every-time behavior.
    const receipt: RunCreationReceipt | undefined =
      requestId || classification.route === "dri"
        ? {
            keyHash: contentHash([scope, requestId ?? inputHash]),
            inputHash,
            workflow: classification.route === "dri" ? "dri" : "regular",
          }
        : undefined;
    const previous = receipt ? store.runForCreationKey(receipt.keyHash) : undefined;
    if (previous) {
      if (previous.creationReceipt?.inputHash !== inputHash)
        throw new DriError(
          "Request key already used for different input. Start a new request to change it.",
          409,
        );
      if (previous.creationReceipt?.workflow === "dri") {
        const investigation = store.dri.forRun(previous.id);
        if (!investigation)
          throw new DriError(
            "The retained DRI request has no restorable investigation. Restore complete source data; it will not be recreated.",
            410,
          );
        return {
          kind: "created",
          workflow: "dri",
          classification,
          replayed: true,
          run: previous,
          investigation,
        };
      }
      return {
        kind: "created",
        workflow: "regular",
        classification,
        replayed: true,
        run: previous,
      };
    }

    const lead = leadId ? store.getSession(leadId) : undefined;
    if (leadId || (!context.standalone && classification.route === "regular")) {
      if (!lead || lead.runRole !== "lead" || terminalSessionStates.has(lead.state))
        throw new DriError("Orchestrator not found", 404);
      if (lead.stopRequested) throw new DriError("The orchestrator is stopping", 409);
    }
    if (classification.route === "dri") {
      const investigation = this.dri.create(
        {
          icm: classification.incident!.id,
          workspaceId: input.workspaceId,
          ...(leadId ? { leadSessionId: leadId } : {}),
          question: input.objective.slice(0, 2_000),
          ...(input.dri?.artifactRef ? { artifactRef: input.dri.artifactRef } : {}),
          profile: "auto",
          mode: this.fixtureRouting ? "fixture" : "live",
        },
        receipt,
      );
      void this.dri.execute(investigation.id);
      return {
        kind: "created",
        workflow: "dri",
        classification,
        replayed: false,
        run: store.getRun(investigation.runId)!,
        investigation: store.dri.require(investigation.id),
      };
    }

    const workspace = store.getWorkspace(input.workspaceId);
    if (!workspace) throw new DriError("Workspace not found", 404);
    if (
      !context.standalone &&
      !store
        .listPlacements()
        .some(
          (placement) =>
            placement.workspaceId === workspace.id &&
            store.getNode(placement.nodeId)?.online,
        )
    )
      throw new DriError(
        "No online node holds that workspace, so a task cannot run",
        409,
      );

    const run = store.writeAtomically(() => {
      const template = lead
        ? store
            .listRuns()
            .find((entry) => entry.leadSessionId === lead.id && !entry.investigationId)
        : undefined;
      const created = store.createRun({
        workspaceId: workspace.id,
        name: input.name,
        objective: input.objective,
        policy: context.standalone
          ? input.policy
          : {
              ...(template ? template.policy : {}),
              ...(input.policy ?? {}),
              wakePolicy: "on_any_settle",
              onStepFailure: "wake",
            },
        ...(receipt ? { creationReceipt: receipt } : {}),
      });
      return context.standalone
        ? created
        : store.updateRun(created.id, {
            leadSessionId: lead!.id,
            state: "running",
            pendingPrompt: taskBrief(created.name, created.objective, workspace.name),
          })!;
    });
    this.service.publishRun(run);
    if (!context.standalone) this.engine.tick();
    return {
      kind: "created",
      workflow: "regular",
      classification,
      replayed: false,
      run: store.getRun(run.id) ?? run,
    };
  }
}
