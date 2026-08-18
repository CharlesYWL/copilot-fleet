import { describe, expect, it, vi } from "vitest";
import { cachedGitRevision } from "./host-revision.js";

describe("cachedGitRevision", () => {
  it("notices a commit made while the Host kept running", () => {
    // The bug this exists for: committing moves HEAD without touching a file,
    // so nothing restarts the Host. A revision captured once then disagrees
    // with every node that updates, and marks each of them out of date for
    // having landed on exactly the right commit.
    let head = "aaaaaaaaaaaa";
    let clock = 0;
    const revision = cachedGitRevision(
      () => head,
      5_000,
      () => clock,
    );

    expect(revision()).toBe("aaaaaaaaaaaa");
    head = "bbbbbbbbbbbb";
    clock = 6_000;
    expect(revision()).toBe("bbbbbbbbbbbb");
  });

  it("does not shell out to git on every snapshot", () => {
    // Snapshots go out on every broadcast; a subprocess each time would put a
    // synchronous spawn on the Host's hottest path.
    const read = vi.fn(() => "aaaaaaaaaaaa");
    let clock = 0;
    const revision = cachedGitRevision(read, 5_000, () => clock);

    revision();
    clock = 1_000;
    revision();
    clock = 4_999;
    revision();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("caches an empty answer rather than re-asking a checkout that has no git", () => {
    // A tarball deploy answers "" forever; retrying per snapshot would spawn a
    // doomed subprocess every time.
    const read = vi.fn(() => "");
    let clock = 0;
    const revision = cachedGitRevision(read, 5_000, () => clock);

    expect(revision()).toBe("");
    clock = 100;
    expect(revision()).toBe("");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads once on the first call rather than starting empty", () => {
    const revision = cachedGitRevision(() => "cccccccccccc");
    expect(revision()).toBe("cccccccccccc");
  });
});
