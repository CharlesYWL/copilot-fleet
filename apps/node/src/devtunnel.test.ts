import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { connectDevTunnel } from "./devtunnel.js";

/** A stand-in for the CLI child so no test spawns a real tunnel. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
  });
  return child;
}

const spawnFake = (child: ReturnType<typeof fakeChild>) =>
  vi.fn(() => child) as unknown as Parameters<typeof connectDevTunnel>[1] extends never
    ? never
    : never;

describe("connectDevTunnel", () => {
  it("reads the forwarded port back rather than assuming the host's", async () => {
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
      log: () => {},
    });
    // The CLI falls back to another port when the first is taken; a node that
    // assumed 8790 here would dial nothing.
    child.stdout.emit(
      "data",
      Buffer.from("SSH: Forwarding from 127.0.0.1:8791 to host port 8790.\n"),
    );
    await expect(pending).resolves.toMatchObject({ url: "http://127.0.0.1:8791" });
  });

  it("survives the line arriving split across chunks", async () => {
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
    });
    child.stdout.emit("data", Buffer.from("SSH: Forwarding from 127.0.0"));
    child.stdout.emit("data", Buffer.from(".1:9001 to host port 8790.\n"));
    await expect(pending).resolves.toMatchObject({ url: "http://127.0.0.1:9001" });
  });

  it("explains a signed-out CLI instead of hanging until the timeout", async () => {
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
    });
    child.emit("exit", 1);
    await expect(pending).rejects.toThrow(/devtunnel user login/);
  });

  it("names the install step when the binary is missing", async () => {
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
    });
    child.emit("error", new Error("spawn devtunnel ENOENT"));
    await expect(pending).rejects.toThrow(/winget install Microsoft.devtunnel/);
  });

  it("gives up rather than leaving a node stuck behind a silent tunnel", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
      timeoutMs: 1_000,
    });
    const assertion = expect(pending).rejects.toThrow(/did not report a forwarded port/);
    await vi.advanceTimersByTimeAsync(1_100);
    await assertion;
    expect(child.kill).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

export { spawnFake };

describe("connectDevTunnel supervision", () => {
  /**
   * Restarting the Host replaces its tunnel host and its SSH host key, which
   * the client answers by tearing the session down. When that teardown ends the
   * process instead of refreshing, an unsupervised child left the node dialing
   * a dead port forever — the reason it had to be restarted by hand.
   */
  it("restarts a connect that dies after it was already forwarding", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const spawned: ReturnType<typeof fakeChild>[] = [];
    const timers: (() => void)[] = [];

    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => {
        const next = spawned.length === 0 ? first : second;
        spawned.push(next);
        return next;
      }) as never,
      setTimer: ((fn: () => void) => {
        timers.push(fn);
        return 0 as unknown as NodeJS.Timeout;
      }) as never,
      clearTimer: (() => {}) as never,
    });
    first.stdout.emit("data", Buffer.from("Forwarding from 127.0.0.1:8791 to host\n"));
    const conn = await pending;
    expect(conn.url).toBe("http://127.0.0.1:8791");

    first.emit("exit", 1);
    // The backoff timer is the last one scheduled; running it respawns.
    timers[timers.length - 1]!();
    expect(spawned).toHaveLength(2);
  });

  it("reports a moved port so the node can follow it", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const spawned: ReturnType<typeof fakeChild>[] = [];
    const timers: (() => void)[] = [];
    const moves: string[] = [];

    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => {
        const next = spawned.length === 0 ? first : second;
        spawned.push(next);
        return next;
      }) as never,
      setTimer: ((fn: () => void) => {
        timers.push(fn);
        return 0 as unknown as NodeJS.Timeout;
      }) as never,
      clearTimer: (() => {}) as never,
      onUrlChanged: (url) => moves.push(url),
    });
    first.stdout.emit("data", Buffer.from("Forwarding from 127.0.0.1:8791 to host\n"));
    const conn = await pending;

    first.emit("exit", 1);
    timers[timers.length - 1]!();
    second.stdout.emit("data", Buffer.from("Forwarding from 127.0.0.1:9002 to host\n"));

    expect(moves).toEqual(["http://127.0.0.1:9002"]);
    expect(conn.url).toBe("http://127.0.0.1:9002");
  });

  it("does not respawn a connect that never forwarded, so a real failure surfaces", async () => {
    const child = fakeChild();
    const spawned: ReturnType<typeof fakeChild>[] = [];
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => {
        spawned.push(child);
        return child;
      }) as never,
    });
    child.emit("exit", 1);
    await expect(pending).rejects.toThrow(/devtunnel user login/);
    expect(spawned).toHaveLength(1);
  });

  it("stops supervising once the node asks it to stop", async () => {
    const child = fakeChild();
    const timers: (() => void)[] = [];
    const spawned: ReturnType<typeof fakeChild>[] = [];
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => {
        spawned.push(child);
        return child;
      }) as never,
      setTimer: ((fn: () => void) => {
        timers.push(fn);
        return 0 as unknown as NodeJS.Timeout;
      }) as never,
      clearTimer: (() => {}) as never,
    });
    child.stdout.emit("data", Buffer.from("Forwarding from 127.0.0.1:8791 to host\n"));
    const conn = await pending;
    conn.stop();
    child.emit("exit", 0);
    for (const run of timers) run();
    expect(spawned).toHaveLength(1);
  });
});

