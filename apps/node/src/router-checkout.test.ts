import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeCommandSchema, type SessionEvent } from "@fleet/protocol";
import { CommandRouter } from "./router.js";
import { MockAgentFactory, type AgentFactory } from "./agents.js";
import { RepositoryParticipation } from "./repository-participation.js";

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

  it("counts an approved read-only session's maintenance turn as a writer without changing later direct turns", async () => {
    const { dir, head } = repository();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let busy = false;
    const prompt = vi.fn(async (text: string) => {
      if (text !== "approved maintenance") return;
      busy = true;
      try {
        await gate;
      } finally {
        busy = false;
      }
    });
    const factory: AgentFactory = {
      async start() {
        return {
          prompt,
          async cancel() {},
          async stop() {
            finish();
          },
          resolvePermission() {},
          denyPendingPermissions() {},
          async setConfigOption() {},
          get busy() {
            return busy;
          },
          resync() {},
        };
      },
    };
    const router = new CommandRouter(
      factory,
      1,
      () => {},
      async (path) => path,
    );
    const start = (commandId: string, sessionId: string, readOnly: boolean) =>
      router.route(
        NodeCommandSchema.parse({
          type: "start_session",
          commandId,
          sessionId,
          readOnly,
          localPath: dir,
          prompt: "historical read-only work",
        }),
      );
    try {
      expect((await start("reader", "retained", true)).ok).toBe(true);
      const maintenance = await router.route(
        NodeCommandSchema.parse({
          type: "prompt",
          commandId: "maintenance",
          sessionId: "retained",
          prompt: "approved maintenance",
          checkoutPrecondition: { headSha: head, requireClean: true },
        }),
      );
      expect(maintenance.ok, maintenance.error).toBe(true);
      await waitFor(() => busy);
      const competing = await start("competing", "writer", false);
      expect(competing).toMatchObject({
        ok: false,
        error: expect.stringContaining("capacity for writing"),
      });
      const competingReader = await start("competing-reader", "another-reader", true);
      expect(competingReader).toMatchObject({
        ok: false,
        error: expect.stringContaining("capacity for read-only"),
      });
      finish();
      await waitFor(() => !busy);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await start("after-maintenance", "later-writer", false)).ok).toBe(true);
      const direct = await router.route(
        NodeCommandSchema.parse({
          type: "prompt",
          commandId: "direct",
          sessionId: "retained",
          prompt: "read-only follow-up",
        }),
      );
      expect(direct.ok, direct.error).toBe(true);
    } finally {
      finish();
      await router.stopAll();
    }
  }, 60_000);

  it("refuses maintenance on a retained reader when normal writer capacity is already occupied", async () => {
    const { dir, head } = repository();
    const factory = new MockAgentFactory();
    const router = new CommandRouter(
      factory,
      1,
      () => {},
      async (path) => path,
    );
    const start = async (sessionId: string, readOnly: boolean) => {
      const result = await router.route(
        NodeCommandSchema.parse({
          type: "start_session",
          commandId: `start-${sessionId}`,
          sessionId,
          localPath: dir,
          prompt: "original turn",
          readOnly,
        }),
      );
      expect(result.ok, result.error).toBe(true);
      await waitFor(() => !router.sessionTurnActive(sessionId));
    };
    try {
      await start("writer", false);
      await start("reader", true);
      const result = await router.route(
        NodeCommandSchema.parse({
          type: "prompt",
          commandId: "blocked-maintenance",
          sessionId: "reader",
          prompt: "approved maintenance",
          checkoutPrecondition: { headSha: head, requireClean: true },
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        fatal: false,
        error: expect.stringContaining("capacity for writing"),
      });
      expect(router.activeSessionIds).toContain("reader");
    } finally {
      await router.stopAll();
    }
  }, 60_000);

  it("revalidates the real retained repository lease before invoking a maintenance tool turn", async () => {
    const { dir, head } = repository();
    const repositories = new RepositoryParticipation();
    const participation = vi.spyOn(repositories, "participate");
    const factory = new MockAgentFactory();
    const started = vi.spyOn(factory, "start");
    const router = new CommandRouter(
      factory,
      1,
      () => {},
      async (path) => path,
      undefined,
      undefined,
      undefined,
      { repositories },
    );
    let lease:
      | Awaited<ReturnType<RepositoryParticipation["participate"]>>["leases"][number]
      | undefined;
    try {
      const result = await router.route(
        NodeCommandSchema.parse({
          type: "start_session",
          commandId: "reader-start",
          sessionId: "reader",
          localPath: dir,
          prompt: "historical review",
          readOnly: true,
        }),
      );
      expect(result.ok, result.error).toBe(true);
      await waitFor(() => !router.sessionTurnActive("reader"));
      const agent = await started.mock.results[0]!.value;
      const prompt = vi.spyOn(agent, "prompt");
      const retained: Awaited<ReturnType<RepositoryParticipation["participate"]>> =
        await participation.mock.results[0]!.value;
      const retainedLease = retained.leases[0];
      if (!retainedLease) throw new Error("The retained repository lease is missing.");
      lease = retainedLease;
      retainedLease.requireReconciliation("A previous checkout effect is unknown.");
      const refused = await router.route(
        NodeCommandSchema.parse({
          type: "prompt",
          commandId: "unknown-lease",
          sessionId: "reader",
          prompt: "approved maintenance",
          checkoutPrecondition: { headSha: head, requireClean: true },
        }),
      );
      expect(refused).toMatchObject({
        ok: false,
        fatal: false,
        error: expect.stringContaining("previous checkout effect is unknown"),
      });
      expect(prompt).not.toHaveBeenCalled();
      // The fixture uses an in-process mock agent, so no OS process remains.
      retainedLease.processesQuiesced();
      const accepted = await router.route(
        NodeCommandSchema.parse({
          type: "prompt",
          commandId: "reconciled-lease",
          sessionId: "reader",
          prompt: "approved maintenance",
          checkoutPrecondition: { headSha: head, requireClean: true },
        }),
      );
      expect(accepted.ok, accepted.error).toBe(true);
      expect(prompt).toHaveBeenCalledWith("approved maintenance", []);
      await waitFor(() => !router.sessionTurnActive("reader"));
    } finally {
      lease?.processesQuiesced();
      await router.stopAll();
    }
  }, 60_000);
});
