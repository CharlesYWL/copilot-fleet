import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cpuUsagePercent,
  HEALTH_SAMPLE_INTERVAL_MS,
  startHealthSampler,
} from "./health.js";

const cpu = (user: number, idle: number) => ({
  times: { user, idle, nice: 0, sys: 0, irq: 0 },
});
const disk = { bsize: 4096n, blocks: 100n, bavail: 40n };
const startedAt = "2026-09-14T12:00:00.000Z";

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(startedAt));
  const sources = {
    cpus: vi.fn(() => [cpu(100, 300)]),
    totalmem: vi.fn(() => 16 * 1024 ** 3),
    freemem: vi.fn(() => 4 * 1024 ** 3),
    homedir: vi.fn(() => "C:\\Users\\operator"),
    statfs: vi.fn(async (_path: string) => disk),
    now: () => Date.now(),
  };
  const log = vi.fn();
  return { sources, log };
}

afterEach(() => vi.useRealTimers());

describe("machine CPU counter deltas", () => {
  it("weights all CPUs by elapsed counters, rather than measuring this process", () => {
    expect(
      cpuUsagePercent([cpu(100, 300), cpu(10, 90)], [cpu(125, 375), cpu(85, 115)]),
    ).toBe(50);
    expect(cpuUsagePercent([cpu(10, 20)], [cpu(10, 40)])).toBe(0);
    expect(cpuUsagePercent([cpu(10, 20)], [cpu(30, 20)])).toBe(100);
  });

  it.each([
    [undefined, [cpu(1, 1)]],
    [[], []],
    [[cpu(1, 1)], []],
    [[cpu(1, 1)], [cpu(2, 2), cpu(2, 2)]],
    [[cpu(2, 2)], [cpu(1, 4)]],
    [[cpu(1, 1)], [cpu(1, 1)]],
    [[cpu(1, 1)], [cpu(NaN, 2)]],
    [[cpu(-1, 1)], [cpu(2, 2)]],
  ])("does not invent a reading for missing/reset counters", (previous, current) => {
    expect(cpuUsagePercent(previous, current!)).toBeUndefined();
  });
});

describe("health sampler", () => {
  it("starts with unavailable CPU, measures memory/disk, then samples every 30s", async () => {
    const { sources, log } = setup();
    const sampler = startHealthSampler(log, sources);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(sampler.latest().cpu).toBeUndefined();
      expect(sampler.latest().memory).toEqual({
        sampledAt: startedAt,
        totalBytes: 16 * 1024 ** 3,
        availableBytes: 4 * 1024 ** 3,
      });
      expect(sources.statfs).toHaveBeenCalledExactlyOnceWith("C:\\Users\\operator");
      expect(sampler.latest().disk).toEqual({
        sampledAt: startedAt,
        scope: "home",
        totalBytes: 409600,
        availableBytes: 163840,
      });
      sources.cpus.mockReturnValue([cpu(125, 375)]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sources.cpus).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(25_000);
      expect(sampler.latest().cpu).toEqual({
        sampledAt: "2026-09-14T12:00:30.000Z",
        usagePercent: 25,
      });
      expect(log).not.toHaveBeenCalled();
    } finally {
      sampler.stop();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources.cpus).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears failed metrics instead of relabeling old readings with a new time", async () => {
    const { sources, log } = setup();
    const sampler = startHealthSampler(log, sources);
    try {
      await vi.advanceTimersByTimeAsync(0);
      sources.cpus.mockImplementation(() => {
        throw new Error("CPU lookup failed");
      });
      sources.freemem.mockReturnValue(32 * 1024 ** 3);
      sources.statfs.mockRejectedValue(new Error("filesystem unavailable"));
      await vi.advanceTimersByTimeAsync(HEALTH_SAMPLE_INTERVAL_MS);
      expect(sampler.latest()).toEqual({});
      expect(log.mock.calls.flat().join("\n")).toContain("CPU lookup failed");
      expect(log.mock.calls.flat().join("\n")).toContain("memory unavailable");
      expect(log.mock.calls.flat().join("\n")).toContain("filesystem unavailable");
      sources.cpus.mockReturnValue([cpu(150, 400)]);
      await vi.advanceTimersByTimeAsync(HEALTH_SAMPLE_INTERVAL_MS);
      expect(sampler.latest().cpu).toBeUndefined();
      sources.cpus.mockReturnValue([cpu(200, 450)]);
      await vi.advanceTimersByTimeAsync(HEALTH_SAMPLE_INTERVAL_MS);
      expect(sampler.latest().cpu?.usagePercent).toBe(50);
    } finally {
      sampler.stop();
    }
  });

  it("bounds slow disk work while CPU/RAM advance, preserving the disk's source time", async () => {
    const { sources, log } = setup();
    const sampler = startHealthSampler(log, sources);
    try {
      await vi.advanceTimersByTimeAsync(0);
      let finish!: (value: typeof disk) => void;
      sources.statfs.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      sources.cpus.mockReturnValue([cpu(200, 400)]);
      await vi.advanceTimersByTimeAsync(HEALTH_SAMPLE_INTERVAL_MS);
      expect(sampler.latest().disk?.sampledAt).toBe(startedAt);
      sources.freemem.mockReturnValue(2 * 1024 ** 3);
      await vi.advanceTimersByTimeAsync(HEALTH_SAMPLE_INTERVAL_MS * 3);
      expect(sources.statfs).toHaveBeenCalledTimes(2);
      expect(sampler.latest().memory?.sampledAt).toBe("2026-09-14T12:02:00.000Z");
      expect(sampler.latest().memory?.availableBytes).toBe(2 * 1024 ** 3);
      finish(disk);
      await vi.advanceTimersByTimeAsync(0);
      expect(sampler.latest().disk?.sampledAt).toBe("2026-09-14T12:00:30.000Z");
    } finally {
      sampler.stop();
    }
  });

  it("does not await a stuck first disk sample and ignores its completion after shutdown", async () => {
    const { sources, log } = setup();
    let finish!: (value: typeof disk) => void;
    sources.statfs.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const sampler = startHealthSampler(log, sources);
    expect(sampler.latest().memory).toBeDefined();
    expect(sampler.latest().disk).toBeUndefined();
    await vi.advanceTimersByTimeAsync(HEALTH_SAMPLE_INTERVAL_MS * 4);
    expect(sources.statfs).toHaveBeenCalledOnce();
    sampler.stop();
    finish(disk);
    await vi.advanceTimersByTimeAsync(0);
    expect(sampler.latest().disk).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs missing OS counters and invalid filesystem capacities independently", async () => {
    const { sources, log } = setup();
    sources.cpus.mockReturnValue([]);
    sources.statfs.mockResolvedValue({ ...disk, bavail: 101n });
    const sampler = startHealthSampler(log, sources);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(sampler.latest().cpu).toBeUndefined();
      expect(sampler.latest().disk).toBeUndefined();
      expect(sampler.latest().memory).toBeDefined();
      expect(log.mock.calls.flat().join("\n")).toContain("no usable CPU counters");
      expect(log.mock.calls.flat().join("\n")).toContain(
        "disk (home volume) unavailable",
      );
    } finally {
      sampler.stop();
    }
  });
});