describe("connectDevTunnel recycle", () => {
  const harness = () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const timers: (() => void)[] = [];
    const make = () => {
      const next = fakeChild();
      children.push(next);
      return next;
    };
    return {
      children,
      timers,
      options: {
        spawnProcess: (() => make()) as never,
        setTimer: ((fn: () => void) => {
          timers.push(fn);
          return 0 as unknown as NodeJS.Timeout;
        }) as never,
        clearTimer: (() => {}) as never,
      },
    };
  };

  /**
   * The failure that survives exit-based supervision: the client keeps running
   * and its local listener keeps accepting, so nothing reports a problem while
   * the far end is gone. Only the node knows, so it has to be able to say so.
   */
  it("rebuilds a tunnel that never exited but stopped reaching the Host", async () => {
    const h = harness();
    const pending = connectDevTunnel("fleet-abc", h.options);
    h.children[0]!.stdout.emit(
      "data",
      Buffer.from("Forwarding from 127.0.0.1:8791 to x\n"),
    );
    const conn = await pending;

    expect(h.children).toHaveLength(1);
    conn.recycle();
    expect(h.children[0]!.kill).toHaveBeenCalled();
    h.timers[h.timers.length - 1]!();
    expect(h.children).toHaveLength(2);
  });

  it("ignores a second request while a rebuild is already queued", async () => {
    const h = harness();
    const pending = connectDevTunnel("fleet-abc", h.options);
    h.children[0]!.stdout.emit(
      "data",
      Buffer.from("Forwarding from 127.0.0.1:8791 to x\n"),
    );
    const conn = await pending;

    conn.recycle();
    conn.recycle();
    conn.recycle();
    h.timers[h.timers.length - 1]!();
    // One rebuild, not three: repeated asks must not stack spawns or reset the
    // backoff that keeps a dead tunnel from being hammered.
    expect(h.children).toHaveLength(2);
  });

  it("does nothing once the node has stopped the tunnel", async () => {
    const h = harness();
    const pending = connectDevTunnel("fleet-abc", h.options);
    h.children[0]!.stdout.emit(
      "data",
      Buffer.from("Forwarding from 127.0.0.1:8791 to x\n"),
    );
    const conn = await pending;

    conn.stop();
    conn.recycle();
    for (const run of h.timers) run();
    expect(h.children).toHaveLength(1);
  });
});

