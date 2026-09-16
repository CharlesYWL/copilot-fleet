import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import process from "node:process";
import { setInterval, clearInterval } from "node:timers";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { HostToNodeMessageSchema, NodeToHostMessageSchema } from "@fleet/protocol";
import { buildServer } from "../apps/host/src/server.ts";
import { FleetStore } from "../apps/host/src/store.ts";
import { ManagedWorktrees } from "../apps/node/src/managed-worktrees.ts";
import { CheckoutLocks } from "../apps/node/src/checkout-locks.ts";
import { CommandRouter } from "../apps/node/src/router.ts";
import { GitRunner } from "../apps/node/src/git-runner.ts";

const cleanup = [];
const fetch = globalThis.fetch;
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const git = new GitRunner();
const gate = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
};

async function localFleet(capable = true) {
  const root = resolve(".mwi-test-work", randomUUID());
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await git.run(source, ["init", "-b", "target"]);
  await git.run(source, ["config", "user.name", "Fleet Smoke"]);
  await git.run(source, ["config", "user.email", "fleet-smoke@example.invalid"]);
  await git.run(source, ["config", "commit.gpgSign", "false"]);
  await git.run(source, ["config", "core.autocrlf", "false"]);
  await writeFile(join(source, "same.txt"), "base\n");
  await git.run(source, ["add", "."]);
  await git.run(source, ["commit", "-m", "base"]);
  const remote = join(root, "remote.git");
  await git.run(root, ["init", "--bare", remote]);
  await git.run(source, ["remote", "add", "origin", remote]);
  await git.run(source, ["push", "origin", "target"]);
  const app = await buildServer({
    databasePath: join(root, "host.db"),
    enrollmentToken: "smoke-token",
    operatorPassword: "smoke-password",
    announceClaimCode() {},
  });
  app.log.level = "silent";
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  let cookie = "",
    csrf = "";
  const request = async (path, method = "GET", body) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        cookie,
        "x-csrf-token": csrf,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
      headers: response.headers,
    };
  };
  const login = await request("/api/auth/login", "POST", { password: "smoke-password" });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  csrf = (await request("/api/auth/csrf")).body.csrfToken;
  const capabilities = [
    "copilot-acp",
    "host-yolo",
    ...(capable ? ["managed-worktrees-v1"] : []),
  ];
  const enrollment = await request("/api/nodes/register", "POST", {
    name: "Windows Git smoke",
    os: process.platform,
    arch: process.arch,
    version: "test",
    capabilities,
    maxSessions: 8,
    enrollmentToken: "smoke-token",
  });
  expect(enrollment.status).toBe(201);
  const { nodeId, secret } = enrollment.body;
  const frames = [];
  const failures = [];
  const entered = new Set();
  const reviewed = new Set();
  const starts = new Map();
  const release = gate();
  let maximum = 0,
    active = 0;
  const client = new WebSocket(`${url.replace("http:", "ws:")}/ws/node`);
  const send = (value) => {
    if (client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify(NodeToHostMessageSchema.parse(value)));
  };
  const manager = new ManagedWorktrees({
    directory: join(root, "node"),
    nodeId: () => nodeId,
    locks: new CheckoutLocks(join(root, "locks")),
    quiesce: (id, target) => router.quiesceWorktree(id, target),
  });
  const factory = {
    async start(id, cwd, sink, options = {}) {
      starts.set(id, (starts.get(id) ?? 0) + 1);
      let sequence = options.sequenceOffset ?? 0;
      let busy = false,
        stopped = false,
        pending = Promise.resolve();
      const emit = (type, payload) =>
        sink({
          eventId: randomUUID(),
          sessionId: id,
          sequence: ++sequence,
          type,
          payload,
          createdAt: new Date().toISOString(),
        });
      emit("state", { state: "starting", activity: "Fixture process starting" });
      emit("agent_session", {
        agentSessionId: options.resumeAgentSessionId ?? `conversation-${id}`,
      });
      if (options.resumeAgentSessionId)
        emit("state", { state: "idle", activity: "Conversation loaded" });
      return {
        get busy() {
          return busy;
        },
        prompt(rawText) {
          const text = rawText.split("\n")[0];
          busy = true;
          emit("state", { state: "running", activity: "Fixture working" });
          pending = (async () => {
            if (text.startsWith("implement-")) {
              active += 1;
              maximum = Math.max(maximum, active);
              entered.add(cwd);
              await release.promise;
              await writeFile(join(cwd, "same.txt"), `${text}\n`);
              await git.run(cwd, ["commit", "-am", text]);
              active -= 1;
            } else {
              expect(await readFile(join(cwd, "same.txt"), "utf8")).toContain(
                "implement-",
              );
              reviewed.add(cwd);
            }
            emit("agent_text", { text: `Verified ${text}` });
            emit("turn_complete", { stopReason: "end_turn" });
            busy = false;
            emit("state", { state: "idle", activity: "Ready for follow-up" });
          })().catch((error) => {
            failures.push(error);
            busy = false;
            emit("state", { state: "failed", activity: error.message });
          });
          return pending;
        },
        async stop(announce = true) {
          if (stopped) return;
          stopped = true;
          await pending;
          if (announce)
            emit("state", { state: "stopped", activity: "Fixture process quiesced" });
        },
        async cancel() {},
        async setConfigOption() {},
        resolvePermission() {},
        denyPendingPermissions() {},
        resync() {
          emit("state", {
            state: busy ? "running" : "idle",
            activity: "Reattached existing process",
          });
        },
      };
    },
  };
  const router = new CommandRouter(
    factory,
    8,
    (event) => send({ type: "event", event }),
    undefined,
    undefined,
    undefined,
    undefined,
    { worktrees: manager },
  );
  const welcomed = gate();
  client.on("message", (raw) => {
    const frame = HostToNodeMessageSchema.parse(JSON.parse(String(raw)));
    frames.push(frame);
    if (frame.type === "welcome") welcomed.release();
    if (frame.type === "managed_worktree") {
      void manager
        .execute(frame.request)
        .then((result) => send({ type: "managed_worktree_result", result }))
        .catch((error) => failures.push(error));
    } else if (frame.type === "command") {
      void router
        .route(frame.command)
        .then((result) =>
          send({
            type: "command_result",
            ...result,
            sessionId: frame.command.sessionId,
          }),
        )
        .catch((error) => failures.push(error));
    }
  });
  await once(client, "open");
  send({
    type: "hello",
    nodeId,
    secret,
    os: process.platform,
    arch: process.arch,
    version: "test",
    capabilities,
    maxSessions: 8,
    homeDir: root,
    activeSessionIds: [],
    busySessionIds: [],
  });
  await welcomed.promise;
  const heartbeat = setInterval(
    () =>
      send({
        type: "heartbeat",
        activeSessionIds: router.activeSessionIds,
        busySessionIds: router.busySessionIds,
        sentAt: new Date().toISOString(),
      }),
    1_000,
  );
  cleanup.push(async () => {
    release.release();
    await router.stopAll();
    await manager.shutdown();
    clearInterval(heartbeat);
    const closed = once(client, "close");
    client.close();
    await closed;
  });
  const workspace = (
    await request("/api/workspaces", "POST", {
      name: "smoke-repository",
      description: "",
    })
  ).body;
  const placement = (
    await request("/api/placements", "POST", {
      workspaceId: workspace.id,
      nodeId,
      localPath: source,
    })
  ).body;
  const create = async (name, workspaceMode = "auto") =>
    request("/api/runs", "POST", {
      operationId: randomUUID(),
      workspaceId: workspace.id,
      sourcePlacementId: placement.id,
      name,
      objective: name,
      workspaceMode,
      policy: { wakePolicy: "none", maxParallel: 4 },
    });
  const state = async (id) => (await request(`/api/runs/${id}/worktree`)).body;
  const action = async (id, name, body = {}) => {
    const current = await state(id);
    return request(`/api/runs/${id}/worktree/${name}`, "POST", {
      operationId: randomUUID(),
      expectedVersion: current.version,
      ...body,
    });
  };
  return {
    root,
    url,
    source,
    request,
    create,
    state,
    action,
    frames,
    failures,
    entered,
    reviewed,
    release: release.release,
    maximum: () => maximum,
    workspace,
    placement,
    cookie,
    router,
    manager,
    starts,
  };
}

