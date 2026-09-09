import { DRI_BACKUP_LIMITS, type DriBackupCounts } from "@fleet/protocol";

export type DriBackupLimits = { [K in keyof typeof DRI_BACKUP_LIMITS]: number };
export type BackupCandidate = {
  id: string;
  decisions: number;
  records: number;
  attempts: number;
  bytes?: number;
};
export const DRI_BACKUP_MAX_BYTES = 8 * 1024 * 1024;

/** Select whole investigations so a bounded archive never severs report citations. */
export function selectBackupInvestigations(
  candidates: readonly BackupCandidate[],
  limits: DriBackupLimits = DRI_BACKUP_LIMITS,
  maxBytes = DRI_BACKUP_MAX_BYTES,
): { ids: string[]; counts: DriBackupCounts; bytes: number } {
  const ids: string[] = [];
  const counts = {
    investigations: 0,
    decisions: 0,
    records: 0,
    attempts: 0,
    tombstones: 0,
  };
  let bytes = 0;
  for (const candidate of candidates) {
    if (
      ids.length === limits.investigations ||
      bytes + (candidate.bytes ?? 0) > maxBytes ||
      (["decisions", "records", "attempts"] as const).some(
        (kind) => counts[kind] + candidate[kind] > limits[kind],
      )
    )
      break;
    ids.push(candidate.id);
    counts.investigations++;
    counts.decisions += candidate.decisions;
    counts.records += candidate.records;
    counts.attempts += candidate.attempts;
    bytes += candidate.bytes ?? 0;
  }
  return { ids, counts, bytes };
}
