import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const CredentialsSchema = z.object({
  hostUrl: z.string().url(),
  nodeId: z.string().min(1),
  secret: z.string().min(1),
  name: z.string().min(1),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

export function configDirectory(): string {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "CopilotFleet",
    );
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "copilot-fleet");
}

export async function loadCredentials(): Promise<Credentials | undefined> {
  try {
    const content = await readFile(join(configDirectory(), "node.json"), "utf8");
    return CredentialsSchema.parse(JSON.parse(content));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  const directory = configDirectory();
  await mkdir(directory, { recursive: true });
  const path = join(directory, "node.json");
  await writeFile(path, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}
