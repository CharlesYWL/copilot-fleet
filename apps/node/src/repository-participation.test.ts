import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalPath } from "./canonical-path.js";
import {
  RepositoryParticipation,
  type RepositoryTarget,
} from "./repository-participation.js";
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
  it("allows ordinary commands alongside sessions in both directions, but never through maintenance", async () => {
    const f = await repository();
    const sessions = await f.first.participate([f.target.cwd], "session:existing");
    const commands = await f.second.acquire([f.target], "command:probe", "command");
    const later = await f.first.participate([f.target.cwd], "session:later");
    try {
      await commands[0]!.revalidate();
      await sessions.leases[0]!.revalidate();
      await expect(
        f.first.acquire([f.target], "maintenance", "exclusive"),
      ).rejects.toThrow("Checkout busy");
    } finally {
      for (const lease of [...later.leases, ...sessions.leases, ...commands])
        lease.release();
    }
    const maintenance = await f.first.acquire([f.target], "maintenance", "exclusive");
    try {
      await expect(
        f.second.acquire([f.target], "command:probe", "command"),
      ).rejects.toThrow("Checkout busy");
    } finally {
      maintenance[0]!.release();
    }
  });

  it("does not let legacy untracked session markers block ordinary commands or delete them", async () => {
    const f = await repository();
    const legacy = await f.first.participate([f.target.cwd], "session:legacy");
    const db = new DatabaseSync(
      join(f.target.repository.path, "fleet-participation-v1", "participation.db"),
    );
    try {
      db.prepare(
        "UPDATE participants SET data=json_set(data,'$.tracked',json('false'))",
      ).run();
      const before = db.prepare("SELECT data FROM participants").get()!.data;
      const command = await f.second.acquire([f.target], "command:probe", "command");
      try {
        expect(
          db
            .prepare(
              "SELECT data FROM participants WHERE json_extract(data,'$.owner')='session:legacy'",
            )
            .get()!.data,
        ).toBe(before);
        await expect(
          f.first.acquire([f.target], "managed command", "exclusive"),
        ).rejects.toThrow();
        await command[0]!.revalidate();
      } finally {
        command[0]!.release();
      }
      expect(db.prepare("SELECT data FROM participants").get()!.data).toBe(before);
    } finally {
      db.close();
      legacy.leases[0]!.release();
    }
  });

  it("continues to block explicitly unresolved process ownership and requires quiescence to release commands", async () => {
    const f = await repository();
    const command = await f.first.acquire([f.target], "command:unknown", "command");
    command[0]!.processStarted(12345);
    command[0]!.requireReconciliation("Unverified command descendants");
    try {
      expect(() => command[0]!.release()).toThrow("quiescence");
      await expect(
        f.second.acquire([f.target], "command:next", "command"),
      ).rejects.toThrow("Checkout busy");
    } finally {
      command[0]!.processesQuiesced();
      command[0]!.release();
    }
  });

  it("keeps sessions in unrelated repositories concurrent with an exclusive command", async () => {
    const commandRepository = await repository();
    const sessionRepository = await repository();
    const command = await commandRepository.first.acquire(
      [commandRepository.target],
      "command:one",
      "exclusive",
    );
    const sessions = await sessionRepository.second.participate(
      [sessionRepository.target.cwd],
      "unrelated-session",
    );
    try {
      await command[0]!.revalidate();
      await sessions.leases[0]!.revalidate();
    } finally {
      command[0]!.release();
      sessions.leases[0]!.release();
    }
  });
  // Even after removing six redundant probes, 13 real Git processes take about
  // five seconds on Windows. This is not an in-memory participation unit test.
  it("rejects a second installation targeting the shared Git metadata directory or its alias", async () => {
    const f = await repository();
    await new GitRunner().run(f.target.cwd, ["-c", "init.templateDir=", "init"]);
    const first = new RepositoryParticipation();
    const second = new RepositoryParticipation();
    const target = await first.resolve(f.target.cwd);
    expect(target.repository.key).toBe(
      (await canonicalPath(f.target.repository.path)).key,
    );
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
        second.acquire([target], "installation-two-command", "exclusive", true),
      ).rejects.toThrow("participation");
    } finally {
      for (const lease of shared.leases) lease.release();
    }
    const exclusive = await second.acquire(
      [target],
      "installation-two-command",
      "exclusive",
      true,
    );
    for (const lease of exclusive) lease.release();
  }, 15_000);

  it("automatically tracks unbound/read-only aliases and excludes commands in both directions", async () => {
    const f = await repository();
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

  it("does not require activation or erase existing leases when an older caller activates", async () => {
    const f = await repository();
    const { leases } = await f.first.participate([f.target.cwd], "session");
    await f.second.activate([f.target.cwd], false);
    await expect(f.second.acquire([f.target], "command", "exclusive")).rejects.toThrow(
      "Checkout busy",
    );
    leases[0]!.release();
  });

  it("automatically makes resumed sessions participate in additional roots through junction aliases", async () => {
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
