import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureGithubAuth } from "./github-auth.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

type Outcome = {
  code?: number;
  stderr?: string;
  signal?: string;
  error?: string;
  hang?: boolean;
};
const outcomes: Outcome[] = [];
const children: { kill: ReturnType<typeof vi.fn> }[] = [];
const log = vi.fn();
const statusArgs = ["auth", "status", "--active", "--hostname", "github.com"];
const loginArgs = [
  "auth",
  "login",
  "--hostname",
  "github.com",
  "--web",
  "--skip-ssh-key",
];
const expired: Outcome[] = [
  { code: 1 },
  { code: 1, stderr: "gh: Bad credentials (HTTP 401)" },
];

beforeEach(() => {
  outcomes.length = 0;
  children.length = 0;
  log.mockReset();
  spawn.mockReset().mockImplementation(() => {
    const next = outcomes.shift();
    if (!next) throw new Error("Unexpected gh command");
    const child = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    children.push(child);
    if (!next.hang) {
      Promise.resolve().then(() => {
        if (next.error) {
          child.emit(
            "error",
            Object.assign(new Error("private diagnostic"), {
              code: next.error,
            }),
          );
        } else {
          if (next.stderr) child.stderr.write(next.stderr);
          child.emit("close", next.code ?? 0, next.signal);
        }
      });
    }
    return child;
  });
});

afterEach(() => {
  expect(outcomes).toHaveLength(0);
  vi.useRealTimers();
});

const ensure = (options: Parameters<typeof ensureGithubAuth>[0] = {}) =>
  ensureGithubAuth({ env: {}, interactive: true, log, ...options });

describe("GitHub startup authentication", () => {
  it("continues without login for valid credentials and suppresses status output", async () => {
    outcomes.push({});
    await ensure();
    expect(spawn).toHaveBeenCalledExactlyOnceWith("gh", statusArgs, {
      env: { GH_PROMPT_DISABLED: "1" },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    expect(log).not.toHaveBeenCalled();
  });

  it.each(["expired", "missing"])(
    "renews %s authentication in the same terminal and verifies it",
    async (kind) => {
      outcomes.push(...(kind === "expired" ? expired : [{ code: 4 }]), {}, {});
      await ensure();
      expect(spawn).toHaveBeenCalledWith("gh", loginArgs, {
        env: {},
        windowsHide: false,
        stdio: "inherit",
      });
      expect(spawn.mock.calls.at(-1)?.[1]).toEqual(statusArgs);
      expect(log).toHaveBeenLastCalledWith(
        "GitHub authentication verified. Continuing startup...",
      );
    },
  );

  it("recognizes a missing login when auth status exits 1 and the API requires auth", async () => {
    outcomes.push({ code: 1 }, { code: 4 }, {}, {});
    await ensure();
    expect(spawn.mock.calls.filter((call) => call[1][1] === "login")).toHaveLength(1);
  });

  it("accepts an authenticated API probe when an older gh rejects --active", async () => {
    outcomes.push({ code: 1, stderr: "unknown flag: --active" }, {});
    await ensure();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    "error connecting: dial tcp: no such host",
    "gh: API rate limit exceeded (HTTP 403)",
    "gh: service unavailable (HTTP 503)",
  ])(
    "does not confuse an operational failure with expired credentials: %s",
    async (stderr) => {
      outcomes.push({ code: 1 }, { code: 1, stderr });
      await expect(ensure()).rejects.toThrow("authentication check failed");
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("does not bypass a failed status check merely because the API accepts the token", async () => {
    outcomes.push({ code: 1 }, {});
    await expect(ensure()).rejects.toThrow("authentication check failed");
    expect(log).not.toHaveBeenCalled();
  });

  it.each([{ code: 2 }, { signal: "SIGINT" }])(
    "stops when login is cancelled: %j",
    async (outcome) => {
      outcomes.push({ code: 4 }, outcome);
      await expect(ensure()).rejects.toThrow("cancelled");
      expect(spawn).toHaveBeenCalledTimes(2);
    },
  );

  it("stops on login failure without retrying", async () => {
    outcomes.push({ code: 4 }, { code: 1 });
    await expect(ensure()).rejects.toThrow("GitHub login failed");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("does not loop if verification after login still fails", async () => {
    outcomes.push({ code: 4 }, {}, ...expired);
    await expect(ensure()).rejects.toThrow("not authenticated");
    expect(spawn.mock.calls.filter((call) => call[1][1] === "login")).toHaveLength(1);
    expect(log).not.toHaveBeenCalledWith(
      "GitHub authentication verified. Continuing startup...",
    );
  });

  it.each([{ interactive: false }, { env: { GH_PROMPT_DISABLED: "1" } }])(
    "does not prompt during unattended startup: %j",
    async (options) => {
      outcomes.push(...expired);
      await expect(ensure(options)).rejects.toThrow(
        "gh auth login --hostname github.com",
      );
      expect(log).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["github.com", "GH_TOKEN"],
    ["github.com", "GITHUB_TOKEN"],
    ["company.ghe.com", "GH_TOKEN"],
    ["github.example.com", "GH_ENTERPRISE_TOKEN"],
    ["github.example.com", "GITHUB_ENTERPRISE_TOKEN"],
  ])("explains an invalid %s token override without exposing %s", async (host, key) => {
    outcomes.push(...expired);
    const env = { GH_HOST: host, [key]: "private-token-value" };
    const failure = ensure({ env });
    await expect(failure).rejects.toThrow(`Replace or unset ${key}`);
    await expect(failure).rejects.not.toThrow("private-token-value");
    expect(env[key]).toBe("private-token-value");
    expect(log).not.toHaveBeenCalled();
  });

  it("preserves the selected hostname and credential directory for login and verification", async () => {
    outcomes.push({ code: 4 }, {}, {});
    const env = { GH_HOST: "github.example.com", GH_CONFIG_DIR: "custom-profile" };
    await ensure({ env });
    for (const [, args, options] of spawn.mock.calls) {
      expect(args[args.indexOf("--hostname") + 1]).toBe("github.example.com");
      expect(options.env.GH_CONFIG_DIR).toBe("custom-profile");
    }
  });

  it.each(["ENOENT", "EACCES"])(
    "reports executable failures without retrying or leaking diagnostics: %s",
    async (error) => {
      outcomes.push({ error });
      const failure = ensure();
      await expect(failure).rejects.toThrow(
        error === "ENOENT" ? "Install gh" : "installation and permissions",
      );
      await expect(failure).rejects.not.toThrow("private diagnostic");
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds a hung check and terminates only its own child", async () => {
    vi.useFakeTimers();
    outcomes.push({ hang: true });
    const failure = expect(ensure()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(children[0]?.kill).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });

  it("does not include status diagnostics in failures", async () => {
    outcomes.push({ code: 1, stderr: "private-token-value" }, { code: 1 });
    await expect(ensure()).rejects.not.toThrow("private-token-value");
  });

  it("rejects a URL or control characters in GH_HOST before invoking gh", async () => {
    await expect(ensure({ env: { GH_HOST: "https://github.com\n" } })).rejects.toThrow(
      "GH_HOST must be a GitHub hostname",
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
