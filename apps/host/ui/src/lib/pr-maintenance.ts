import type {
  PrMaintenanceEnable,
  PrMaintenanceOperatorAction,
  PrMaintenanceRegistration,
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
  canAuthorize: boolean;
  unsupportedReason?: string;
};

export function getTaskMaintenance(taskId: string) {
  return api<TaskMaintenanceView>(
    `/api/runs/${encodeURIComponent(taskId)}/pr-maintenance`,
  );
}

export function enableTaskMaintenance(taskId: string, registration: PrMaintenanceEnable) {
  return api<PrMaintenanceRegistration>(
    `/api/runs/${encodeURIComponent(taskId)}/pr-maintenance`,
    { method: "POST", body: JSON.stringify({ action: "enable", registration }) },
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
