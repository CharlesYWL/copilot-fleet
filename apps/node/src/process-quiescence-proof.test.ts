import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnManagedProcess, stopProcessTree } from "./process-quiescence.js";
import * as windowsJob from "./windows-process-job.js";

afterEach(() => vi.restoreAllMocks());

const proof = "fleet-process-tree-quiesced:84182898-7cb5-43ad-b4b5-505a49c15f51";

function supervisor() {
  const rawStderr = new PassThrough();
  const stdio: ChildProcessWithoutNullStreams["stdio"] = [
    new PassThrough(),
    new PassThrough(),
    rawStderr,
    null,
    null,
  ];
  const child = Object.assign(new ChildProcess(), {
    pid: 123_456,
    stdin: stdio[0],
    stdout: stdio[1],
    stderr: rawStderr,
    stdio,
  });
  vi.spyOn(windowsJob, "spawnWindowsJob").mockReturnValue({
    child,
    job: "fixture-job",
    proof,
  });
  const managed = spawnManagedProcess("fixture", [], {});
  const output: Buffer[] = [];
  managed.stderr.on("data", (chunk: Buffer) => output.push(chunk));
  return {
    managed,
    rawStderr,
    async finish() {
      const ended = once(managed.stderr, "end");
      rawStderr.end();
      await ended;
      Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      return Buffer.concat(output);
    },
  };
}

describe.skipIf(process.platform !== "win32")(
  "managed supervisor proof consumption",
  () => {
    it.each(["\n", "\r\n"])(
      "consumes only the expected proof line at every chunk split with %j framing",
      async (newline) => {
        const framed = Buffer.from(`${proof}${newline}`);
        const before = Buffer.from("diagnostic before\r\n");
        const after = Buffer.from("diagnostic after\nunterminated diagnostic");
        for (let split = 0; split <= framed.length; split++) {
          const fixture = supervisor();
          fixture.rawStderr.write(Buffer.concat([before, framed.subarray(0, split)]));
          fixture.rawStderr.write(Buffer.concat([framed.subarray(split), after]));
          expect(await fixture.finish()).toEqual(Buffer.concat([before, after]));
          await expect(stopProcessTree(fixture.managed, true)).resolves.toBeUndefined();
        }
      },
    );

    it("preserves legitimate UTF-8 bytes, long lines and lookalike tokens while consuming multiple exact lines", async () => {
      const fixture = supervisor();
      const before = Buffer.from(
        `utf8: \u4f60\u597d\nfleet-process-tree-quiesced:unrelated-token\n${"x".repeat(32_768)}\n`,
      );
      const after = Buffer.from(`prefix ${proof}\n${proof} suffix\n${proof}\rX\n`);
      const bytes = Buffer.concat([before, Buffer.from(`${proof}\n${proof}\r\n`), after]);
      for (const byte of bytes) fixture.rawStderr.write(Buffer.from([byte]));
      expect(await fixture.finish()).toEqual(Buffer.concat([before, after]));
      await expect(stopProcessTree(fixture.managed, true)).resolves.toBeUndefined();
    });

    it.each([
      proof,
      `${proof}\r`,
      `${proof.slice(0, -1)}\n`,
      `${proof} suffix\n`,
      `prefix ${proof}\n`,
      ` ${proof}\n`,
      `${proof}\r\r\n`,
      "fleet-process-tree-quiesced:another-token\n",
    ])("does not hide or accept an inexact or incomplete proof: %j", async (text) => {
      const fixture = supervisor();
      fixture.rawStderr.write(text);
      expect((await fixture.finish()).toString()).toBe(text);
      await expect(stopProcessTree(fixture.managed, true)).rejects.toThrow(
        "reconciliation is required",
      );
    });
  },
);
