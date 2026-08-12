import { describe, expect, it } from "vitest";
import type { FleetSession } from "@fleet/protocol";
import { chimesFor, newPermissionIds, sessionStates } from "./chime-decisions";

const session = (id: string, state: FleetSession["state"]): FleetSession =>
  ({ id, state }) as FleetSession;

describe("chimesFor", () => {
  it("says nothing on the first view of the fleet", () => {
    // Opening the page onto finished sessions is not the same as watching them
    // finish, and a chime per session would be the worst first impression.
    expect(chimesFor(new Map(), [session("a", "idle"), session("b", "idle")])).toEqual(
      [],
    );
  });

  it("announces a turn that just ended", () => {
    const before = sessionStates([session("a", "running")]);
    expect(chimesFor(before, [session("a", "idle")])).toEqual([
      { kind: "done", sessionId: "a" },
    ]);
  });

  it("announces a run that ended badly too", () => {
    // A failure is still the end of waiting, and is the case an operator most
    // wants to hear about.
    const before = sessionStates([session("a", "running")]);
    expect(chimesFor(before, [session("a", "failed")])).toHaveLength(1);
  });

  it("stays quiet while an agent is still working", () => {
    const before = sessionStates([session("a", "running")]);
    expect(chimesFor(before, [session("a", "cancelling")])).toEqual([]);
  });

  it("stays quiet when a session was already finished", () => {
    // Reconnecting re-sends every session; an idle one that is still idle has
    // not just finished anything.
    const before = sessionStates([session("a", "idle")]);
    expect(chimesFor(before, [session("a", "idle")])).toEqual([]);
  });

  it("does not chime for a session it has never seen before", () => {
    // A session created in another browser tab arrives mid-flight, often
    // already idle; that is not this view watching it finish.
    const before = sessionStates([session("a", "running")]);
    expect(chimesFor(before, [session("a", "running"), session("new", "idle")])).toEqual(
      [],
    );
  });

  it("does not chime for a session that started working", () => {
    const before = sessionStates([session("a", "idle")]);
    expect(chimesFor(before, [session("a", "running")])).toEqual([]);
  });

  it("announces each of several finishing at once", () => {
    const before = sessionStates([
      session("a", "running"),
      session("b", "running"),
      session("c", "running"),
    ]);
    const chimes = chimesFor(before, [
      session("a", "idle"),
      session("b", "completed"),
      session("c", "running"),
    ]);
    expect(chimes.map((chime) => chime.sessionId)).toEqual(["a", "b"]);
  });
});

describe("newPermissionIds", () => {
  it("returns only requests that have not been announced", () => {
    expect(newPermissionIds(new Set(["r1"]), ["r1", "r2"])).toEqual(["r2"]);
  });

  it("ignores a request with no id rather than announcing a blank one", () => {
    expect(newPermissionIds(new Set(), ["", "r1"])).toEqual(["r1"]);
  });
});
