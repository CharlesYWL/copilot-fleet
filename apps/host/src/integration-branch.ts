function branchSegment(value: string, fallback: string, maxLength = 48): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return normalized || fallback;
}

function localBranchRef(value: string): string {
  return value.startsWith("refs/heads/") ? value : `refs/heads/${value}`;
}

function remoteBranchRef(value: string): string {
  if (value.startsWith("refs/remotes/")) return value;
  const normalized = value.replace(/^refs\/heads\//, "");
  return normalized.startsWith("origin/")
    ? `refs/remotes/${normalized}`
    : `refs/remotes/origin/${normalized}`;
}

export function integrationBranchSettings(input: {
  username?: string | undefined;
  taskName: string;
  baseRef?: string | undefined;
  branchRef?: string | undefined;
}): {
  baseRef: string;
  branchRef: string;
  remote: string;
} {
  const baseRef = remoteBranchRef(input.baseRef || "origin/main");
  return {
    baseRef,
    branchRef: localBranchRef(
      input.branchRef ||
        `dev/${branchSegment(input.username ?? "", "operator", 32)}/${branchSegment(input.taskName, "task")}`,
    ),
    remote: baseRef.split("/")[2] || "origin",
  };
}
