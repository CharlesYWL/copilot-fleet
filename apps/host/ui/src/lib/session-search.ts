import type { FleetSession } from "@fleet/protocol";
import type { SessionWorkspaceGroup } from "./session-groups";
import { sessionLabel } from "./session-label";
import { matchesAllTerms } from "./search-text";

/**
 * The sidebar tree narrowed to what a search names.
 *
 * A session stays when every term appears in its project, its node or its
 * label, so typing a project or machine name keeps everything under it and
 * "checkout weili lint" narrows all three levels at once. Branches left with
 * no sessions disappear; a project that never had any stays only when its own
 * name matches, because that is the one thing it can be found by.
 *
 * Groups and nodes are copied rather than edited, so the unfiltered tree the
 * sidebar keeps for reordering is never touched.
 */
export function filterSessionGroups(
  groups: readonly SessionWorkspaceGroup[],
  terms: readonly string[],
): SessionWorkspaceGroup[] {
  if (terms.length === 0) return [...groups];
  return groups.flatMap((group) => {
    const nodes = group.nodes.flatMap((node) => {
      const sessions = node.sessions.filter((session) =>
        matchesAllTerms(
          [group.workspaceName, node.nodeName, sessionLabel(session)],
          terms,
        ),
      );
      return sessions.length > 0 ? [{ ...node, sessions }] : [];
    });
    if (nodes.length > 0) return [{ ...group, nodes }];
    const emptyProjectMatches =
      group.nodes.length === 0 && matchesAllTerms([group.workspaceName], terms);
    return emptyProjectMatches ? [{ ...group, nodes: [] }] : [];
  });
}

/**
 * A flat list of sessions — Favorites, conversations — narrowed the same way.
 *
 * An orchestrator conversation is matched by its name alone. It is the
 * fleet's own surface rather than one project's, which is why it sits above
 * the tree, so the checkout its process happens to occupy should not decide
 * whether it is found.
 */
export function filterSessions(
  sessions: readonly FleetSession[],
  terms: readonly string[],
): FleetSession[] {
  if (terms.length === 0) return [...sessions];
  return sessions.filter((session) =>
    matchesAllTerms(
      session.runRole === "lead"
        ? [sessionLabel(session)]
        : [session.workspaceName, session.nodeName, sessionLabel(session)],
      terms,
    ),
  );
}

/**
 * How many things a search found, for the count read out to assistive tech.
 *
 * A session can be listed twice — a favourite also has its row in the tree —
 * and is counted once. A project found by its own name with nothing under it
 * counts too, because that row is what the search turned up.
 */
export function countSearchMatches(
  groups: readonly SessionWorkspaceGroup[],
  listed: readonly FleetSession[],
): number {
  const sessions = new Set(listed.map((session) => session.id));
  let emptyProjects = 0;
  for (const group of groups) {
    if (group.nodes.length === 0) emptyProjects += 1;
    for (const node of group.nodes) {
      for (const session of node.sessions) sessions.add(session.id);
    }
  }
  return sessions.size + emptyProjects;
}
