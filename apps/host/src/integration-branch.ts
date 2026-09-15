function branchSegment(value: string, fallback: string, maxLength = 48): string {
  const normalized = value
    .trim()
    .toLowerCase()
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
  runId?: string | undefined;
  username?: string | undefined;
  taskName: string;
  baseRef?: string | undefined;
  branchRef?: string | undefined;
  existingBranchRefs?: readonly string[] | undefined;
}): {
  baseRef: string;
  branchRef: string;
  remote: string;
} {
  const baseRef = input.baseRef ? remoteBranchRef(input.baseRef) : "";
  const taskFallback = `task-${branchSegment(input.runId ?? "", "run", 8)}`;
  const usernameSegment = branchSegment(
    (input.username ?? "").replace(/@.*$/, ""),
    "operator",
    32,
  );
  const taskSegment = branchSegment(input.taskName, taskFallback, 48);
  const generatedBranchRef = localBranchRef(`dev/${usernameSegment}/${taskSegment}`);
  const branchRef =
    !input.branchRef && input.existingBranchRefs?.includes(generatedBranchRef)
      ? localBranchRef(
          `dev/${usernameSegment}/${branchSegment(input.taskName, "task", 39)}-${branchSegment(input.runId ?? "", "run", 8)}`,
        )
      : generatedBranchRef;
  return {
    baseRef,
    branchRef: input.branchRef ? localBranchRef(input.branchRef) : branchRef,
    remote: baseRef.split("/")[2] || "origin",
  };
}
