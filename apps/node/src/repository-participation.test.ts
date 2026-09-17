import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalPath } from "./canonical-path.js";
import {
  RepositoryParticipation,
  type RepositoryTarget,
} from "./repository-participation.js";
import { CheckoutLocks } from "./checkout-locks.js";
import { CommandRouter } from "./router.js";
import { NodeAdmission } from "./node-admission.js";
import { GitRunner } from "./git-runner.js";
import type { AgentFactory, StartAgentOptions } from "./agents.js";
import type { SessionEvent } from "@fleet/protocol";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
async function repository() {
  const directory = resolve(`.repository-participation-test-${randomUUID()}`);
  directories.push(directory);
  mkdirSync(directory);
  const cwd = join(directory, "checkout");
  const common = join(cwd, ".git");
  mkdirSync(common, { recursive: true });
  const checkout = await canonicalPath(cwd);
  const repository = await canonicalPath(common);
  const target: RepositoryTarget = { cwd, checkout, repository, git: true };
  const resolver = async (_path: string) => target;
  return {
    directory,
    target,
    first: new RepositoryParticipation(resolver),
    second: new RepositoryParticipation(resolver),
  };
}

describe("shared cross-installation participation", () => {
  it("rejects a second installation targeting the shared Git metadata directory or its alias", async () => {
    const f = await repository();
    await new GitRunner().run(f.target.cwd, ["-c", "init.templateDir=", "init"]);
    const first = new RepositoryParticipation();
    const second = new RepositoryParticipation();
    const target = await first.resolve(f.target.cwd);
    expect(target.repository.key).toBe(
      (await canonicalPath(f.target.repository.path)).key,
    );
    await first.activate([f.target.cwd], true);
    const shared = await first.participate([f.target.cwd], "installation-one-session");
    const alias = join(f.directory, "metadata-alias");
    symlinkSync(
      target.repository.path,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      for (const metadata of [target.repository.path, alias]) {
        await expect(second.activate([metadata], true)).rejects.toThrow(
          "working directory",
        );
        await expect(
          second.participate([metadata], "installation-two-session"),
        ).rejects.toThrow("working directory");
      }
      expect(existsSync(join(target.repository.path, ".fleet-participation-v1"))).toBe(
        false,
      );
      expect(
        existsSync(
          join(target.repository.path, "fleet-participation-v1", "participation.db"),
        ),
      ).toBe(true);
      await expect(
        second.acquire(
          [await second.resolve(f.target.cwd)],
          "installation-two-command",
          "exclusive",
          true,
        ),
      ).rejects.toThrow("participation");
    } finally {
      for (const lease of shared.leases) lease.release();
    }
    const exclusive = await second.acquire(
      [await second.resolve(f.target.cwd)],
      "installation-two-command",
      "exclusive",
      true,
    );
    for (const lease of exclusive) lease.release();
  });

  it("tracks unbound/read-only aliases and excludes commands in both directions without changing non-opted rules", async () => {
    const f = await repository();
    const legacy = await f.first.participate([f.target.cwd], "old-session");
    expect(legacy.supervised).toBe(false);
    await expect(f.second.activate([f.target.cwd], true)).rejects.toThrow("drain");
    legacy.leases[0]!.release();
    await f.first.activate([f.target.cwd], true);
    const shared = await f.first.participate(
      [f.target.cwd, f.target.cwd],
      "unbound-read-only",
    );
    const other = await f.second.participate([f.target.cwd], "alias-session");
    expect(shared.leases).toHaveLength(1);
    expect(shared.supervised).toBe(true);
    await expect(
      f.second.acquire([f.target], "command", "exclusive", true),
    ).rejects.toThrow("participation");
    for (const lease of [...shared.leases, ...other.leases]) lease.release();
    const command = await f.second.acquire([f.target], "command", "exclusive", true);
    await expect(f.first.participate([f.target.cwd], "racing-session")).rejects.toThrow(
      "participation",
    );
    command[0]!.release();
  });

  it("does not release tracked process ownership on age/PID assumptions", async () => {
    const f = await repository();
    await f.first.activate([f.target.cwd], true);
    const { leases } = await f.first.participate([f.target.cwd], "session");
    leases[0]!.processPending();
    leases[0]!.processStarted(99999999);
    expect(() => leases[0]!.release()).toThrow("quiescence");
    await expect(
      f.second.acquire([f.target], "command", "exclusive", true),
    ).rejects.toThrow();
    leases[0]!.processesQuiesced();
    leases[0]!.release();
  });

  it("refuses activation for known existing managed ownership and requires explicit deployment attestation", async () => {
    const f = await repository();
    await expect(f.first.activate([f.target.cwd], false)).rejects.toThrow("confirm");
    const locks = new CheckoutLocks();
    locks.bindScope(f.target.checkout, f.target.repository);
    const lease = locks.acquire(f.target.checkout, {
      owner: "old-installation",
      attempt: "attempt",
      kind: "worker",
    });
    await expect(f.second.activate([f.target.cwd], true)).rejects.toThrow("ownership");
    lease.release();
    await f.second.activate([f.target.cwd], true);
  });

  it("makes resumed unbound sessions participate in opted additional roots through junction aliases", async () => {
    const f = await repository();
    const plain = join(f.directory, "plain");
    const alias = join(f.directory, "alias");
    mkdirSync(plain);
    symlinkSync(f.target.cwd, alias, process.platform === "win32" ? "junction" : "dir");
    const plainIdentity = await canonicalPath(plain);
    const resolver = async (path: string): Promise<RepositoryTarget> => {
      const identity = await canonicalPath(path);
      return identity.key === f.target.checkout.key
        ? f.target
        : {
            cwd: identity.path,
            checkout: plainIdentity,
            repository: plainIdentity,
            git: false,
          };
    };
    const repositories = new RepositoryParticipation(resolver);
    await repositories.activate([alias], true);
    let ownership: StartAgentOptions | undefined;
    let sequence = 0;
    let sink!: (event: SessionEvent) => void;
    const start = vi.fn<AgentFactory["start"]>(async (sessionId, _cwd, emit, options) => {
      ownership = options;
      sink = emit;
      options?.processStarting?.();
      options?.processStarted?.(12345678);
      emit({
        eventId: "native",
        sessionId,
        sequence: ++sequence,
        type: "agent_session",
        payload: { agentSessionId: "native" },
        createdAt: new Date().toISOString(),
      });
      return {
        busy: false,
        prompt: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          options?.processesQuiesced?.();
        }),
        resync: vi.fn(),
        resolvePermission: vi.fn(),
        denyPendingPermissions: vi.fn(),
        setConfigOption: vi.fn(async () => {}),
      };
    });
    const gate = new NodeAdmission();
    const router = new CommandRouter(
      { start },
      4,
      () => {},
      async (path) => (await canonicalPath(path)).path,
      () => "",
      async () => [],
      () => {},
      { repositories, admission: gate },
    );
    const admitted = await router.route({
      type: "resume_session",
      commandId: "resume",
      sessionId: "source",
      agentSessionId: "native",
      localPath: plain,
      additionalDirectories: [alias],
      sequenceOffset: 0,
      readOnly: true,
      yolo: false,
      agent: "",
      mcpServers: [],
      config: [],
    });
    expect(admitted.ok).toBe(true);
    expect(ownership?.processesQuiesced).toBeTypeOf("function");
    await expect(
      f.second.acquire([f.target], "command", "exclusive", true),
    ).rejects.toThrow();
    sink({
      eventId: "terminal",
      sessionId: "source",
      sequence: ++sequence,
      type: "state",
      payload: { state: "completed" },
      createdAt: new Date().toISOString(),
    });
    await router.stopAll();
    expect(gate.active).toEqual([]);
    const exclusive = await f.second.acquire([f.target], "command", "exclusive", true);
    exclusive[0]!.release();
  });
});
