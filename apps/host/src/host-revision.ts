import { gitRevision } from "@fleet/protocol/runtime";

/**
 * The commit this Host is running, re-read as it moves.
 *
 * Reading it once at startup is wrong in a way that only appears on the machine
 * the code is written on. Committing moves HEAD without touching a file, so a
 * watcher has no reason to restart the Host, so the Host goes on reporting the
 * commit it happened to start at. Nodes that update land on the real HEAD,
 * disagree with that frozen value, and are marked out of date — by an update
 * that worked perfectly. Pressing update again re-lands the same commit and
 * changes nothing, so the badge can never clear and the operator is left with a
 * button that reports failure every time it succeeds.
 *
 * Cached because a snapshot goes out on every broadcast and this shells out to
 * git. A commit is something a person does, so a few seconds of staleness costs
 * nothing and a subprocess per snapshot would cost a great deal.
 */
export function cachedGitRevision(
  read: () => string = () => gitRevision(),
  ttlMs = 5_000,
  now: () => number = () => Date.now(),
): () => string {
  let value: string | undefined;
  let readAt = 0;
  return () => {
    const at = now();
    if (value !== undefined && at - readAt < ttlMs) return value;
    readAt = at;
    value = read();
    return value;
  };
}
