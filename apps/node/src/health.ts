import { statfs } from "node:fs/promises";
import { cpus, freemem, homedir, totalmem, type CpuInfo } from "node:os";
import { NodeHealthSchema, errorMessage, type NodeHealth } from "@fleet/protocol";

export const HEALTH_SAMPLE_INTERVAL_MS = 30_000;
type CpuCounters = Pick<CpuInfo, "times">[];
const counterNames = ["user", "nice", "sys", "idle", "irq"] as const;

/** The first observation, a reset, or a changed CPU count has no usable delta. */
export function cpuUsagePercent(
  previous: CpuCounters | undefined,
  current: CpuCounters,
): number | undefined {
  if (!previous || !current.length || previous.length !== current.length) return;
  let total = 0;
  let idle = 0;
  for (let index = 0; index < current.length; index++) {
    for (const name of counterNames) {
      const before = previous[index]!.times[name];
      const after = current[index]!.times[name];
      if (!Number.isFinite(before) || !Number.isFinite(after) || before < 0) return;
      const delta = after - before;
      if (delta < 0) return;
      total += delta;
      if (name === "idle") idle += delta;
    }
  }
  if (total <= 0 || !Number.isFinite(total)) return;
  return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
}

type HealthSources = {
  cpus: () => CpuCounters;
  totalmem: () => number;
  freemem: () => number;
  homedir: () => string;
  statfs: (path: string) => Promise<{ bsize: bigint; blocks: bigint; bavail: bigint }>;
  now: () => number;
};

const nativeSources: HealthSources = {
  cpus,
  totalmem,
  freemem,
  homedir,
  statfs: (path) => statfs(path, { bigint: true }),
  now: Date.now,
};

/**
 * One disk request at a time: a hung filesystem cannot grow a queue or stop
 * CPU/RAM sampling. While pending, any retained disk reading keeps its old time.
 */
export function startHealthSampler(
  logError: (message: string) => void,
  sources: HealthSources = nativeSources,
): { latest: () => NodeHealth; stop: () => void } {
  let latest: NodeHealth = {};
  let previous: CpuCounters | undefined;
  let diskPending = false;
  let stopped = false;
  const failed = (metric: string, error: unknown) =>
    logError(`Node health ${metric} unavailable: ${errorMessage(error)}`);

  const sample = () => {
    const sampledAt = new Date(sources.now()).toISOString();
    const next: NodeHealth = {};
    if (latest.disk) next.disk = latest.disk;
    try {
      const current = sources.cpus();
      if (
        !current.length ||
        current.some((cpu) =>
          counterNames.some(
            (name) => !Number.isFinite(cpu.times[name]) || cpu.times[name] < 0,
          ),
        )
      ) {
        throw new Error("OS returned no usable CPU counters");
      }
      const usagePercent = cpuUsagePercent(previous, current);
      if (previous && usagePercent === undefined) {
        failed("CPU", new Error("CPU counters changed or did not advance"));
      }
      previous = current;
      if (usagePercent !== undefined) next.cpu = { sampledAt, usagePercent };
    } catch (error) {
      previous = undefined;
      failed("CPU", error);
    }
    try {
      next.memory = NodeHealthSchema.shape.memory.parse({
        sampledAt,
        totalBytes: sources.totalmem(),
        availableBytes: sources.freemem(),
      });
    } catch (error) {
      failed("memory", error);
    }
    latest = next;
    if (diskPending) return;
    diskPending = true;
    void (async () => {
      try {
        const stats = await sources.statfs(sources.homedir());
        if (stats.bsize <= 0n) throw new Error("OS returned an invalid block size");
        const disk = NodeHealthSchema.shape.disk.parse({
          sampledAt,
          scope: "home",
          totalBytes: Number(stats.bsize * stats.blocks),
          availableBytes: Number(stats.bsize * stats.bavail),
        });
        if (!stopped) latest = { ...latest, disk };
      } catch (error) {
        if (!stopped) {
          delete latest.disk;
          failed("disk (home volume)", error);
        }
      } finally {
        diskPending = false;
      }
    })();
  };

  sample();
  const timer = setInterval(sample, HEALTH_SAMPLE_INTERVAL_MS);
  timer.unref();
  return {
    latest: () => latest,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
