export const HOST_ARCHIVE_BYTES = 50 * 1024 * 1024;

export class BackupCapacityError extends Error {
  readonly statusCode = 413;
  readonly code = "backup_archive_capacity";
  constructor() {
    super(
      "The complete archive exceeds the 50 MiB import capacity. No command evidence was omitted.",
    );
  }
}

export function assertHostArchiveSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > HOST_ARCHIVE_BYTES)
    throw new BackupCapacityError();
}
