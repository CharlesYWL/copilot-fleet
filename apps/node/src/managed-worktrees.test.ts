import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NodeCommandSchema,
  WorktreeOperationRequestSchema,
  type ExecutionBinding,
  type ManagedWorktree,
  type SessionEvent,
  type WorktreeOperationRequest,
} from "@fleet/protocol";
import { AcpAgentFactory, type AgentFactory, type SessionAgent } from "./agents.js";
import * as copilotLaunch from "./copilot-launch.js";
import * as processQuiescence from "./process-quiescence.js";
import * as windowsJob from "./windows-process-job.js";
import { canonicalPath } from "./canonical-path.js";
import { CheckoutLocks } from "./checkout-locks.js";
import { GitRunner, parseWorktreeRegistry } from "./git-runner.js";
import { ManagedWorktrees, WorktreeCrash } from "./managed-worktrees.js";
import { CommandRouter } from "./router.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

const roots: string[] = [];
const managers: ManagedWorktrees[] = [];
const routers: CommandRouter[] = [];
const releases: (() => void)[] = [];
const git = new GitRunner();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of releases.splice(0)) release();
  for (const router of routers.splice(0)) await router.stopAll();
  for (const manager of managers.splice(0)) manager.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(
  checkpoint?: ConstructorParameters<typeof ManagedWorktrees>[0]["checkpoint"],
  overrides: Partial<ConstructorParameters<typeof ManagedWorktrees>[0]> = {},
) {
  const root = resolve(".mwi-test-work", randomUUID());
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await git.run(source, ["init", "-b", "target"]);
  await git.run(source, ["config", "user.name", "Fleet Test"]);
  await git.run(source, ["config", "user.email", "fleet-test@example.invalid"]);
  await git.run(source, ["config", "commit.gpgSign", "false"]);
  await git.run(source, ["config", "core.autocrlf", "false"]);
  await writeFile(join(source, "same.txt"), "base\n");
  await writeFile(join(source, ".gitignore"), "ignored.txt\n");
  await git.run(source, ["add", "."]);
  await git.run(source, ["commit", "-m", "base"]);
  const manager = new ManagedWorktrees({
    directory: join(root, "state"),
    nodeId: () => "node-1",
    locks: new CheckoutLocks(join(root, "locks")),
    ...(checkpoint ? { checkpoint } : {}),
    ...overrides,
  });
  managers.push(manager);
  return { root, source, manager };
}

function reserveRequest(
  source: string,
  runId: string = randomUUID(),
): WorktreeOperationRequest {
  return WorktreeOperationRequestSchema.parse({
    operationId: randomUUID(),
    kind: "reserve",
    runId,
    worktreeId: `worktree-${runId}`,
    sourcePath: source,
    sourcePlacementId: "placement-1",
    workspaceId: "workspace-1",
    nodeId: "node-1",
    hostInstallationId: "host-1",
    generation: 1,
    expectedVersion: 0,
    actor: "test",
    policy: { freeSpaceFloorBytes: 0 },
  });
}

async function operation(
  manager: ManagedWorktrees,
  tree: ManagedWorktree,
  kind: WorktreeOperationRequest["kind"],
  extra: Record<string, unknown> = {},
) {
  return manager.execute(
    WorktreeOperationRequestSchema.parse({
      ...reserveRequest(tree.repository.path, tree.runId),
      kind,
      worktreeId: tree.id,
      generation: tree.generation,
      expectedVersion: manager.get(tree.id)!.version,
      expectedPath: tree.path,
      expectedBranchRef: tree.branchRef,
      expectedBaseSha: tree.baseSha,
      ...extra,
    }),
  );
}

async function allocate(
  manager: ManagedWorktrees,
  source: string,
  extra: Partial<WorktreeOperationRequest> = {},
): Promise<ManagedWorktree> {
  const reserved = await manager.execute(
    WorktreeOperationRequestSchema.parse({
      ...reserveRequest(source),
      ...extra,
    }),
  );
  expect(reserved.error).toBe("");
  expect(reserved.ok).toBe(true);
  const created = await operation(manager, reserved.worktree!, "create");
  expect(created.error).toBe("");
  expect(created.ok).toBe(true);
  return created.worktree!;
}

function binding(tree: ManagedWorktree, leaseAttempt: string): ExecutionBinding {
  return {
    worktreeId: tree.id,
    generation: tree.generation,
    sourcePlacementId: tree.sourcePlacementId,
    cwd: tree.path,
    checkoutKey: tree.checkout!.key,
    accessClass: "shell",
    leaseAttempt,
    quarantined: false,
  };
}

function launch(id: string, tree: ManagedWorktree) {
  return NodeCommandSchema.parse({
    type: "start_session",
    sessionId: id,
    commandId: randomUUID(),
    localPath: tree.path,
    executionBinding: binding(tree, `lease-${id}`),
    prompt: id,
  });
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}

function factory(work: (cwd: string, text: string) => Promise<void>): AgentFactory {
  return {
    async start(_id, cwd): Promise<SessionAgent> {
      let busy = false;
      let pending = Promise.resolve();
      return {
        get busy() {
          return busy;
        },
        prompt(text) {
          busy = true;
          pending = work(cwd, text).finally(() => {
            busy = false;
          });
          return pending;
        },
        async stop() {
          await pending;
        },
        async cancel() {},
        async setConfigOption() {},
        resync() {},
        resolvePermission() {},
        denyPendingPermissions() {},
      };
    },
  };
}

async function liveAcpFixture(managed = true) {
  const { root, source, manager } = await fixture();
  const tree = await allocate(manager, source);
  vi.spyOn(copilotLaunch, "resolveCopilotLaunch").mockResolvedValue({
    command: process.execPath,
    args: [resolve("apps", "node", "src", "fixtures", "managed-acp.mjs")],
    provider: "copilot",
  });
  const events: SessionEvent[] = [];
  const workers = new AcpAgentFactory(60_000, process.execPath);
  const start = vi.spyOn(workers, "start");
  const acquire = vi.spyOn(manager.locks, "acquire");
  const router = new CommandRouter(
    workers,
    1,
    (event) => events.push(event),
    undefined,
    undefined,
    undefined,
    undefined,
    { worktrees: manager },
  );
  routers.push(router);
  const initial = binding(tree, "lease-live");
  expect(
    await router.route(
      NodeCommandSchema.parse({
        ...launch("live", tree),
        executionBinding: managed ? initial : undefined,
        localPath: managed ? tree.path : source,
      }),
    ),
  ).toMatchObject({ ok: true });
  await expect.poll(() => router.busySessionIds).toEqual([]);
  const agent = await start.mock.results[0]!.value;
  const stop = vi.spyOn(agent, "stop");
  const resync = vi.spyOn(agent, "resync");
  const prompt = (executionBinding: ExecutionBinding, text = "follow-up") =>
    router.route(
      NodeCommandSchema.parse({
        type: "prompt",
        sessionId: "live",
        commandId: randomUUID(),
        executionBinding: managed ? executionBinding : undefined,
        prompt: text,
      }),
    );
  const resume = (executionBinding: ExecutionBinding, extra = {}) =>
    router.route(
      NodeCommandSchema.parse({
        type: "resume_session",
        sessionId: "live",
        commandId: randomUUID(),
        agentSessionId: events.find((event) => event.type === "agent_session")!.payload
          .agentSessionId,
        localPath: initial.cwd,
        executionBinding,
        ...extra,
      }),
    );
  return {
    root,
    source,
    manager,
    tree,
    events,
    router,
    agent,
    initial,
    start,
    stop,
    resync,
    acquire,
    prompt,
    resume,
    inventory: new CheckoutLocks(join(root, "locks")),
  };
}

