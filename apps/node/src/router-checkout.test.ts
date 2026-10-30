import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeCommandSchema, type SessionEvent } from "@fleet/protocol";
import { CommandRouter } from "./router.js";
import { MockAgentFactory } from "./agents.js";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the session");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A PR maintenance prompt is sent only onto a clean checkout at exactly the
 * head its batch was prepared from; direct prompts never carry the check.
 */
describe("CommandRouter maintenance checkout precondition", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const repository = () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-checkout-"));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "file.txt"), "one\n");
    git("add", "file.txt");
    git("commit", "-q", "-m", "init");
    return { dir, head: git("rev-parse", "HEAD") };
  };

  it("refuses a maintenance prompt on a dirty checkout or another head, and admits it on the exact clean head", async () => {
    const { dir, head } = repository();
    const events: SessionEvent[] = [];
    const router = new CommandRouter(
      new MockAgentFactory(),
      1,
      (event) => events.push(event),
      async (path) => path,
    );
    const idleCount = () =>
      events.filter(
        (event) =>
          event.sessionId === "s1" &&
          event.type === "state" &&
          event.payload.state === "idle",
      ).length;
    try {
      const started = await router.route(
        NodeCommandSchema.parse({
          type: "start_session",
          commandId: "start",
          sessionId: "s1",
          localPath: dir,
          prompt: "hello",
          yolo: false,
          mcpServers: [],
        }),
      );
      expect(started.ok, started.error).toBe(true);
      await waitFor(() => idleCount() >= 1);
      const prompt = (commandId: string, headSha?: string) =>
        router.route(
          NodeCommandSchema.parse({
            type: "prompt",
            commandId,
            sessionId: "s1",
            prompt: "Maintenance work order.",
            ...(headSha ? { checkoutPrecondition: { headSha, requireClean: true } } : {}),
          }),
        );

      const wrongHead = await prompt("wrong-head", "d".repeat(40));
      expect(wrongHead).toMatchObject({
        ok: false,
        fatal: false,
        refusal: "checkout_precondition",
        error: expect.stringContaining(`not the PR head ${"d".repeat(40)}`),
      });

      writeFileSync(join(dir, "file.txt"), "a person's edit\n");
      const dirty = await prompt("dirty", head);
      expect(dirty).toMatchObject({
        ok: false,
        fatal: false,
        refusal: "checkout_precondition",
        error: expect.stringContaining("uncommitted changes"),
      });

      // A direct prompt never carries the precondition and is unaffected.
      const before = idleCount();
      const direct = await prompt("direct");
      expect(direct.ok, direct.error).toBe(true);
      expect(direct).not.toHaveProperty("refusal");
      await waitFor(() => idleCount() > before);

      writeFileSync(join(dir, "file.txt"), "one\n");
      const clean = await prompt("clean", head);
      expect(clean.ok, clean.error).toBe(true);
    } finally {
      await router.stopAll();
    }
    // Several real git processes; a loaded machine needs more than the default.
  }, 60_000);
});