describe(
  "managed orchestration local HTTP/WebSocket/Git smoke",
  { timeout: 120_000 },
  () => {
    it("quiesces the managed Node slot after automatic integration completes", async () => {
      const fleet = await localFleet();
      const run = (await fleet.create("reattach", "managed")).body;
      expect(
        (
          await fleet.request(`/api/runs/${run.id}/plan`, "POST", {
            steps: [
              {
                stepKey: "implement",
                title: "implement-reattach",
                prompt: "implement-reattach",
                category: "implement",
              },
            ],
          })
        ).status,
      ).toBe(200);
      expect(
        (await fleet.request(`/api/runs/${run.id}/approve`, "POST", {})).status,
      ).toBe(200);
      await expect
        .poll(
          () => {
            if (fleet.failures.length) throw fleet.failures[0];
            return fleet.entered.size;
          },
          { timeout: 30_000 },
        )
        .toBe(1);
      fleet.release();
      await expect
        .poll(
          async () => {
            const current = (await fleet.request(`/api/runs/${run.id}`)).body.run;
            return (
              current.workspaceBinding.aggregationPhase === "await_publish_approval" ||
              current.state === "completed"
            );
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      const current = (await fleet.request(`/api/runs/${run.id}`)).body.run;
      if (current.workspaceBinding.aggregationPhase === "await_publish_approval")
        expect((await fleet.action(run.id, "publish-branch")).status).toBe(200);
      await expect
        .poll(async () => (await fleet.request(`/api/runs/${run.id}`)).body.run.state, {
          timeout: 120_000,
        })
        .toBe("completed");
      const store = new FleetStore(join(fleet.root, "host.db"));
      try {
        const session = store.listSessions().find((entry) => entry.runId === run.id);
        expect(fleet.router.activeSessionIds).not.toContain(session.id);
        expect(fleet.starts.get(session.id)).toBe(1);
        expect(fleet.manager.locks.holder(session.executionBinding.checkoutKey)).toBe(
          undefined,
        );
        expect(fleet.failures).toEqual([]);
      } finally {
        store.close();
      }
    });

    it("isolates two concurrent tasks, hands off shared review state, persists conflict/abort, and safely cleans up", async () => {
      const fleet = await localFleet();
      expect((await fetch(`${fleet.url}/api/health`)).status).toBe(200);
      expect((await fetch(`${fleet.url}/`)).status).toBe(200);
      const legacy = (await fleet.create("default off")).body;
      expect(legacy.workspaceBinding.effectiveMode).toBe("legacy");
      expect(
        fleet.frames.filter((frame) => frame.type === "managed_worktree"),
      ).toHaveLength(0);
      const settings = await fleet.request("/api/defaults", "POST", {
        operationId: randomUUID(),
        expectedRevision: 0,
        managedWorktreesEnabled: true,
        managedWorktreePolicy: { freeSpaceFloorBytes: 0 },
      });
      expect(settings.status).toBe(200);
      const a = (await fleet.create("task A")).body;
      const b = (await fleet.create("task B")).body;
      expect(a.workspaceBinding.initialization).toBe("reserved");
      expect(b.workspaceBinding.baseSha).toBe(a.workspaceBinding.baseSha);
      for (const [run, name] of [
        [a, "A"],
        [b, "B"],
      ]) {
        expect(
          (
            await fleet.request(`/api/runs/${run.id}/plan`, "POST", {
              steps: [
                {
                  stepKey: "implement",
                  title: `implement-${name}`,
                  prompt: `implement-${name}`,
                  category: "implement",
                },
                {
                  stepKey: "review",
                  title: `review-${name}`,
                  prompt: `review-${name}`,
                  category: "review-deep",
                  dependsOn: ["implement"],
                },
              ],
            })
          ).status,
        ).toBe(200);
        expect(
          (await fleet.request(`/api/runs/${run.id}/approve`, "POST", {})).status,
        ).toBe(200);
      }
      await expect
        .poll(
          () => {
            if (fleet.failures.length) throw fleet.failures[0];
            return fleet.entered.size;
          },
          { timeout: 30_000 },
        )
        .toBe(2);
      expect(fleet.maximum()).toBe(2);
      fleet.release();
      await expect.poll(() => fleet.reviewed.size, { timeout: 90_000 }).toBe(2);
      for (const run of [a, b]) {
        await expect
          .poll(
            async () =>
              (await fleet.request(`/api/runs/${run.id}`)).body.run.workspaceBinding
                .aggregationPhase,
            { timeout: 60_000 },
          )
          .toBe("await_publish_approval");
        expect((await fleet.action(run.id, "publish-branch")).status).toBe(200);
      }
      await expect
        .poll(async () => (await fleet.request(`/api/runs/${a.id}`)).body.run.state, {
          timeout: 60_000,
        })
        .toBe("completed");
      const aState = await fleet.state(a.id),
        bState = await fleet.state(b.id);
      expect(aState.worktree.path).not.toBe(bState.worktree.path);
      expect(
        aState.sessions.every(
          (session) => session.binding.worktreeId && session.binding.cwd !== fleet.source,
        ),
      ).toBe(true);
      expect(
        bState.sessions.every(
          (session) => session.binding.worktreeId && session.binding.cwd !== fleet.source,
        ),
      ).toBe(true);
      expect(await readFile(join(fleet.source, "same.txt"), "utf8")).toBe("base\n");
      const unauthorized = await fetch(`${fleet.url}/api/runs/${a.id}/worktree/cleanup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);
      const noCsrf = await fetch(`${fleet.url}/api/runs/${a.id}/worktree/cleanup`, {
        method: "POST",
        headers: { cookie: fleet.cookie, "content-type": "application/json" },
        body: "{}",
      });
      expect(noCsrf.status).toBe(403);
      expect(
        (await fleet.action(a.id, "cleanup", { expectedVersion: 0 })).body.code,
      ).toBe("stale_revision");
      expect(aState.worktree.state).toBe("removed");
      expect(bState.worktree.state).toBe("removed");
      expect(
        (await git.run(fleet.source, ["ls-remote", "--heads", "origin"])).stdout,
      ).toContain(a.workspaceBinding.integrationTargetRef.replace("refs/heads/", ""));
      expect(fleet.failures).toEqual([]);
    });

    it("keeps explicit managed tasks blocked on old Nodes and persists idempotent mode creation/settings", async () => {
      const fleet = await localFleet(false);
      const body = {
        operationId: randomUUID(),
        workspaceId: fleet.workspace.id,
        sourcePlacementId: fleet.placement.id,
        name: "compatibility",
        objective: "blocked, not downgraded",
        workspaceMode: "managed",
      };
      const first = await fleet.request("/api/runs", "POST", body);
      expect(first.status).toBe(201);
      expect(first.body.workspaceBinding).toMatchObject({
        effectiveMode: "managed",
        initialization: "blocked",
        setupState: "failed",
      });
      expect(first.body.state).toBe("blocked");
      expect(first.body.workspaceBinding.error).toContain("managed-worktrees-v1");
      const notificationPage = await fleet.request("/api/notifications");
      expect(notificationPage.body.unreadCount).toBe(1);
      expect(notificationPage.body.notifications).toHaveLength(1);
      expect(notificationPage.body.notifications[0]).toMatchObject({
        severity: "error",
        navigation: { type: "run", runId: first.body.id },
        status: "active",
      });
      expect(JSON.stringify(notificationPage.body.notifications[0])).not.toContain(
        fleet.source,
      );
      const duplicate = await fleet.request("/api/runs", "POST", body);
      expect(duplicate.body.id).toBe(first.body.id);
      expect((await fleet.request("/api/notifications")).body.notifications).toHaveLength(
        1,
      );
      expect(
        (
          await fleet.request("/api/runs", "POST", {
            ...body,
            operationId: randomUUID(),
            sourcePlacementId: undefined,
          })
        ).body.code,
      ).toBe("source_required");
      expect(
        (await fleet.request("/api/runs", "POST", { ...body, objective: "different" }))
          .body.code,
      ).toBe("idempotency_mismatch");
      expect(
        fleet.frames.filter((frame) => frame.type === "managed_worktree"),
      ).toHaveLength(0);
      const update = {
        operationId: randomUUID(),
        expectedRevision: 0,
        managedWorktreesEnabled: true,
      };
      expect(
        (await fleet.request("/api/defaults", "POST", update)).body
          .managedWorktreesRevision,
      ).toBe(1);
      expect(
        (await fleet.request("/api/defaults", "POST", update)).body
          .managedWorktreesRevision,
      ).toBe(1);
      expect(
        (
          await fleet.request("/api/defaults", "POST", {
            ...update,
            operationId: randomUUID(),
          })
        ).body.code,
      ).toBe("stale_revision");
      expect(
        (await fleet.create("explicit legacy", "legacy")).body.workspaceBinding
          .effectiveMode,
      ).toBe("legacy");
    });
  },
);