describe("real Git managed task worktrees", { timeout: 60_000 }, () => {
  it("finalizes an unchanged workspace with ignored output without uploading repository history", async () => {
    const uploadArtifact = vi.fn();
    const { source, manager } = await fixture(undefined, { uploadArtifact });
    const reserved = await manager.execute(
      WorktreeOperationRequestSchema.parse({
        ...reserveRequest(source),
        workspaceKind: "step",
        ownerStepId: "reader",
      }),
    );
    const created = await operation(manager, reserved.worktree!, "create", {
      workspaceKind: "step",
      ownerStepId: "reader",
    });
    await writeFile(join(created.worktree!.path, "ignored.txt"), "generated\n");
    await writeFile(join(source, "source-advanced.txt"), "later\n");
    await git.run(source, ["add", "source-advanced.txt"]);
    await git.run(source, ["commit", "-m", "advance source"]);

    const finalized = await operation(manager, created.worktree!, "finalize", {
      workspaceKind: "step",
      ownerStepId: "reader",
    });

    expect(finalized.ok).toBe(true);
    expect(finalized.worktree?.resultSha).toBe(finalized.worktree?.baseSha);
    expect(finalized.workspaceResult).toBeUndefined();
    expect(uploadArtifact).not.toHaveBeenCalled();
    await expect(
      readFile(join(created.worktree!.path, "ignored.txt"), "utf8"),
    ).resolves.toBe("generated\n");
  });

  it("moves a sealed result between node-local repositories without changing remotes", async () => {
    const root = resolve(".mwi-test-work", randomUUID());
    roots.push(root);
    const sourceA = join(root, "source-a");
    const sourceB = join(root, "source-b");
    await mkdir(sourceA, { recursive: true });
    await git.run(sourceA, ["init", "-b", "target"]);
    await git.run(sourceA, ["config", "user.name", "Fleet Test"]);
    await git.run(sourceA, ["config", "user.email", "fleet-test@example.invalid"]);
    await writeFile(join(sourceA, "base.txt"), "base\n");
    await git.run(sourceA, ["add", "."]);
    await git.run(sourceA, ["commit", "-m", "base"]);
    await git.run(root, ["clone", "--no-hardlinks", sourceA, sourceB]);
    await git.run(sourceB, ["config", "user.name", "Fleet Test"]);
    await git.run(sourceB, ["config", "user.email", "fleet-test@example.invalid"]);
    const baseSha = (await git.run(sourceA, ["rev-parse", "HEAD"])).stdout.trim();
    let artifact = Buffer.alloc(0);
    const publisher = new ManagedWorktrees({
      directory: join(root, "state-a"),
      nodeId: () => "node-a",
      locks: new CheckoutLocks(join(root, "locks-a")),
      uploadArtifact: async (result, path) => {
        artifact = await readFile(path);
        return {
          ...result,
          state: "available",
          verifiedAt: new Date().toISOString(),
        };
      },
    });
    managers.push(publisher);
    const reserveA = WorktreeOperationRequestSchema.parse({
      ...reserveRequest(sourceA, "portable-run"),
      worktreeId: "portable-writer",
      sourcePlacementId: "placement-a",
      originatingPlacementId: "placement-a",
      nodeId: "node-a",
      workspaceKind: "step",
      ownerStepId: "writer",
    });
    const reservedA = await publisher.execute(reserveA);
    const createdA = await operation(publisher, reservedA.worktree!, "create", {
      sourcePlacementId: "placement-a",
      originatingPlacementId: "placement-a",
      nodeId: "node-a",
      workspaceKind: "step",
      ownerStepId: "writer",
      repositoryIdentity: reservedA.worktree!.repositoryIdentity,
      repositoryObjectFormat: reservedA.worktree!.repositoryObjectFormat,
    });
    await writeFile(join(createdA.worktree!.path, "portable.txt"), "from node a\n");
    await git.run(createdA.worktree!.path, ["add", "portable.txt"]);
    await git.run(createdA.worktree!.path, ["commit", "-m", "portable"]);
    const finalized = await operation(publisher, createdA.worktree!, "finalize", {
      sourcePlacementId: "placement-a",
      originatingPlacementId: "placement-a",
      nodeId: "node-a",
      workspaceKind: "step",
      ownerStepId: "writer",
      repositoryIdentity: createdA.worktree!.repositoryIdentity,
      repositoryObjectFormat: createdA.worktree!.repositoryObjectFormat,
    });
    expect(finalized.workspaceResult?.state).toBe("available");
    expect(artifact.length).toBeGreaterThan(0);

    const remotesBefore = (await git.run(sourceB, ["remote", "-v"])).stdout;
    const receiver = new ManagedWorktrees({
      directory: join(root, "state-b"),
      nodeId: () => "node-b",
      locks: new CheckoutLocks(join(root, "locks-b")),
      downloadArtifact: async (_result, path) => writeFile(path, artifact),
    });
    managers.push(receiver);
    const result = finalized.workspaceResult!;
    const mismatch = await receiver.probeRepository({
      operationId: randomUUID(),
      runId: "portable-run",
      placementId: "placement-b",
      localPath: sourceB,
      baseSha,
      expectedRepositoryIdentity: "0".repeat(64),
    });
    expect(mismatch).toMatchObject({
      ok: false,
      code: "repository_identity_mismatch",
    });
    const composition = {
      baseSha,
      baseRef: "refs/heads/target",
      predecessors: [
        {
          stepId: "writer",
          stepKey: "writer",
          position: 0,
          worktreeId: "portable-writer",
          resultSha: result.headSha,
          workspaceResultId: result.id,
        },
      ],
      state: "pending" as const,
    };
    const reserveB = WorktreeOperationRequestSchema.parse({
      ...reserveRequest(sourceB, "portable-run"),
      operationId: randomUUID(),
      worktreeId: "portable-derived",
      sourcePlacementId: "placement-b",
      originatingPlacementId: "placement-a",
      nodeId: "node-b",
      expectedBaseSha: baseSha,
      expectedBaseRef: "refs/heads/target",
      repositoryIdentity: result.repositoryIdentity,
      repositoryObjectFormat: result.objectFormat,
      workspaceKind: "derived",
      ownerStepId: "consumer",
      composition,
      workspaceResults: [result],
    });
    const reservedB = await receiver.execute(reserveB);
    expect(reservedB.ok).toBe(true);
    const shared = {
      sourcePlacementId: "placement-b",
      originatingPlacementId: "placement-a",
      nodeId: "node-b",
      expectedBaseRef: "refs/heads/target",
      repositoryIdentity: result.repositoryIdentity,
      repositoryObjectFormat: result.objectFormat,
      workspaceKind: "derived" as const,
      ownerStepId: "consumer",
      composition,
      workspaceResults: [result],
    };
    const createdB = await operation(receiver, reservedB.worktree!, "create", shared);
    const composed = await operation(receiver, createdB.worktree!, "compose", shared);
    expect(composed.error).toBe("");
    expect(composed.ok).toBe(true);
    expect(
      (await readFile(join(composed.worktree!.path, "portable.txt"), "utf8")).trim(),
    ).toBe("from node a");
    expect((await git.run(sourceB, ["remote", "-v"])).stdout).toBe(remotesBefore);
    const importedRef = `refs/fleet/imports/${createHash("sha256")
      .update(`${result.id}:${result.headSha}`)
      .digest("hex")
      .slice(0, 32)}`;
    expect(
      (await git.run(sourceB, ["rev-parse", "--verify", importedRef])).stdout.trim(),
    ).toBe(result.headSha);
    await expect(
      stat(
        join(
          root,
          "state-b",
          "workspace-result-artifacts",
          `${result.artifactId}.bundle`,
        ),
      ),
    ).rejects.toThrow();
    expect((await operation(receiver, composed.worktree!, "cleanup", shared)).ok).toBe(
      true,
    );
    expect(
      (
        await git.run(sourceB, ["rev-parse", "--verify", importedRef], {
          allowedExitCodes: [0, 128],
        })
      ).stdout.trim(),
    ).toBe("");
  });

  it("replays finalization after a crash leaves the private result ref behind", async () => {
    let interruptFinalize = false;
    let uploads = 0;
    const { source, manager } = await fixture(
      (stage, request) => {
        if (interruptFinalize && stage === "git" && request.kind === "finalize") {
          interruptFinalize = false;
          throw new WorktreeCrash("interrupted finalization");
        }
      },
      {
        uploadArtifact: async (result) => {
          uploads += 1;
          return {
            ...result,
            state: "available",
            verifiedAt: new Date().toISOString(),
          };
        },
      },
    );
    const reserved = await manager.execute(
      WorktreeOperationRequestSchema.parse({
        ...reserveRequest(source),
        workspaceKind: "step",
        ownerStepId: "writer",
      }),
    );
    const created = await operation(manager, reserved.worktree!, "create", {
      workspaceKind: "step",
      ownerStepId: "writer",
    });
    const tree = created.worktree!;
    await writeFile(join(tree.path, "portable.txt"), "portable\n");
    await git.run(tree.path, ["add", "portable.txt"]);
    await git.run(tree.path, ["commit", "-m", "portable"]);
    const request = WorktreeOperationRequestSchema.parse({
      ...reserveRequest(source, tree.runId),
      operationId: randomUUID(),
      kind: "finalize",
      worktreeId: tree.id,
      generation: tree.generation,
      expectedVersion: manager.get(tree.id)!.version,
      expectedPath: tree.path,
      expectedBranchRef: tree.branchRef,
      expectedBaseSha: tree.baseSha,
      workspaceKind: "step",
      ownerStepId: "writer",
    });

    interruptFinalize = true;
    await expect(manager.execute(request)).rejects.toThrow(WorktreeCrash);
    expect(
      (
        await git.run(source, [
          "rev-parse",
          "--verify",
          `refs/fleet/results/${tree.taskKey}`,
        ])
      ).stdout.trim(),
    ).toMatch(/^[a-f0-9]{40}$/);

    const replayed = await manager.execute(request);
    expect(replayed.ok, `${replayed.code}: ${replayed.error}`).toBe(true);
    expect(replayed.workspaceResult?.state).toBe("available");
    expect(uploads).toBe(1);
    expect(
      (
        await git.run(
          source,
          ["rev-parse", "--verify", `refs/fleet/results/${tree.taskKey}`],
          { allowedExitCodes: [0, 128] },
        )
      ).stdout.trim(),
    ).toBe("");
  });
  it("composes committed independent step results deterministically into a derived workspace", async () => {
    let interruptComposition = false;
    const { source, manager } = await fixture((stage, request) => {
      if (interruptComposition && stage === "git" && request.kind === "compose") {
        interruptComposition = false;
        throw new WorktreeCrash("interrupted composition");
      }
    });
    const baseSha = (
      await git.run(source, ["rev-parse", "--verify", "HEAD"])
    ).stdout.trim();
    const makeStep = async (stepId: string, position: number, file: string) => {
      const runId = "dag-run";
      const request = WorktreeOperationRequestSchema.parse({
        ...reserveRequest(source, runId),
        operationId: randomUUID(),
        worktreeId: `worktree-${stepId}`,
        expectedBaseSha: baseSha,
        workspaceKind: "step",
        ownerStepId: stepId,
      });
      const reserved = await manager.execute(request);
      const created = await operation(manager, reserved.worktree!, "create", {
        workspaceKind: "step",
        ownerStepId: stepId,
      });
      await writeFile(join(created.worktree!.path, file), `${stepId}\n`);
      await git.run(created.worktree!.path, ["add", file]);
      await git.run(created.worktree!.path, ["commit", "-m", stepId]);
      const finalized = await operation(manager, created.worktree!, "finalize", {
        workspaceKind: "step",
        ownerStepId: stepId,
      });
      expect(finalized.ok).toBe(true);
      expect(finalized.worktree!.resultSha).toMatch(/^[a-f0-9]{40}$/);
      return {
        stepId,
        stepKey: stepId,
        position,
        worktreeId: finalized.worktree!.id,
        resultSha: finalized.worktree!.resultSha,
      };
    };
    const left = await makeStep("left", 0, "left.txt");
    const right = await makeStep("right", 1, "right.txt");
    const composition = {
      baseSha,
      baseRef: "refs/heads/target",
      predecessors: [left, right],
      state: "pending" as const,
      resultSha: "",
      conflicts: [],
      error: "",
      startedAt: "",
      completedAt: "",
    };
    const reserve = await manager.execute(
      WorktreeOperationRequestSchema.parse({
        ...reserveRequest(source, "dag-run"),
        operationId: randomUUID(),
        worktreeId: "worktree-join",
        expectedBaseSha: baseSha,
        workspaceKind: "derived",
        ownerStepId: "join",
        composition,
      }),
    );
    const created = await operation(manager, reserve.worktree!, "create", {
      workspaceKind: "derived",
      ownerStepId: "join",
      composition,
    });
    const composeRequest = WorktreeOperationRequestSchema.parse({
      ...reserveRequest(source, "dag-run"),
      operationId: randomUUID(),
      kind: "compose",
      worktreeId: created.worktree!.id,
      generation: created.worktree!.generation,
      expectedVersion: manager.get(created.worktree!.id)!.version,
      expectedPath: created.worktree!.path,
      expectedBranchRef: created.worktree!.branchRef,
      expectedBaseSha: created.worktree!.baseSha,
      workspaceKind: "derived",
      ownerStepId: "join",
      composition,
    });
    interruptComposition = true;
    await expect(manager.execute(composeRequest)).rejects.toThrow(WorktreeCrash);
    const composed = await manager.execute(composeRequest);
    const replayed = await manager.execute(composeRequest);
    expect(composed.ok).toBe(true);
    expect(replayed).toEqual(composed);
    expect(composed.worktree!.composition).toMatchObject({
      state: "ready",
      predecessors: [left, right],
    });
    await expect(
      readFile(join(composed.worktree!.path, "left.txt"), "utf8"),
    ).resolves.toBe("left\n");
    await expect(
      readFile(join(composed.worktree!.path, "right.txt"), "utf8"),
    ).resolves.toBe("right\n");
    expect(
      (
        await git.run(composed.worktree!.path, [
          "rev-list",
          "--parents",
          "-n",
          "1",
          "HEAD",
        ])
      ).stdout
        .trim()
        .split(/\s+/)[2],
    ).toBe(right.resultSha);

    const conflictLeft = await makeStep("conflict-left", 2, "same.txt");
    const conflictRight = await makeStep("conflict-right", 3, "same.txt");
    const conflicting = {
      ...composition,
      predecessors: [conflictLeft, conflictRight],
    };
    const conflictReserve = await manager.execute(
      WorktreeOperationRequestSchema.parse({
        ...reserveRequest(source, "dag-run"),
        operationId: randomUUID(),
        worktreeId: "worktree-conflict-join",
        expectedBaseSha: baseSha,
        workspaceKind: "derived",
        ownerStepId: "conflict-join",
        composition: conflicting,
      }),
    );
    const conflictCreated = await operation(
      manager,
      conflictReserve.worktree!,
      "create",
      {
        workspaceKind: "derived",
        ownerStepId: "conflict-join",
        composition: conflicting,
      },
    );
    const conflictResult = await operation(
      manager,
      conflictCreated.worktree!,
      "compose",
      {
        workspaceKind: "derived",
        ownerStepId: "conflict-join",
        composition: conflicting,
      },
    );
    expect(conflictResult.ok).toBe(true);
    expect(conflictResult.worktree!.composition).toMatchObject({
      state: "conflicted",
      conflicts: ["same.txt"],
      error: expect.stringContaining("did not reset or clean"),
    });

    await writeFile(join(source, "later.txt"), "later\n");
    await git.run(source, ["add", "later.txt"]);
    await git.run(source, ["commit", "-m", "advance source"]);
    const readyReplay = await operation(manager, composed.worktree!, "compose", {
      workspaceKind: "derived",
      ownerStepId: "join",
      composition,
    });
    expect(readyReplay.ok).toBe(true);
    expect(readyReplay.worktree!.composition).toMatchObject({
      state: "ready",
      resultSha: composed.worktree!.composition!.resultSha,
    });
  });

  it("composes a clean primary checkout advanced by a read-only predecessor", async () => {
    const { source, manager } = await fixture();
    const runId = "read-only-predecessor-run";
    const primaryReserve = await manager.execute(
      WorktreeOperationRequestSchema.parse({
        ...reserveRequest(source, runId),
        operationId: randomUUID(),
        worktreeId: "worktree-primary",
      }),
    );
    const primary = await operation(manager, primaryReserve.worktree!, "create");
    await writeFile(join(primary.worktree!.path, "latest.txt"), "latest\n");
    await git.run(primary.worktree!.path, ["add", "latest.txt"]);
    await git.run(primary.worktree!.path, ["commit", "-m", "advance primary"]);
    const advancedHead = (
      await git.run(primary.worktree!.path, ["rev-parse", "--verify", "HEAD"])
    ).stdout.trim();
    const composition = {
      baseSha: primary.worktree!.baseSha,
      baseRef: primary.worktree!.baseRef,
      predecessors: [
        {
          stepId: "investigate",
          stepKey: "investigate",
          position: 0,
          worktreeId: primary.worktree!.id,
          resultSha: advancedHead,
        },
      ],
      state: "pending" as const,
      resultSha: "",
      conflicts: [],
      error: "",
      startedAt: "",
      completedAt: "",
    };
    const derivedReserve = await manager.execute(
      WorktreeOperationRequestSchema.parse({
        ...reserveRequest(source, runId),
        operationId: randomUUID(),
        worktreeId: "worktree-derived-from-primary",
        expectedBaseSha: primary.worktree!.baseSha,
        workspaceKind: "derived",
        ownerStepId: "implement",
        composition,
      }),
    );
    const derived = await operation(manager, derivedReserve.worktree!, "create", {
      workspaceKind: "derived",
      ownerStepId: "implement",
      composition,
    });
    const composed = await operation(manager, derived.worktree!, "compose", {
      workspaceKind: "derived",
      ownerStepId: "implement",
      composition,
    });

    expect(composed.ok).toBe(true);
    await expect(
      readFile(join(composed.worktree!.path, "latest.txt"), "utf8"),
    ).resolves.toBe("latest\n");
  });

  it("inherits cone-mode sparse checkout without materializing excluded paths", async () => {
    const { source, manager } = await fixture();
    await mkdir(join(source, "included"));
    await mkdir(join(source, "excluded"));
    await writeFile(join(source, "included", "visible.txt"), "visible\n");
    await writeFile(join(source, "excluded", "hidden.txt"), "hidden\n");
    await git.run(source, ["add", "."]);
    await git.run(source, ["commit", "-m", "add sparse paths"]);
    await git.run(source, ["sparse-checkout", "init", "--cone"]);
    await git.run(source, ["sparse-checkout", "set", "included"]);

    const tree = await allocate(manager, source);

    expect(tree.repositoryFeatures).toMatchObject({
      sparseCheckout: true,
      sparseCone: true,
      sparsePaths: ["included"],
    });
    expect(await readFile(join(tree.path, "included", "visible.txt"), "utf8")).toBe(
      "visible\n",
    );
    expect(fs.existsSync(join(tree.path, "excluded", "hidden.txt"))).toBe(false);
  });

  it("records submodule compatibility instead of rejecting the repository", async () => {
    const { root, source, manager } = await fixture();
    const child = join(root, "child");
    await mkdir(child);
    await git.run(child, ["init", "-b", "main"]);
    await git.run(child, ["config", "user.name", "Fleet Test"]);
    await git.run(child, ["config", "user.email", "fleet-test@example.invalid"]);
    await writeFile(join(child, "child.txt"), "child\n");
    await git.run(child, ["add", "."]);
    await git.run(child, ["commit", "-m", "child"]);
    await git.run(source, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      child,
      "modules/child",
    ]);
    await git.run(source, ["commit", "-am", "add submodule"]);

    const reserved = await manager.execute(reserveRequest(source));

    expect(reserved.ok).toBe(true);
    expect(reserved.worktree?.repositoryFeatures.submodules).toBe(true);
    expect(reserved.worktree?.repositoryFeatures.estimatedBytesReliable).toBe(false);
  });

  it.skipIf(process.platform !== "win32")(
    "reattaches the existing real ACP slot and durable lease, fences retired attempts, and never duplicates its process",
    async () => {
      const live = await liveAcpFixture();
      const { initial, inventory, acquire, resume, prompt, router } = live;
      const lease = acquire.mock.results[0]!.value;
      const reattach = vi.spyOn(lease, "reattach");
      const original = inventory.holder(initial.checkoutKey)!;
      const next = { ...initial, leaseAttempt: "reattached-attempt" };
      expect(await resume(next)).toMatchObject({ ok: true, executionBinding: next });
      expect(reattach).toHaveBeenCalledExactlyOnceWith(
        "session:live",
        initial.leaseAttempt,
        next.leaseAttempt,
      );
      expect(inventory.holder(initial.checkoutKey)).toEqual({
        ...original,
        attempt: next.leaseAttempt,
      });
      expect(await prompt(next)).toMatchObject({ ok: true, executionBinding: next });
      await expect.poll(() => router.busySessionIds).toEqual([]);
      expect(await prompt(initial)).toMatchObject({ ok: false, fatal: false });
      expect(await resume(initial)).toMatchObject({ ok: false, fatal: false });
      for (const invalid of [
        { ...next, worktreeId: "wrong-worktree" },
        { ...next, generation: initial.generation + 1 },
        { ...next, cwd: live.source },
        { ...next, sourcePlacementId: "wrong-source-placement" },
        { ...next, checkoutKey: "wrong-checkout" },
      ]) {
        expect(await resume(invalid)).toMatchObject({ ok: false, fatal: false });
      }
      expect(await resume(next, { localPath: live.source })).toMatchObject({
        ok: false,
        fatal: false,
      });
      expect(
        await resume(next, { agentSessionId: "another-conversation" }),
      ).toMatchObject({ ok: false, fatal: false });
      expect(await resume(next)).toMatchObject({ ok: true, executionBinding: next });
      expect(reattach).toHaveBeenCalledOnce();
      expect(live.resync).toHaveBeenCalledTimes(2);
      expect(live.stop).not.toHaveBeenCalled();
      expect(live.start).toHaveBeenCalledOnce();
      expect(acquire).toHaveBeenCalledOnce();
      expect(router.activeSessionIds).toEqual(["live"]);
      expect(inventory.holder(initial.checkoutKey)).toEqual({
        ...original,
        attempt: next.leaseAttempt,
      });
      expect(live.manager.get(live.tree.id)).toMatchObject({
        id: initial.worktreeId,
        generation: initial.generation,
      });
      expect(await readdir(join(live.root, "locks"))).toHaveLength(1);
    },
  );

  it.skipIf(process.platform !== "win32").each(["save", "CAS"] as const)(
    "keeps the live slot and durable attempt unchanged after reattachment %s failure",
    async (failure) => {
      const live = await liveAcpFixture();
      const { initial, inventory, acquire, resume, prompt, router } = live;
      const lease = acquire.mock.results[0]!.value;
      const reattach = vi.spyOn(lease, "reattach");
      const original = inventory.holder(initial.checkoutKey)!;
      const next = { ...initial, leaseAttempt: "retryable-attempt" };
      if (failure === "save") {
        vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
          throw Object.assign(new Error("Injected atomic lease save failure"), {
            code: "EACCES",
          });
        });
      } else {
        const revalidate = lease.revalidate;
        vi.spyOn(lease, "revalidate").mockImplementationOnce(async () => {
          await revalidate();
          // Simulate a changed owner attempt at the final CAS read, after
          // asynchronous admission, without replacing the real CAS implementation.
          vi.spyOn(live.manager.locks, "holder")
            .mockReturnValueOnce(original)
            .mockReturnValueOnce({ ...original, attempt: "concurrent-attempt" });
        });
      }
      expect(await resume(next)).toMatchObject({
        ok: false,
        error:
          failure === "save"
            ? "Injected atomic lease save failure"
            : "Checkout lease owner changed.",
      });
      expect(reattach).toHaveBeenCalledOnce();
      expect(inventory.holder(initial.checkoutKey)).toEqual(original);
      await expect(lease.revalidate()).resolves.toBeUndefined();
      expect(await prompt(next)).toMatchObject({ ok: false, fatal: false });
      expect(await prompt(initial)).toMatchObject({
        ok: true,
        executionBinding: initial,
      });
      await expect.poll(() => router.busySessionIds).toEqual([]);
      expect(await resume(initial)).toMatchObject({
        ok: true,
        executionBinding: initial,
      });
      expect(await resume(next)).toMatchObject({ ok: true, executionBinding: next });
      expect(inventory.holder(initial.checkoutKey)).toEqual({
        ...original,
        attempt: next.leaseAttempt,
      });
      expect(await prompt(initial)).toMatchObject({ ok: false, fatal: false });
      expect(await prompt(next)).toMatchObject({ ok: true, executionBinding: next });
      expect(reattach).toHaveBeenCalledTimes(2);
      expect(live.stop).not.toHaveBeenCalled();
      expect(live.start).toHaveBeenCalledOnce();
      expect(acquire).toHaveBeenCalledOnce();
      expect(router.activeSessionIds).toEqual(["live"]);
      expect(await readdir(join(live.root, "locks"))).toHaveLength(1);
    },
  );

  it.skipIf(process.platform !== "win32").each([true, false])(
    "keeps supervisor proof out of real ACP system events and stderrTail without hiding diagnostics (managed=%s)",
    async (managed) => {
      const spawned = vi.spyOn(windowsJob, "spawnWindowsJob");
      const live = await liveAcpFixture(managed);
      expect(await live.prompt(live.initial, "stderr:exit:0")).toMatchObject({
        ok: true,
      });
      await expect
        .poll(() => live.router.activeSessionIds, { timeout: 15_000 })
        .toEqual([]);
      const diagnostics = live.events
        .filter((event) => event.type === "system")
        .map((event) => event.payload.text)
        .join("\n");
      const tail: unknown = Reflect.get(live.agent, "stderrTail");
      for (const text of [diagnostics, tail]) {
        expect(text).toContain("legitimate stderr before exit");
        expect(text).toContain("fleet-process-tree-quiesced:unrelated-diagnostic");
        expect(text).toContain("legitimate unterminated stderr");
        if (managed) expect(text).not.toContain(spawned.mock.results[0]!.value.proof);
      }
      expect(spawned).toHaveBeenCalledTimes(managed ? 1 : 0);
      if (managed) {
        await expect(live.agent.stop(false)).resolves.toBeUndefined();
        expect(live.inventory.holder(live.initial.checkoutKey)).toBeUndefined();
      }
      expect(
        live.events.filter((event) => event.payload.state === "completed"),
      ).toHaveLength(1);
    },
  );

  it("leaves unbound legacy sessions on pre-feature admission without managed locks across installations and aliases", async () => {
    const { root, source } = await fixture();
    const first = new ManagedWorktrees({
      directory: join(root, "legacy-node-a"),
      nodeId: () => "node-a",
    });
    const second = new ManagedWorktrees({
      directory: join(root, "legacy-node-b"),
      nodeId: () => "node-b",
    });
    managers.push(first, second);
    const entered = gate(),
      release = gate(),
      finished = gate();
    let active = 0,
      maximum = 0;
    const workers = factory(async (cwd, text) => {
      active += 1;
      maximum = Math.max(maximum, active);
      entered.resolve();
      await release.promise;
      await writeFile(join(cwd, "same.txt"), text);
      active -= 1;
      finished.resolve();
    });
    const a = new CommandRouter(
      workers,
      4,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      { worktrees: first },
    );
    const b = new CommandRouter(
      workers,
      4,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      { worktrees: second },
    );
    routers.push(a, b);
    const command = (id: string, path: string, readOnly = false) =>
      NodeCommandSchema.parse({
        type: "start_session",
        commandId: randomUUID(),
        sessionId: id,
        localPath: path,
        sourcePlacementId: id,
        prompt: id,
        readOnly,
      });
    expect((await a.route(command("legacy-a", source))).ok).toBe(true);
    await entered.promise;
    const alias = join(root, "legacy-alias");
    await symlink(source, alias, "junction");
    expect((await b.route(command("legacy-b", alias, true))).ok).toBe(true);
    expect(await readdir(join(root, "locks"))).toEqual([]);
    release.resolve();
    await finished.promise;
    expect((await b.route(command("still-held", alias))).ok).toBe(true);
    await a.route(
      NodeCommandSchema.parse({
        type: "stop",
        sessionId: "legacy-a",
        commandId: randomUUID(),
      }),
    );
    expect((await b.route(command("legacy-next", alias))).ok).toBe(true);
    await b.stopAll();
    expect(maximum).toBe(2);
    expect(
      parseWorktreeRegistry(
        (await git.run(source, ["worktree", "list", "--porcelain", "-z"])).stdout,
      ),
    ).toHaveLength(1);
    await unlink(alias);
  });

  it.skipIf(process.platform !== "win32").each([
    [true, 0, "completed"],
    [true, 9, "failed"],
    [false, 0, "completed"],
    [false, 9, "failed"],
  ] as const)(
    "delivers an unsolicited real ACP exit exactly once (managed=%s, code=%i)",
    async (managed, code, state) => {
      const { manager, source } = await fixture();
      const tree = await allocate(manager, source);
      const events: SessionEvent[] = [];
      vi.spyOn(copilotLaunch, "resolveCopilotLaunch").mockResolvedValue({
        command: process.execPath,
        args: [resolve("apps", "node", "src", "fixtures", "managed-acp.mjs")],
        provider: "copilot",
      });
      const acquire = vi.spyOn(manager.locks, "acquire");
      const workers = new AcpAgentFactory(60_000, process.execPath);
      const router = new CommandRouter(
        workers,
        1,
        (event) => events.push(event),
        undefined,
        undefined,
        undefined,
        undefined,
        { worktrees: manager },
      );
      routers.push(router);
      const command = NodeCommandSchema.parse({
        ...launch("exiting", tree),
        localPath: managed ? tree.path : source,
        executionBinding: managed ? binding(tree, "lease-exiting") : undefined,
        prompt: `exit:${code}`,
      });
      expect(await router.route(command)).toMatchObject({ ok: true });
      await expect
        .poll(() => events.filter((event) => event.payload.state === state), {
          timeout: 15_000,
        })
        .toHaveLength(1);
      expect(
        events.filter((event) =>
          ["completed", "failed", "stopped"].includes(String(event.payload.state)),
        ),
      ).toHaveLength(1);
      expect(router.activeSessionIds).toEqual([]);
      expect(manager.locks.holder(tree.checkout!.key)).toBeUndefined();
      expect(acquire).toHaveBeenCalledTimes(managed ? 1 : 0);
      expect(
        await router.route(
          NodeCommandSchema.parse({
            ...command,
            commandId: randomUUID(),
            sessionId: "next",
            executionBinding: managed ? binding(tree, "lease-next") : undefined,
            prompt: "stay",
          }),
        ),
      ).toMatchObject({ ok: true });
      await router.stopAll();
      expect(
        events.filter(
          (event) =>
            event.sessionId === "exiting" &&
            ["completed", "failed", "stopped"].includes(String(event.payload.state)),
        ),
      ).toHaveLength(1);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "settles every real ACP slot, persists uncertain ownership, and retries quiescence without memoizing failure",
    async () => {
      const { manager, source } = await fixture();
      const unsafe = await allocate(manager, source);
      const safe = await allocate(manager, source);
      vi.spyOn(copilotLaunch, "resolveCopilotLaunch").mockResolvedValue({
        command: process.execPath,
        args: [resolve("apps", "node", "src", "fixtures", "managed-acp.mjs")],
        provider: "copilot",
      });
      const events: SessionEvent[] = [];
      const router = new CommandRouter(
        new AcpAgentFactory(60_000, process.execPath),
        3,
        (event) => events.push(event),
        undefined,
        undefined,
        undefined,
        undefined,
        { worktrees: manager },
      );
      routers.push(router);
      expect((await router.route(launch("unsafe", unsafe))).ok).toBe(true);
      expect((await router.route(launch("safe", safe))).ok).toBe(true);
      const unsafePid = manager.locks.holder(unsafe.checkout!.key)!.processes[0]!;
      const stop = processQuiescence.stopProcessTree;
      const verify = vi
        .spyOn(processQuiescence, "stopProcessTree")
        .mockImplementation(async (child, ownership) => {
          if (child.pid === unsafePid)
            throw new Error("Cannot verify descendant ownership");
          await stop(child, ownership);
        });
      await expect(router.stopAll()).rejects.toThrow(
        "Some sessions could not stop safely",
      );
      expect(router.activeSessionIds).toEqual([]);
      expect(manager.locks.holder(safe.checkout!.key)).toBeUndefined();
      expect(manager.locks.holder(unsafe.checkout!.key)).toMatchObject({
        owner: "session:unsafe",
        processes: [unsafePid],
        reconciliationRequired: expect.any(String),
      });
      expect(manager.get(unsafe.id)!.state).toBe("needs_reconciliation");
      expect((await operation(manager, unsafe, "reconcile")).code).toBe(
        "process_unknown",
      );
      expect((await router.route(launch("blocked", unsafe))).ok).toBe(false);
      expect(
        events.filter(
          (event) => event.sessionId === "unsafe" && event.payload.state === "failed",
        ),
      ).toHaveLength(1);
      verify.mockRestore();
      await router.quiesceWorktree(unsafe.id);
      expect(manager.locks.holder(unsafe.checkout!.key)).toBeUndefined();
      expect((await operation(manager, unsafe, "reconcile")).ok).toBe(true);
      expect((await router.route(launch("eligible", unsafe))).ok).toBe(true);
      expect(
        events.filter(
          (event) =>
            event.sessionId === "unsafe" &&
            ["failed", "stopped"].includes(String(event.payload.state)),
        ),
      ).toHaveLength(1);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "propagates a natural terminal event despite uncertain descendant verification and releases only after a verified retry",
    async () => {
      const { manager, source } = await fixture();
      const tree = await allocate(manager, source);
      vi.spyOn(copilotLaunch, "resolveCopilotLaunch").mockResolvedValue({
        command: process.execPath,
        args: [resolve("apps", "node", "src", "fixtures", "managed-acp.mjs")],
        provider: "copilot",
      });
      const stop = vi
        .spyOn(processQuiescence, "stopProcessTree")
        .mockRejectedValue(new Error("Supervisor proof unavailable"));
      const events: SessionEvent[] = [];
      const router = new CommandRouter(
        new AcpAgentFactory(60_000, process.execPath),
        1,
        (event) => events.push(event),
        undefined,
        undefined,
        undefined,
        undefined,
        { worktrees: manager },
      );
      routers.push(router);
      expect(
        (
          await router.route(
            NodeCommandSchema.parse({ ...launch("exit", tree), prompt: "exit:0" }),
          )
        ).ok,
      ).toBe(true);
      await expect
        .poll(() => events.filter((event) => event.payload.state === "completed"), {
          timeout: 15_000,
        })
        .toHaveLength(1);
      expect(router.activeSessionIds).toEqual([]);
      expect(
        manager.locks.holder(tree.checkout!.key)?.reconciliationRequired,
      ).toBeTruthy();
      expect(manager.get(tree.id)!.state).toBe("needs_reconciliation");
      stop.mockRestore();
      await router.quiesceWorktree(tree.id);
      expect(manager.locks.holder(tree.checkout!.key)).toBeUndefined();
      expect(
        events.filter((event) =>
          ["completed", "failed", "stopped"].includes(String(event.payload.state)),
        ),
      ).toHaveLength(1);
    },
  );

  it("closes the real worktree database even if an in-flight operation rejects", async () => {
    const { manager } = await fixture();
    const failure = new Error("Git worker failed during shutdown");
    const inFlight = Reflect.get(manager, "inFlight") as Map<string, Promise<unknown>>;
    inFlight.set("failing-operation", Promise.reject(failure));
    await expect(manager.shutdown()).rejects.toMatchObject({ errors: [failure] });
    expect(() => manager.get("any-tree")).toThrow(/not open|closed/i);
  });

  it("does not quiesce an unrelated legacy session when a managed worktree is drained", async () => {
    const { manager, source } = await fixture();
    const router = new CommandRouter(
      factory(async () => {}),
      2,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      { worktrees: manager },
    );
    routers.push(router);
    expect(
      (
        await router.route(
          NodeCommandSchema.parse({
            type: "start_session",
            commandId: randomUUID(),
            sessionId: "legacy",
            localPath: source,
            prompt: "legacy",
          }),
        )
      ).ok,
    ).toBe(true);
    await router.quiesceWorktree("unrelated-managed-worktree");
    expect(router.activeSessionIds).toEqual(["legacy"]);
    expect(
      manager.locks.holder((await manager.checkoutIdentity(source)).key),
    ).toBeUndefined();
  });

  it("drains operations before quarantine and preserves quarantine despite operation failure", async () => {
    const { manager, source } = await fixture();
    const tree = await allocate(manager, source);
    const failure = new Error("Operation rejected during restore");
    const inFlight = Reflect.get(manager, "inFlight") as Map<string, Promise<unknown>>;
    const pending = gate();
    inFlight.set(
      "pending-operation",
      pending.promise.then(() => {
        throw failure;
      }),
    );
    const quarantining = manager.quarantine();
    const failed = expect(quarantining).rejects.toMatchObject({ errors: [failure] });
    await expect(
      manager.validateExecution(binding(tree, "new-session")),
    ).rejects.toMatchObject({ code: "node_draining" });
    await expect(manager.execute(reserveRequest(source))).rejects.toMatchObject({
      code: "node_draining",
    });
    pending.resolve();
    await failed;
    expect(manager.get(tree.id)!.state).toBe("quarantined");
    await expect(
      manager.validateExecution(binding(tree, "new-session")),
    ).rejects.toMatchObject({ code: "binding_unavailable" });
  });

  it("allows an inactive custom hooksPath but rejects active hooks with remediation", async () => {
    const missing = await fixture();
    await git.run(missing.source, ["config", "core.hooksPath", "missing-hooks"]);
    expect(await missing.manager.execute(reserveRequest(missing.source))).toMatchObject({
      ok: true,
    });

    const inactive = await fixture();
    const inactiveHooks = join(inactive.source, "inactive-hooks");
    await mkdir(inactiveHooks);
    await writeFile(join(inactiveHooks, "pre-commit.sample"), "sample\n");
    await git.run(inactive.source, ["config", "core.hooksPath", "inactive-hooks"]);
    expect(await inactive.manager.execute(reserveRequest(inactive.source))).toMatchObject(
      {
        ok: true,
      },
    );

    const active = await fixture();
    const activeHooks = join(active.root, "active-hooks");
    await mkdir(activeHooks);
    await writeFile(join(activeHooks, "pre-commit"), "active\n");
    await git.run(active.source, ["config", "core.hooksPath", activeHooks]);
    expect(await active.manager.execute(reserveRequest(active.source))).toMatchObject({
      ok: false,
      code: "unsupported_hooks",
      error: expect.stringMatching(
        /active-hooks.*remove or disable them.*use Legacy mode/i,
      ),
    });
    expect(
      await active.manager.execute({
        ...reserveRequest(active.source),
        allowGitHooks: true,
      }),
    ).toMatchObject({
      ok: true,
      worktree: { allowGitHooks: true },
    });
  });

  it("enters two barrier-controlled writer sections simultaneously, editing the same filename independently", async () => {
    const { manager, source } = await fixture();
    const a = await allocate(manager, source);
    const b = await allocate(manager, source);
    const both = gate(),
      release = gate(),
      finished = gate();
    let active = 0,
      maximum = 0,
      done = 0;
    const router = new CommandRouter(
      factory(async (cwd, text) => {
        active += 1;
        maximum = Math.max(active, maximum);
        if (active === 2) both.resolve();
        await release.promise;
        await writeFile(join(cwd, "same.txt"), text);
        active -= 1;
        if (++done === 2) finished.resolve();
      }),
      4,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      { worktrees: manager },
    );
    routers.push(router);
    expect(
      (
        await Promise.all([router.route(launch("A", a)), router.route(launch("B", b))])
      ).every((result) => result.ok),
    ).toBe(true);
    await both.promise;
    expect(maximum).toBe(2);
    release.resolve();
    await finished.promise;
    expect(a.checkout!.key).not.toBe(b.checkout!.key);
    expect(await readFile(join(a.path, "same.txt"), "utf8")).toBe("A");
    expect(await readFile(join(b.path, "same.txt"), "utf8")).toBe("B");
    expect(await readFile(join(source, "same.txt"), "utf8")).toBe("base\n");
  });

  it("serializes a task's writers and rejects readOnly/manual alias bypasses until process quiescence", async () => {
    const { manager, source, root } = await fixture();
    const tree = await allocate(manager, source);
    const started = gate(),
      release = gate();
    let active = 0,
      maximum = 0;
    const router = new CommandRouter(
      factory(async () => {
        active += 1;
        maximum = Math.max(active, maximum);
        started.resolve();
        await release.promise;
        active -= 1;
      }),
      8,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      { worktrees: manager },
    );
    routers.push(router);
    expect((await router.route(launch("implementer", tree))).ok).toBe(true);
    await started.promise;
    expect(
      (
        await router.route(
          NodeCommandSchema.parse({ ...launch("reviewer", tree), readOnly: true }),
        )
      ).ok,
    ).toBe(false);
    const alias = join(root, "alias");
    await symlink(tree.path, alias, "junction");
    expect(
      (
        await router.route(
          NodeCommandSchema.parse({
            type: "start_session",
            commandId: randomUUID(),
            sessionId: "manual",
            localPath: alias,
            prompt: "manual",
            readOnly: true,
          }),
        )
      ).ok,
    ).toBe(false);
    expect((await operation(manager, tree, "cleanup")).code).toBe("checkout_busy");
    const stopped = router.route(
      NodeCommandSchema.parse({
        type: "stop",
        commandId: randomUUID(),
        sessionId: "implementer",
      }),
    );
    expect((await router.route(launch("fixer-too-soon", tree))).ok).toBe(false);
    release.resolve();
    await stopped;
    expect((await router.route(launch("fixer", tree))).ok).toBe(true);
    expect(maximum).toBe(1);
    await unlink(alias);
  });

  it("retains committed and uncommitted implementation state for reviewers, fixers and resumed conversations", async () => {
    const { manager, source } = await fixture();
    const tree = await allocate(manager, source);
    await writeFile(join(tree.path, "same.txt"), "implementation\n");
    await git.run(tree.path, ["commit", "-am", "implementation"]);
    await writeFile(join(tree.path, "uncommitted.txt"), "context still here\n");
    const resumed = await operation(manager, tree, "create");
    expect(resumed.worktree!.checkout!.key).toBe(tree.checkout!.key);
    const seen: string[] = [];
    const router = new CommandRouter(
      factory(async (cwd, text) => {
        seen.push(
          `${text}:${await readFile(join(cwd, "same.txt"), "utf8")}:${await readFile(join(cwd, "uncommitted.txt"), "utf8")}`,
        );
      }),
      4,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      { worktrees: manager },
    );
    routers.push(router);
    const reviewer = launch("reviewer", tree);
    expect((await router.route(reviewer)).ok).toBe(true);
    await router.route(
      NodeCommandSchema.parse({
        type: "stop",
        sessionId: "reviewer",
        commandId: randomUUID(),
      }),
    );
    expect((await router.route(launch("fixer", tree))).ok).toBe(true);
    await router.route(
      NodeCommandSchema.parse({
        type: "stop",
        sessionId: "fixer",
        commandId: randomUUID(),
      }),
    );
    expect(
      (
        await router.route(
          NodeCommandSchema.parse({
            type: "resume_session",
            commandId: randomUUID(),
            sessionId: "reviewer",
            localPath: tree.path,
            agentSessionId: "same-copilot-conversation",
            executionBinding: binding(tree, "resume-reviewer"),
          }),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await router.route(
          NodeCommandSchema.parse({
            type: "prompt",
            commandId: randomUUID(),
            sessionId: "reviewer",
            prompt: "follow-up",
            executionBinding: binding(tree, "resume-reviewer"),
          }),
        )
      ).ok,
    ).toBe(true);
    await router.stopAll();
    expect(seen).toHaveLength(3);
    expect(
      seen.every((text) => text.includes("implementation\n:context still here\n")),
    ).toBe(true);
    expect(await readFile(join(source, "same.txt"), "utf8")).toBe("base\n");
  });

  it.each(["cleanup", "stop"] as const)(
    "guards a prompt waiting for checkout validation against concurrent %s",
    async (action) => {
      const { manager, source } = await fixture();
      const tree = await allocate(manager, source);
      const validating = gate(),
        resume = gate();
      const prompts: string[] = [];
      const workers = factory(async (_cwd, text) => {
        prompts.push(text);
      });
      const remove = vi.fn();
      const router = new CommandRouter(
        {
          async start(id, cwd, sink, options) {
            sink({
              eventId: randomUUID(),
              sessionId: id,
              sequence: 1,
              type: "agent_session",
              payload: { agentSessionId: "conversation" },
              createdAt: new Date().toISOString(),
            });
            return workers.start(id, cwd, sink, options);
          },
        },
        2,
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        { worktrees: manager, deleteInactiveSession: remove },
      );
      routers.push(router);
      expect((await router.route(launch("worker", tree))).ok).toBe(true);
      const at = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(at);
      vi.spyOn(manager, "validateExecution").mockImplementationOnce(async () => {
        validating.resolve();
        await resume.promise;
      });
      const prompt = router.route(
        NodeCommandSchema.parse({
          type: "prompt",
          commandId: randomUUID(),
          sessionId: "worker",
          prompt: "follow-up",
          executionBinding: binding(tree, "lease-worker"),
        }),
      );
      await validating.promise;
      clock.mockReturnValue(at + 60 * 86_400_000);
      if (action === "cleanup") {
        const cleanup = await router.route(
          NodeCommandSchema.parse({
            type: "delete_session",
            commandId: randomUUID(),
            sessionId: "worker",
            agentSessionId: "conversation",
            retentionDays: 30,
            inactiveBefore: new Date(at + 30 * 86_400_000).toISOString(),
          }),
        );
        expect(cleanup).toMatchObject({ ok: false, fatal: false });
        expect(remove).not.toHaveBeenCalled();
      } else {
        expect(
          (
            await router.route(
              NodeCommandSchema.parse({
                type: "stop",
                commandId: randomUUID(),
                sessionId: "worker",
              }),
            )
          ).ok,
        ).toBe(true);
      }
      resume.resolve();
      expect((await prompt).ok).toBe(action === "cleanup");
      expect(prompts).toEqual(
        action === "cleanup" ? ["worker", "follow-up"] : ["worker"],
      );
    },
  );

  it("pins the exact committed base before the source HEAD moves", async () => {
    const { source, manager } = await fixture();
    const reserved = await manager.execute(reserveRequest(source));
    expect(reserved.ok).toBe(true);
    const base = reserved.worktree!.baseSha;
    await writeFile(join(source, "same.txt"), "source moved\n");
    await git.run(source, ["commit", "-am", "source advances"]);
    const created = await operation(manager, reserved.worktree!, "create");
    expect(created.ok).toBe(true);
    expect(
      (await git.run(created.worktree!.path, ["rev-parse", "HEAD"])).stdout.trim(),
    ).toBe(base);
    expect(await readFile(join(created.worktree!.path, "same.txt"), "utf8")).toBe(
      "base\n",
    );
  });

  it("rejects deterministic ref collisions and counts reservations against quota without eviction", async () => {
    const { source, manager } = await fixture();
    const colliding = reserveRequest(source);
    const key = createHash("sha256")
      .update(
        `${colliding.hostInstallationId}:${colliding.runId}:${colliding.generation}`,
      )
      .digest("hex")
      .slice(0, 32);
    const ref = `refs/heads/fleet/${key}`;
    const base = (await git.run(source, ["rev-parse", "HEAD"])).stdout.trim();
    await git.run(source, ["update-ref", ref, base]);
    expect((await manager.execute(colliding)).code).toBe("path_ref_collision");
    expect((await git.run(source, ["rev-parse", ref])).stdout.trim()).toBe(base);
    const request = reserveRequest(source);
    request.policy.maxPerRepository = 1;
    const reserved = await manager.execute(request);
    expect(reserved.ok).toBe(true);
    expect(await manager.execute(request)).toEqual(reserved);
    const extra = reserveRequest(source);
    extra.policy.maxPerRepository = 1;
    expect((await manager.execute(extra)).code).toBe("worktree_quota");
    expect(manager.get(reserved.worktree!.id)!.state).toBe("reserved");
    expect((await operation(manager, reserved.worktree!, "create")).ok).toBe(true);
  });

  it("acknowledges a replay mismatch instead of stranding the Host", async () => {
    const { manager, source } = await fixture();
    const request = reserveRequest(source);
    const reserved = await manager.execute(request);
    expect(reserved.ok).toBe(true);

    const mismatch = await manager.execute(
      WorktreeOperationRequestSchema.parse({
        ...request,
        actor: "different-replay-actor",
      }),
    );

    expect(mismatch).toMatchObject({
      operationId: request.operationId,
      ok: false,
      code: "idempotency_mismatch",
    });
    expect(mismatch).not.toHaveProperty("worktree");
    expect(manager.get(reserved.worktree!.id)?.error).toBe("");
  });

  it("normalizes an interrupted operation persisted by an older protocol", async () => {
    let injected = false;
    const { root, manager, source } = await fixture((stage) => {
      if (stage === "intent" && !injected) {
        injected = true;
        throw new WorktreeCrash("injected crash");
      }
    });
    const request = reserveRequest(source);
    await expect(manager.execute(request)).rejects.toThrow("injected");
    manager.close();
    managers.splice(managers.indexOf(manager), 1);

    const database = new DatabaseSync(join(root, "state", "managed-worktrees.db"));
    const persisted = JSON.parse(
      String(
        database
          .prepare("SELECT request FROM operations WHERE id=?")
          .get(request.operationId)!.request,
      ),
    ) as Record<string, unknown>;
    for (const field of [
      "allowGitHooks",
      "attempt",
      "commit",
      "deleteBranch",
      "expectedBaseRef",
      "expectedBaseSha",
      "expectedBranchRef",
      "expectedPath",
      "originatingPlacementId",
      "ownerStepId",
      "repositoryIdentity",
      "workspaceKind",
      "workspaceResults",
    ])
      delete persisted[field];
    database
      .prepare("UPDATE operations SET request=? WHERE id=?")
      .run(JSON.stringify(persisted), request.operationId);
    database.close();

    const restarted = new ManagedWorktrees({
      directory: join(root, "state"),
      nodeId: () => "node-1",
      locks: new CheckoutLocks(join(root, "locks")),
    });
    managers.push(restarted);
    const result = await restarted.execute(request);
    expect(result).toMatchObject({
      operationId: request.operationId,
      ok: true,
      code: "",
    });
  });

  it.each(["intent", "git", "receipt"] as const)(
    "recovers a create crash at %s without a duplicate branch or overwrite",
    async (stage) => {
      let injected = false;
      const { root, manager, source } = await fixture((where, request) => {
        if (request.kind === "create" && where === stage && !injected) {
          injected = true;
          throw new WorktreeCrash("injected crash");
        }
      });
      const reserved = (await manager.execute(reserveRequest(source))).worktree!;
      const request = WorktreeOperationRequestSchema.parse({
        ...reserveRequest(source, reserved.runId),
        worktreeId: reserved.id,
        kind: "create",
        expectedVersion: reserved.version,
        expectedPath: reserved.path,
        expectedBranchRef: reserved.branchRef,
        expectedBaseSha: reserved.baseSha,
      });
      await expect(manager.execute(request)).rejects.toThrow("injected");
      manager.close();
      managers.splice(managers.indexOf(manager), 1);
      const restarted = new ManagedWorktrees({
        directory: join(root, "state"),
        nodeId: () => "node-1",
        locks: new CheckoutLocks(join(root, "locks")),
      });
      managers.push(restarted);
      const result = await restarted.execute(request);
      expect(result.error).toBe("");
      expect(result.ok).toBe(true);
      expect(await restarted.execute(request)).toEqual(result);
      const registry = parseWorktreeRegistry(
        (await git.run(source, ["worktree", "list", "--porcelain", "-z"])).stdout,
      );
      expect(
        registry.filter((entry) => entry.branch === reserved.branchRef),
      ).toHaveLength(1);
      expect(
        (await operation(restarted, result.worktree!, "create")).worktree!.path,
      ).toBe(reserved.path);
    },
  );

  it("refuses dirty, untracked and ignored cleanup; abandonment names ownership and keeps files", async () => {
    const { manager, source } = await fixture();
    const tree = await allocate(manager, source);
    for (const name of ["untracked.txt", "ignored.txt", "same.txt"]) {
      await writeFile(join(tree.path, name), "valuable data\n");
      expect((await operation(manager, tree, "cleanup")).code).toBe("dirty_or_unknown");
      if (name === "same.txt") await writeFile(join(tree.path, name), "base\n");
      else await unlink(join(tree.path, name));
    }
    await writeFile(join(tree.path, "same.txt"), "staged\n");
    await git.run(tree.path, ["add", "same.txt"]);
    expect((await operation(manager, tree, "cleanup")).code).toBe("dirty_or_unknown");
    expect((await operation(manager, tree, "abandon", { confirm: "yes" })).code).toBe(
      "confirmation_required",
    );
    const abandoned = await operation(manager, tree, "abandon", {
      confirm: `ABANDON ${tree.branchRef} AT ${tree.path}; KEEP FILES`,
    });
    expect(abandoned.ok).toBe(true);
    expect(abandoned.worktree!.abandonedAt).not.toBe("");
    expect(await readFile(join(tree.path, "same.txt"), "utf8")).toBe("staged\n");
    expect((await operation(manager, tree, "cleanup")).code).toBe("abandoned");
  });

  it("persists a real merge conflict, reserves the target, and aborts only the matching operation without touching the task", async () => {
    const { manager, source } = await fixture();
    const tree = await allocate(manager, source);
    await writeFile(join(tree.path, "same.txt"), "task change\n");
    await git.run(tree.path, ["commit", "-am", "task"]);
    await writeFile(join(source, "same.txt"), "target change\n");
    await git.run(source, ["commit", "-am", "target"]);
    const preview = (
      await operation(manager, tree, "integration_preview", {
        targetPath: source,
        targetPlacementId: "target-placement",
      })
    ).preview!;
    expect(preview.taskDirty).toBe(false);
    const started = await operation(manager, tree, "integrate", {
      previewId: preview.id,
      reviewedTaskSha: preview.taskSha,
      reviewedDiffIdentity: preview.diffIdentity,
      confirm: `MERGE ${preview.taskSha} INTO ${preview.targetRef}`,
    });
    expect(started.error).toBe("");
    expect(started.integration!.state).toBe("conflicted");
    expect(started.integration!.conflicts).toEqual(["same.txt"]);
    const target = await canonicalPath(source);
    expect(() =>
      manager.locks.acquire(target, { owner: "manual", kind: "worker", attempt: "1" }),
    ).toThrow("reserved");
    expect((await operation(manager, tree, "cleanup")).code).toBe(
      "integration_unresolved",
    );
    expect(
      (
        await operation(manager, tree, "abort", {
          integrationId: "wrong",
          confirm: "ABORT MERGE wrong",
        })
      ).code,
    ).toBe("wrong_integration");
    const aborted = await operation(manager, tree, "abort", {
      integrationId: started.integration!.id,
      confirm: `ABORT MERGE ${started.integration!.id}`,
    });
    expect(aborted.error).toBe("");
    expect(aborted.integration!.state).toBe("aborted");
    expect(await readFile(join(source, "same.txt"), "utf8")).toBe("target change\n");
    expect(await readFile(join(tree.path, "same.txt"), "utf8")).toBe("task change\n");
    expect(manager.locks.holder(target.key)).toBeUndefined();
    expect((await operation(manager, tree, "cleanup")).worktree!.state).toBe("removed");
    expect(
      (await git.run(source, ["rev-parse", "--verify", tree.branchRef])).stdout.trim(),
    ).toBe(preview.taskSha);
  });

  it("rejects stale reviewed SHA and target preview; merges only after explicit confirmation", async () => {
    const { manager, source } = await fixture();
    const tree = await allocate(manager, source);
    await writeFile(join(tree.path, "task.txt"), "task");
    await git.run(tree.path, ["add", "task.txt"]);
    await git.run(tree.path, ["commit", "-m", "task"]);
    const preview = (
      await operation(manager, tree, "integration_preview", {
        targetPath: source,
        targetPlacementId: "target-placement",
      })
    ).preview!;
    const input = {
      previewId: preview.id,
      reviewedTaskSha: preview.taskSha,
      reviewedDiffIdentity: preview.diffIdentity,
      confirm: `MERGE ${preview.taskSha} INTO ${preview.targetRef}`,
      commit: true,
    };
    expect(
      (
        await operation(manager, tree, "integrate", {
          ...input,
          reviewedTaskSha: tree.baseSha,
        })
      ).code,
    ).toBe("review_required");
    await writeFile(join(source, "source.txt"), "source");
    await git.run(source, ["add", "source.txt"]);
    await git.run(source, ["commit", "-m", "target moves"]);
    expect((await operation(manager, tree, "integrate", input)).code).toBe(
      "stale_preview",
    );
    const fresh = (
      await operation(manager, tree, "integration_preview", {
        targetPath: source,
        targetPlacementId: "target-placement",
      })
    ).preview!;
    expect(fresh).toMatchObject({
      hasCommittedChanges: true,
      baseContainedByTarget: true,
      targetAdvancedFromBase: true,
      alreadyIntegrated: false,
    });
    const integrated = await operation(manager, tree, "integrate", {
      ...input,
      previewId: fresh.id,
    });
    expect(integrated.error).toBe("");
    expect(integrated.integration!.state).toBe("integrated");
    expect(integrated.integration).toMatchObject({
      validationState: "passed",
      validationSummary: "Merge result is clean and contains the reviewed task commit.",
      validatedAt: expect.any(String),
    });
    expect(await readFile(join(source, "task.txt"), "utf8")).toBe("task");
    expect((await operation(manager, tree, "cleanup")).ok).toBe(true);
  });

  it("allows unrelated ignored target output but blocks ignored paths the merge would overwrite", async () => {
    const { manager, source } = await fixture();
    const tree = await allocate(manager, source);
    await writeFile(join(source, "ignored.txt"), "local generated output\n");
    await writeFile(join(tree.path, "task.txt"), "task\n");
    await writeFile(join(tree.path, "ignored.txt"), "task generated output\n");
    await git.run(tree.path, ["add", "task.txt"]);
    await git.run(tree.path, ["commit", "-m", "task"]);
    const preview = (
      await operation(manager, tree, "integration_preview", {
        targetPath: source,
        targetPlacementId: "target-placement",
      })
    ).preview!;
    expect(preview.taskDirty).toBe(false);
    expect(preview.targetDirty).toBe(false);
    const integrated = await operation(manager, tree, "integrate", {
      previewId: preview.id,
      reviewedTaskSha: preview.taskSha,
      reviewedDiffIdentity: preview.diffIdentity,
      confirm: `MERGE ${preview.taskSha} INTO ${preview.targetRef}`,
      commit: true,
    });
    expect(integrated.error).toBe("");
    expect(integrated.integration?.state).toBe("integrated");
    await expect(readFile(join(source, "ignored.txt"), "utf8")).resolves.toBe(
      "local generated output\n",
    );
    await expect(readFile(join(tree.path, "ignored.txt"), "utf8")).resolves.toBe(
      "task generated output\n",
    );

    const collisionFixture = await fixture();
    const collision = await allocate(collisionFixture.manager, collisionFixture.source);
    await writeFile(
      join(collisionFixture.source, "ignored.txt"),
      "local generated output\n",
    );
    await writeFile(join(collision.path, "ignored.txt"), "tracked task output\n");
    await git.run(collision.path, ["add", "-f", "ignored.txt"]);
    await git.run(collision.path, ["commit", "-m", "track ignored path"]);
    const blocked = (
      await operation(collisionFixture.manager, collision, "integration_preview", {
        targetPath: collisionFixture.source,
        targetPlacementId: "target-placement",
      })
    ).preview!;
    expect(blocked.targetDirty).toBe(true);
  });

  it("accepts reviewed merge changes made by explicitly allowed commit hooks", async () => {
    const { manager, source } = await fixture();
    const tree = await allocate(manager, source, { allowGitHooks: true });
    await writeFile(join(tree.path, "task.txt"), "task\n");
    await git.run(tree.path, ["add", "task.txt"]);
    await git.run(tree.path, ["commit", "-m", "task"]);
    const hook = join(source, ".git", "hooks", "pre-commit");
    await writeFile(
      hook,
      "#!/bin/sh\nprintf 'hook output\\n' > hook-output.txt\ngit add hook-output.txt\n",
    );
    await chmod(hook, 0o755);
    const preview = (
      await operation(manager, tree, "integration_preview", {
        targetPath: source,
        targetPlacementId: "target-placement",
      })
    ).preview!;

    const integrated = await operation(manager, tree, "integrate", {
      previewId: preview.id,
      reviewedTaskSha: preview.taskSha,
      reviewedDiffIdentity: preview.diffIdentity,
      confirm: `MERGE ${preview.taskSha} INTO ${preview.targetRef}`,
      commit: true,
    });

    expect(integrated.error).toBe("");
    expect(integrated.integration).toMatchObject({
      state: "integrated",
      validationState: "passed",
    });
    await expect(readFile(join(source, "hook-output.txt"), "utf8")).resolves.toBe(
      "hook output\n",
    );
  });

  it("creates and publishes a task branch from the latest remote main", async () => {
    const { root, manager, source } = await fixture();
    const remote = join(root, "origin.git");
    const upstream = join(root, "upstream");
    await git.run(root, ["init", "--bare", remote]);
    await git.run(source, ["branch", "-M", "main"]);
    await git.run(source, ["remote", "add", "origin", remote]);
    await git.run(source, ["push", "-u", "origin", "main"]);
    await git.run(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await git.run(root, ["clone", remote, upstream]);
    await git.run(upstream, ["config", "user.name", "Fleet Test"]);
    await git.run(upstream, ["config", "user.email", "fleet-test@example.invalid"]);
    await writeFile(join(upstream, "upstream.txt"), "latest main\n");
    await git.run(upstream, ["add", "upstream.txt"]);
    await git.run(upstream, ["commit", "-m", "advance origin main"]);
    await git.run(upstream, ["push", "origin", "main"]);
    const integration = {
      integrationBaseRef: "refs/remotes/origin/main",
      integrationTargetRef: "refs/heads/dev/fleet-test/example-task",
      integrationRemote: "origin",
    };
    const tree = await allocate(manager, source, integration);
    await expect(readFile(join(tree.path, "upstream.txt"), "utf8")).resolves.toBe(
      "latest main\n",
    );
    await writeFile(join(tree.path, "task.txt"), "task\n");
    await git.run(tree.path, ["add", "task.txt"]);
    await git.run(tree.path, ["commit", "-m", "task"]);
    const preview = (
      await operation(manager, tree, "integration_preview", {
        targetPath: source,
        targetPlacementId: "target-placement",
        ...integration,
      })
    ).preview!;
    expect(preview).toMatchObject({
      targetBaseRef: integration.integrationBaseRef,
      targetRef: integration.integrationTargetRef,
      targetRemote: "origin",
    });
    const integrated = await operation(manager, tree, "integrate", {
      previewId: preview.id,
      reviewedTaskSha: preview.taskSha,
      reviewedDiffIdentity: preview.diffIdentity,
      confirm: `MERGE ${preview.taskSha} INTO ${preview.targetRef}`,
      commit: true,
      ...integration,
    });

    expect(integrated.error).toBe("");
    expect(integrated.integration?.state).toBe("integrated");
    expect((await git.run(source, ["symbolic-ref", "-q", "HEAD"])).stdout.trim()).toBe(
      integration.integrationTargetRef,
    );
    expect(
      (
        await git.run(source, [
          "ls-remote",
          "--heads",
          "origin",
          integration.integrationTargetRef,
        ])
      ).stdout.trim(),
    ).toContain(integrated.integration!.resultSha);
  });

  it("reconciles a clean target when an allowed post-commit hook advances it", async () => {
    const { manager, source } = await fixture();
    const tree = await allocate(manager, source, { allowGitHooks: true });
    await writeFile(join(tree.path, "task.txt"), "task\n");
    await git.run(tree.path, ["add", "task.txt"]);
    await git.run(tree.path, ["commit", "-m", "task"]);
    const hook = join(source, ".git", "hooks", "post-commit");
    await writeFile(
      hook,
      [
        "#!/bin/sh",
        'if ! git log -1 --pretty=%s | grep -q "^Post-hook audit$"; then',
        "  git -c core.hooksPath=/dev/null commit --allow-empty -m 'Post-hook audit'",
        "fi",
        "",
      ].join("\n"),
    );
    await chmod(hook, 0o755);
    const preview = (
      await operation(manager, tree, "integration_preview", {
        targetPath: source,
        targetPlacementId: "target-placement",
      })
    ).preview!;
    const attempted = await operation(manager, tree, "integrate", {
      previewId: preview.id,
      reviewedTaskSha: preview.taskSha,
      reviewedDiffIdentity: preview.diffIdentity,
      confirm: `MERGE ${preview.taskSha} INTO ${preview.targetRef}`,
      commit: true,
    });
    expect(attempted.code).toBe("commit_uncertain");

    const reconciled = await operation(manager, tree, "reconcile");

    expect(reconciled.error).toBe("");
    expect(reconciled.worktree).toMatchObject({
      state: "retained",
      integrationState: "integrated",
    });
    expect(
      await git.run(source, ["merge-base", "--is-ancestor", preview.taskSha, "HEAD"], {
        allowedExitCodes: [0, 1],
      }),
    ).toMatchObject({ exitCode: 0 });
  });

  it("records a reviewed no-changes result without claiming the base was already integrated", async () => {
    const { manager, source } = await fixture();
    const tree = await allocate(manager, source);
    const preview = (
      await operation(manager, tree, "integration_preview", {
        targetPath: source,
        targetPlacementId: "target-placement",
      })
    ).preview!;
    expect(preview).toMatchObject({
      taskSha: tree.baseSha,
      hasCommittedChanges: false,
      baseContainedByTarget: true,
      targetAdvancedFromBase: false,
      alreadyIntegrated: false,
    });

    const reviewed = await operation(manager, tree, "integrate", {
      previewId: preview.id,
      reviewedTaskSha: preview.taskSha,
      reviewedDiffIdentity: preview.diffIdentity,
      confirm: `REVIEW NO CHANGES FOR ${preview.taskSha}`,
      commit: true,
    });
    expect(reviewed.integration).toMatchObject({
      state: "no_changes",
      resultSha: preview.targetSha,
      validationState: "passed",
      validationSummary: "No committed task changes require integration.",
    });
    const retained = await operation(manager, reviewed.worktree!, "retain", {
      actor: "bounded-retention",
    });
    expect(retained.worktree).toMatchObject({
      integrationState: "no_changes",
      state: "retained",
      expiresAt: expect.any(String),
      orphanedAt: expect.any(String),
      orphanReason: "The owning task is terminal and no session holds it.",
    });
  });

  it("continues a manually resolved conflict only after explicit confirmation and retains the task", async () => {
    const { manager, source } = await fixture();
    const tree = await allocate(manager, source);
    await writeFile(join(tree.path, "same.txt"), "task\n");
    await git.run(tree.path, ["commit", "-am", "task"]);
    await writeFile(join(source, "same.txt"), "target\n");
    await git.run(source, ["commit", "-am", "target"]);
    const preview = (
      await operation(manager, tree, "integration_preview", {
        targetPath: source,
        targetPlacementId: "target",
      })
    ).preview!;
    const started = await operation(manager, tree, "integrate", {
      previewId: preview.id,
      reviewedTaskSha: preview.taskSha,
      reviewedDiffIdentity: preview.diffIdentity,
      confirm: `MERGE ${preview.taskSha} INTO ${preview.targetRef}`,
    });
    expect(started.integration!.state).toBe("conflicted");
    await writeFile(join(source, "same.txt"), "resolved\n");
    await git.run(source, ["add", "same.txt"]);
    const input = { integrationId: started.integration!.id, commit: true };
    expect((await operation(manager, tree, "continue", input)).code).toBe(
      "confirmation_required",
    );
    const continued = await operation(manager, tree, "continue", {
      ...input,
      confirm: `COMMIT MERGE ${input.integrationId}`,
    });
    expect(continued.error).toBe("");
    expect(continued.integration!.state).toBe("integrated");
    expect(await readFile(join(source, "same.txt"), "utf8")).toBe("resolved\n");
    expect(await readFile(join(tree.path, "same.txt"), "utf8")).toBe("task\n");
    expect((await git.run(source, ["branch", "--show-current"])).stdout.trim()).toBe(
      "target",
    );
    expect((await git.run(source, ["remote"])).stdout.trim()).toBe("");
  });

  it("fails closed on wrong ownership/generation/path and never recreates a manually missing checkout", async () => {
    const { manager, source } = await fixture();
    const tree = await allocate(manager, source);
    expect((await operation(manager, tree, "cleanup", { generation: 2 })).code).toBe(
      "binding_mismatch",
    );
    expect(
      (await operation(manager, tree, "cleanup", { expectedPath: source })).code,
    ).toBe("binding_mismatch");
    expect(
      (await operation(manager, tree, "cleanup", { hostInstallationId: "other" })).code,
    ).toBe("binding_mismatch");
    await rm(tree.path, { recursive: true });
    expect((await operation(manager, tree, "create")).code).toBe("missing");
    expect((await operation(manager, tree, "reconcile")).worktree!.state).not.toBe(
      "ready",
    );
  });
});
