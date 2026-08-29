import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MUTUAL_AUTH_PROTOCOL } from "@fleet/protocol";

/**
 * The Host this Node has pinned.
 *
 * Stored rather than re-fetched because that is the whole point: a fingerprint
 * looked up from the endpoint being authenticated proves nothing. This copy was
 * written at enrolment, from the Connect card, and is what every later
 * connection is checked against.
 */
const PinnedHostSchema = z.object({
  hostId: z.string().min(1),
  publicKey: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PinnedHost = z.infer<typeof PinnedHostSchema>;

const sharedCredentialFields = {
  hostUrl: z.string().url(),
  nodeId: z.string().min(1),
  name: z.string().min(1),
};

/**
 * What this machine authenticates with, as a discriminated union.
 *
 * A union rather than a bag of optional fields, so that reading the private key
 * requires having established which protocol this Node speaks. The alternative
 * — optional `secret` and optional `privateKey` — makes every use site a cast
 * or a non-null assertion, and one of them would eventually be wrong on a Node
 * that has only one of the two.
 */
const CredentialsSchema = z.discriminatedUnion("authProtocol", [
  z.object({
    ...sharedCredentialFields,
    /** Defaulted, so a `node.json` written before Node keys existed still reads. */
    authProtocol: z.literal("legacy-secret"),
    secret: z.string().min(1),
  }),
  z.object({
    ...sharedCredentialFields,
    authProtocol: z.literal(MUTUAL_AUTH_PROTOCOL),
    /** Base64 PKCS8 DER. The only copy; nothing can re-issue it. */
    privateKey: z.string().min(1),
    publicKey: z.string().min(1),
    host: PinnedHostSchema,
  }),
]);
export type Credentials = z.infer<typeof CredentialsSchema>;

/** The half of a key-based identity a Node proves itself with. */
export type KeyedCredentials = Extract<
  Credentials,
  { authProtocol: typeof MUTUAL_AUTH_PROTOCOL }
>;

export function configDirectory(): string {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "CopilotFleet",
    );
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "copilot-fleet");
}

/**
 * Reads the identity, filling in the protocol a file written before it existed
 * would not have named.
 *
 * The default is applied here rather than in the schema because a discriminated
 * union has to know its discriminant before it can pick a member, and every
 * such file is by construction a shared-secret one.
 */
export function parseCredentials(value: unknown): Credentials {
  const record = value as Record<string, unknown>;
  const withProtocol =
    record && typeof record === "object" && !record.authProtocol
      ? { ...record, authProtocol: "legacy-secret" }
      : record;
  return CredentialsSchema.parse(withProtocol);
}

/** The same shape the archive format carries, so both readers agree. */
export const NodeCredentialsSchema = CredentialsSchema;

export async function loadCredentials(): Promise<Credentials | undefined> {
  let content: string;
  try {
    content = await readFile(join(configDirectory(), "node.json"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
  // Outside the catch on purpose: a malformed identity is not a missing one,
  // and a Node that quietly re-enrolled on a bad parse would abandon its
  // placements and sessions rather than say what was wrong.
  return parseCredentials(JSON.parse(content));
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  const directory = configDirectory();
  await mkdir(directory, { recursive: true });
  const path = join(directory, "node.json");
  // The file now holds a private key rather than a secret the Host also has,
  // so the mode is the difference between this machine owning its identity and
  // sharing it with every account on the box.
  await writeFile(path, JSON.stringify(CredentialsSchema.parse(credentials), null, 2), {
    mode: 0o600,
  });
  if (process.platform !== "win32") await chmod(path, 0o600);
}
