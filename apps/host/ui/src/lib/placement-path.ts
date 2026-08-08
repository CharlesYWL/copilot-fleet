/**
 * Decides what the placement path should become when the operator picks a
 * different node.
 *
 * A path is only replaced when it still holds the previous node's home
 * directory, which is a value the form filled in rather than something the
 * operator meant. That distinction is the whole point: overwriting
 * unconditionally would throw away typed input, while never overwriting leaves
 * a Windows path selected for a macOS machine.
 */
export function nextPlacementPath(
  currentPath: string,
  previousHomeDir: string | undefined,
  nextHomeDir: string,
): string {
  const ours = currentPath.trim().length === 0 || currentPath === previousHomeDir;
  if (!ours) return currentPath;
  return nextHomeDir;
}
