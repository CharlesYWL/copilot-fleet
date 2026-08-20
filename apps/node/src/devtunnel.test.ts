import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { connectDevTunnel, fatalConnectReason, lastLines } from "./devtunnel.js";

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
    // Verified against the real CLI: signing out makes `devtunnel connect` exit
    // 3 saying "Login required." No amount of retrying installs a login, so
    // this is one of the two failures reported straight away.
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
    });
    child.stderr.emit("data", Buffer.from("Login required.\n"));
    child.emit("exit", 3);
    await expect(pending).rejects.toThrow(/devtunnel user login/);
  });

  it("quotes the CLI rather than guessing why a connect died", async () => {
    // The failure that prompted this: a node exited reporting only `code=2` and
    // a stock hint about signing in, on a machine that was signed in. The line
    // that explained it had been read and thrown away.
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
    });
    child.stderr.emit("data", Buffer.from("Tunnel not found: fleet-abc\n"));
    child.emit("exit", 2);
    await expect(pending).rejects.toThrow(/Tunnel not found: fleet-abc/);
  });

  it("says a private tunnel is only visible to the account that owns it", async () => {
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
    });
    child.stderr.emit("data", Buffer.from("Tunnel not found: fleet-abc\n"));
    child.emit("exit", 2);
    await expect(pending).rejects.toThrow(/signed in as a different account/);
  });

  it("keeps trying when a first connect dies for a reason that may pass", async () => {
    // A node that has just rebooted races its own network. Ending the process on
    // the first failure is why a rebooted machine never came back while its
    // already-connected neighbours carried on working.
    const children: ReturnType<typeof fakeChild>[] = [];
    const timers: (() => void)[] = [];
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => {
        const next = fakeChild();
        children.push(next);
        return next;
      }) as any,
      setTimer: ((fn: () => void) => {
        timers.push(fn);
        return timers.length as unknown as NodeJS.Timeout;
      }) as never,
      clearTimer: (() => {}) as never,
    });

    children[0]!.stderr.emit("data", Buffer.from("connection reset by peer\n"));
    children[0]!.emit("exit", 1);
    // The backoff timer is the last one scheduled; running it retries.
    timers[timers.length - 1]!();
    expect(children).toHaveLength(2);

    children[1]!.stdout.emit(
      "data",
      Buffer.from("Forwarding from 127.0.0.1:8791 to host port 8790.\n"),
    );
    await expect(pending).resolves.toMatchObject({ url: "http://127.0.0.1:8791" });
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

  it("carries what the CLI said into the timeout, not just the elapsed time", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
      timeoutMs: 1_000,
    });
    child.stderr.emit("data", Buffer.from("Refreshing tunnel.\n"));
    const assertion = expect(pending).rejects.toThrow(/Refreshing tunnel/);
    await vi.advanceTimersByTimeAsync(1_100);
    await assertion;
    vi.useRealTimers();
  });
});

describe("fatalConnectReason", () => {
  it("treats a missing login as settled, however the CLI phrased it", () => {
    expect(fatalConnectReason(3, "")).toMatch(/devtunnel user login/);
    expect(fatalConnectReason(1, "Login required.")).toMatch(/devtunnel user login/);
  });

  it("explains a tunnel this machine cannot see", () => {
    expect(fatalConnectReason(2, "Tunnel not found: fleet-abc")).toMatch(
      /only to the account that owns it/,
    );
  });

  it("leaves anything it does not recognise to the retry loop", () => {
    // Being wrong about a transient failure costs the node its whole run, so an
    // unfamiliar message has to fall through to the side that recovers.
    expect(fatalConnectReason(2, "connection reset by peer")).toBeUndefined();
    expect(fatalConnectReason(1, "")).toBeUndefined();
    expect(fatalConnectReason(null, "")).toBeUndefined();
  });
});