describe("connectDevTunnel rebuildNow", () => {
  const harness = () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const timers: (() => void)[] = [];
    const cleared: number[] = [];
    const make = () => {
      const next = fakeChild();
      children.push(next);
      return next;
    };
    return {
      children,
      timers,
      cleared,
      options: {
        spawnProcess: (() => make()) as never,
        setTimer: ((fn: () => void) => {
          timers.push(fn);
          return timers.length as unknown as NodeJS.Timeout;
        }) as never,
        clearTimer: ((timer: number) => {
          cleared.push(timer);
        }) as never,
      },
    };
  };

  const ready = async (h: ReturnType<typeof harness>) => {
    const pending = connectDevTunnel("fleet-abc", h.options);
    h.children[0]!.stdout.emit(
      "data",
      Buffer.from("Forwarding from 127.0.0.1:8791 to x\n"),
    );
    return pending;
  };

  /**
   * The whole reason the button exists. `recycle` defers to a queued rebuild,
   * so a node already sitting on a 30s backoff would answer a click by doing
   * nothing at all — at the one moment someone is watching and knows the far
   * end just changed.
   */
  it("rebuilds immediately even when a backoff is already counting down", async () => {
    const h = harness();
    const conn = await ready(h);

    conn.recycle();
    expect(h.children).toHaveLength(1); // queued, not spawned

    conn.rebuildNow();
    // Spawned without anyone running the pending timer.
    expect(h.children).toHaveLength(2);
    expect(h.cleared.length).toBeGreaterThan(0);
  });

  it("does not let the cancelled backoff spawn a second tunnel later", async () => {
    const h = harness();
    const conn = await ready(h);

    conn.recycle();
    conn.rebuildNow();
    const spawnedAfterRebuild = h.children.length;
    // Whatever timers were left over must not add another child on top.
    for (const run of h.timers) run();
    expect(h.children).toHaveLength(spawnedAfterRebuild);
  });

  it("rebuilds a healthy tunnel too, since only the operator knows it is stale", async () => {
    const h = harness();
    const conn = await ready(h);

    conn.rebuildNow();
    expect(h.children[0]!.kill).toHaveBeenCalled();
    expect(h.children).toHaveLength(2);
  });

  it("stays quiet after the node has stopped the tunnel", async () => {
    const h = harness();
    const conn = await ready(h);

    conn.stop();
    conn.rebuildNow();
    expect(h.children).toHaveLength(1);
  });

  it("reports a tunnel that will not come up as a problem, not as chatter", async () => {
    // The node page filters to problems by default, because a stuck node
    // repeats one line every two seconds. A tunnel failing to start that logged
    // at the same level as "forwarding 127.0.0.1:8790" would be hidden by the
    // one view built to find it.
    const notes: string[] = [];
    const problems: string[] = [];
    const h = harness();
    const pending = connectDevTunnel("fleet-abc", {
      ...h.options,
      log: (message: string) => notes.push(message),
      warn: (message: string) => problems.push(message),
    });
    h.children[0]!.stdout.emit(
      "data",
      Buffer.from("Forwarding from 127.0.0.1:8791 to x\n"),
    );
    const conn = await pending;

    conn.recycle();
    h.children[0]!.emit("exit", 1);

    expect(problems.some((line) => line.includes("not reaching the Host"))).toBe(true);
    expect(notes.some((line) => line.includes("forwarding"))).toBe(true);
    expect(notes.some((line) => line.includes("not reaching the Host"))).toBe(false);
  });

  it("sends failures to the ordinary log when the caller keeps one channel", async () => {
    const notes: string[] = [];
    const h = harness();
    const pending = connectDevTunnel("fleet-abc", {
      ...h.options,
      log: (message: string) => notes.push(message),
    });
    h.children[0]!.stdout.emit(
      "data",
      Buffer.from("Forwarding from 127.0.0.1:8791 to x\n"),
    );
    const conn = await pending;

    conn.recycle();
    expect(notes.some((line) => line.includes("not reaching the Host"))).toBe(true);
  });
});
