import { spawn } from "node:child_process";

type GhResult = { code: number | null; stderr: string };

function runGh(
  args: string[],
  env: NodeJS.ProcessEnv,
  interactive = false,
): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      env: interactive ? env : { ...env, GH_PROMPT_DISABLED: "1" },
      windowsHide: !interactive,
      stdio: interactive ? "inherit" : ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    // Inspect only a bounded diagnostic tail; never log or persist CLI output.
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    const timer = interactive
      ? undefined
      : setTimeout(() => {
          reject(
            new Error(
              "GitHub authentication check timed out. Check connectivity and retry startup.",
            ),
          );
          child.kill();
        }, 30_000);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new Error(
          error.code === "ENOENT"
            ? "GitHub CLI was not found. Install gh and ensure it is on PATH."
            : "Could not start GitHub CLI. Check its installation and permissions.",
        ),
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (signal || code === 2) {
        reject(new Error("GitHub authentication was cancelled; startup was stopped."));
      } else resolve({ code, stderr });
    });
  });
}

class GithubAuthRequiredError extends Error {
  constructor(host: string) {
    super(
      `GitHub CLI is not authenticated for ${host}. Run gh auth login --hostname ${host} with this account, then retry startup.`,
    );
  }
}

function githubHost(env: NodeJS.ProcessEnv): string {
  const host = env.GH_HOST || "github.com";
  if (!/^[a-z\d][a-z\d.-]*(?::\d+)?$/i.test(host)) {
    throw new Error("GH_HOST must be a GitHub hostname, not a URL.");
  }
  return host;
}

async function checkGithubAuth(env: NodeJS.ProcessEnv, host: string): Promise<void> {
  const status = await runGh(["auth", "status", "--active", "--hostname", host], env);
  if (status.code === 0) return;
  if (status.code === 4) throw new GithubAuthRequiredError(host);

  // `auth status` uses exit 1 for both invalid credentials and network errors.
  // Older gh versions do not support `--active`; a successful API probe is the
  // equivalent authentication proof only for that explicitly detected case.
  const activeFlagUnsupported =
    status.code === 1 && /unknown flag:\s*--active\b/i.test(status.stderr);
  const probe = await runGh(["api", "user", "--hostname", host, "--silent"], env);
  if (activeFlagUnsupported && probe.code === 0) return;
  if (probe.code === 4 || (probe.code !== 0 && /\bHTTP 401\b/i.test(probe.stderr))) {
    throw new GithubAuthRequiredError(host);
  }
  throw new Error(
    `GitHub authentication check failed (exit ${status.code ?? "unknown"}). Run gh auth status --active --hostname ${host} to inspect it.`,
  );
}

export async function ensureGithubAuth({
  env = process.env,
  interactive = process.stdin.isTTY === true && process.stdout.isTTY === true,
  log = console.log,
}: {
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  log?: (message: string) => void;
} = {}): Promise<void> {
  const host = githubHost(env);
  try {
    await checkGithubAuth(env, host);
    return;
  } catch (error) {
    if (!(error instanceof GithubAuthRequiredError)) throw error;
    const keys =
      host.toLowerCase() === "github.com" || host.toLowerCase().endsWith(".ghe.com")
        ? ["GH_TOKEN", "GITHUB_TOKEN"]
        : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
    const tokenVariable = keys.find((key) => env[key]);
    if (tokenVariable) {
      throw new Error(
        `${tokenVariable} supplies an invalid GitHub credential and overrides saved login. Replace or unset ${tokenVariable}, then retry startup; browser login cannot override it.`,
        { cause: error },
      );
    }
    if (!interactive || env.GH_PROMPT_DISABLED) throw error;
  }

  log(`GitHub authentication for ${host} needs renewal. Signing in in this terminal...`);
  const login = await runGh(
    ["auth", "login", "--hostname", host, "--web", "--skip-ssh-key"],
    env,
    true,
  );
  if (login.code !== 0) {
    throw new Error(
      `GitHub login failed (exit ${login.code ?? "unknown"}); startup was stopped.`,
    );
  }
  await checkGithubAuth(env, host);
  log("GitHub authentication verified. Continuing startup...");
}