describe("lastLines", () => {
  it("keeps the tail, where the CLI puts the reason", () => {
    expect(lastLines("Welcome\n\nConnecting\nTunnel not found: x\n")).toBe(
      "Welcome / Connecting / Tunnel not found: x",
    );
  });

  it("drops the banner a long run pushes ahead of the failure", () => {
    const noisy = ["one", "two", "three", "four", "five"].join("\n");
    expect(lastLines(noisy)).toBe("three / four / five");
  });

  it("has nothing to say about a CLI that printed nothing", () => {
    expect(lastLines("   \n\n")).toBe("");
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

  it("does not respawn a first connect that failed for good, so it surfaces", async () => {
    // Retrying is the default now, because a rebooted machine racing its own
    // network used to lose its whole run to one early failure. A tunnel this
    // account cannot see is the other kind: no wait improves it, so it is
    // reported once instead of being retried until the deadline.
    const child = fakeChild();
    const spawned: ReturnType<typeof fakeChild>[] = [];
    const timers: (() => void)[] = [];
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => {
        spawned.push(child);
        return child;
      }) as never,
      setTimer: ((fn: () => void) => {
        timers.push(fn);
        return timers.length as unknown as NodeJS.Timeout;
      }) as never,
      clearTimer: (() => {}) as never,
    });
    child.stderr.emit("data", Buffer.from("Tunnel not found: fleet-abc\n"));
    child.emit("exit", 2);
    await expect(pending).rejects.toThrow(/Tunnel not found/);
    for (const run of timers) run();
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

/**
 * The livelock this window exists to break.
 *
 * `recycle` is driven by the node failing to reach the Host, and a refused
 * loopback port is refused in about a millisecond — so while the forward is
 * down the node reaches its recycle threshold every six seconds and never
 * stops. Each rebuild was therefore killed a few seconds in, which is less
 * time than the relay handshake needs after a Host restart, so the client
 * never got as far as printing a port and the node stayed down until someone
 * pressed the button by hand.
 */
describe("connectDevTunnel recycle grace", () => {
  /**
   * Timers with real handles.
   *
   * The other harnesses in this file hand back `0` for every timer, which is
   * falsy — so a guard written as `if (timer) return` cannot be observed at
   * all. Anything asserting that a pending timer suppresses work has to model
   * handles properly or it passes without testing what it claims to.
   */
  const harness = (recycleGraceMs = 30_000) => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const pending = new Map<number, () => void>();
    let nextHandle = 1;
    return {
      children,
      pending,
      /** Fires the most recently scheduled timer that is still outstanding. */
      fireLatest: () => {
        const handle = Math.max(...pending.keys());
        const fn = pending.get(handle);
        pending.delete(handle);
        fn?.();
      },
      options: {
        spawnProcess: (() => {
          const next = fakeChild();
          children.push(next);
          return next;
        }) as never,
        setTimer: ((fn: () => void) => {
          const handle = nextHandle;
          nextHandle += 1;
          pending.set(handle, fn);
          return handle as unknown as NodeJS.Timeout;
        }) as never,
        clearTimer: ((handle: number) => {
          pending.delete(handle);
        }) as never,
        recycleGraceMs,
      },
    };
  };

  const forwarding = (child: ReturnType<typeof fakeChild>, port = 8790) =>
    child.stdout.emit("data", Buffer.from(`Forwarding from 127.0.0.1:${port} to x\n`));

  const rebuilt = async (h: ReturnType<typeof harness>) => {
    const promise = connectDevTunnel("fleet-abc", h.options);
    forwarding(h.children[0]!);
    const conn = await promise;
    // A healthy client is fair game, so this first ask goes through and the
    // respawn it queues brings up the client the test is actually about.
    conn.recycle();
    h.fireLatest();
    return conn;
  };

  it("leaves a rebuilt client alone while it is still handshaking", async () => {
    const h = harness();
    const conn = await rebuilt(h);
    expect(h.children).toHaveLength(2);

    conn.recycle();

    // Without the window this is the kill that made the outage permanent: the
    // replacement dies before it can report a port, so `attempt` never resets
    // and the next one gets no longer.
    expect(h.children[1]!.kill).not.toHaveBeenCalled();
    expect(h.children).toHaveLength(2);
  });

  it("hands the recycler back its job once the port is reported", async () => {
    const h = harness();
    const conn = await rebuilt(h);
    forwarding(h.children[1]!, 8791);

    conn.recycle();

    // Up and serving, so a failure to reach the Host really is evidence about
    // the tunnel again.
    expect(h.children[1]!.kill).toHaveBeenCalled();
  });

  it("still rebuilds a client that has wedged without ever reporting a port", async () => {
    const h = harness();
    const conn = await rebuilt(h);

    conn.recycle();
    expect(h.children[1]!.kill).not.toHaveBeenCalled();
    // The window is a grace, not an amnesty: it runs out.
    h.fireLatest();
    conn.recycle();

    expect(h.children[1]!.kill).toHaveBeenCalled();
  });

  it("does not let an expired window disarm the next client's", async () => {
    const h = harness();
    const conn = await rebuilt(h);
    // Captured rather than looked up later: clearing a timer removes it from
    // the map, but the callback a real runtime already queued still runs.
    const staleWindow = h.pending.get(Math.max(...h.pending.keys()))!;

    forwarding(h.children[1]!, 8791);
    conn.recycle();
    h.fireLatest();
    expect(h.children).toHaveLength(3);

    // A callback that outlived its window must not clear the handle belonging
    // to the client that replaced it, or the recycler gets a brand new child.
    staleWindow();
    conn.recycle();

    expect(h.children[2]!.kill).not.toHaveBeenCalled();
  });
});
