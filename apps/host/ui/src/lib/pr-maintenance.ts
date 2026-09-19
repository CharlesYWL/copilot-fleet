import type {
  PrMaintenanceEnable,
  PrMaintenanceOperatorAction,
  PrMaintenanceRegistration,
  PrMaintenanceProposal,
} from "@fleet/protocol";
import { api } from "../hooks/useFleet";

export type MaintenanceReviewReference = {
  recordId: string;
  expectedVersion: number;
  decisionId: string;
  decisionVersion: number;
};

export type TaskMaintenanceView = {
  records: PrMaintenanceRegistration[];
  proposal?: PrMaintenanceProposal;
  canAuthorize: boolean;
  unsupportedReason?: string;
};

export function getTaskMaintenance(taskId: string) {
  return api<TaskMaintenanceView>(
    `/api/runs/${encodeURIComponent(taskId)}/pr-maintenance`,
  );
}

export function prepareTaskMaintenance(taskId: string, prUrl?: string) {
  return api<{ status: "preparation_requested"; taskId: string }>(
    `/api/runs/${encodeURIComponent(taskId)}/pr-maintenance`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "prepare",
        ...(prUrl?.trim() ? { prUrl: prUrl.trim() } : {}),
      }),
    },
  );
}

export function enableTaskMaintenance(taskId: string, registration: PrMaintenanceEnable) {
  return api<PrMaintenanceRegistration>(
    `/api/runs/${encodeURIComponent(taskId)}/pr-maintenance`,
    { method: "POST", body: JSON.stringify({ action: "enable", registration }) },
  );
}

export function authorizeTaskMaintenanceProposal(
  taskId: string,
  proposal: Pick<PrMaintenanceProposal, "id" | "version">,
) {
  return api<PrMaintenanceRegistration>(
    `/api/runs/${encodeURIComponent(taskId)}/pr-maintenance`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "authorize_proposal",
        proposalId: proposal.id,
        expectedVersion: proposal.version,
      }),
    },
  );
}

export function actOnTaskMaintenance(
  taskId: string,
  record: PrMaintenanceRegistration,
  action: PrMaintenanceOperatorAction,
) {
  return api<PrMaintenanceRegistration>(
    `/api/runs/${encodeURIComponent(taskId)}/pr-maintenance`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "update",
        operation: action,
        recordId: record.id,
        expectedVersion: record.version,
      }),
    },
  );
}
