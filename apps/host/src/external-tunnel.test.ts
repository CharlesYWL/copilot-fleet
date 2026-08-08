import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readExternalTunnel, adoptOrKillStale } from "./external-tunnel.js";

const writeState = (contents: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "fleet-tunnel-")), "tunnel.json");
  writeFileSync(path, contents);
  return path;
};

const alive = () => true;
const dead = () => false;

describe("readExternalTunnel", () => {
  it("reports the url published by a live tunnel process", () => {
    const path = writeState(
      JSON.stringify({ provider: "bore", url: "http://bore.pub:1234", pid: 42 }),
    );
    expect(readExternalTunnel(path, alive)).toEqual({
      provider: "bore",
      url: "http://bore.pub:1234",
    });
  });

  it("treats a started-but-urlless tunnel as pending", () => {
    const path = writeState(JSON.stringify({ provider: "bore", url: "", pid: 42 }));
    expect(readExternalTunnel(path, alive)).toEqual({
      provider: "bore",
      url: undefined,
    });
  });

  it("ignores state left behind by a dead process", () => {
    // A hard kill leaves the file in place; serving that URL would point nodes
    // at a tunnel that no longer forwards anywhere.
    const path = writeState(
      JSON.stringify({ provider: "bore", url: "http://bore.pub:1234", pid: 42 }),
    );
    expect(readExternalTunnel(path, dead)).toBeUndefined();
  });

  it("ignores a missing, malformed, or unknown-provider file", () => {
    expect(readExternalTunnel("/nonexistent/tunnel.json", alive)).toBeUndefined();
    expect(readExternalTunnel(writeState("not json"), alive)).toBeUndefined();
    expect(
      readExternalTunnel(
        writeState(JSON.stringify({ provider: "wat", url: "x", pid: 1 })),
        alive,
      ),
    ).toBeUndefined();
  });
});

describe("adoptOrKillStale", () => {
  const state = () =>
    writeState(JSON.stringify({ provider: "bore", url: "http://x", pid: 42 }));

  it("kills a leftover provider so two tunnels cannot fight over the port", () => {
    // This is the SIGKILL case: the wrapper died without cleaning up, leaving
    // its provider running and untracked.
    const killed: number[] = [];
    adoptOrKillStale(
      state(),
      () => {},
      alive,
      (pid) => killed.push(pid),
    );
    expect(killed).toEqual([42]);
  });

  it("does nothing when the recorded process is already gone", () => {
    const killed: number[] = [];
    adoptOrKillStale(
      state(),
      () => {},
      dead,
      (pid) => killed.push(pid),
    );
    expect(killed).toEqual([]);
  });

  it("does nothing when there is no usable state to act on", () => {
    const killed: number[] = [];
    const record = (pid: number) => killed.push(pid);
    adoptOrKillStale("/nonexistent/tunnel.json", () => {}, alive, record);
    adoptOrKillStale(writeState("not json"), () => {}, alive, record);
    expect(killed).toEqual([]);
  });

  it("survives a kill that throws because the process vanished mid-check", () => {
    expect(() =>
      adoptOrKillStale(
        state(),
        () => {},
        alive,
        () => {
          throw new Error("ESRCH");
        },
      ),
    ).not.toThrow();
  });
});
