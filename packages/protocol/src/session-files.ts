import { z } from "zod";

/**
 * A Node that reads a session's files for the Host over its sealed connection.
 *
 * Gated like every other new frame: a Node closes the connection on a message
 * type it does not know, so `session_file_read` is sent only to Nodes that
 * advertise this, and only over a mutually authenticated channel.
 */
export const SESSION_FILES_CAPABILITY = "session-files-v1";

/**
 * Bytes per read. The Host keeps a small window of these in flight, so a
 * download shares the Node's socket with session events instead of queueing a
 * whole file in front of them.
 */
export const SESSION_FILE_CHUNK_BYTES = 256 * 1024;

/**
 * The largest file the Host relays. Every byte crosses the Node's WebSocket
 * base64-encoded, so anything bigger is better copied off the machine directly.
 */
export const SESSION_FILE_MAX_BYTES = 512 * 1024 * 1024;

export const SESSION_FILE_PATH_MAX_LENGTH = 4096;

const filePath = z
  .string()
  .min(1)
  .max(SESSION_FILE_PATH_MAX_LENGTH)
  .refine((value) => !value.includes("\0"), "Paths cannot contain NUL");

/**
 * One read of one file on the machine that ran a session.
 *
 * Stateless on purpose: every read names the file again and is checked again,
 * so nothing is left open on the Node when a browser walks away mid-download,
 * and `version` makes a file that changed between reads fail instead of
 * arriving spliced from two different contents.
 */
export const SessionFileReadRequestSchema = z.object({
  requestId: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  /** As the operator gave it: absolute, or relative to the working directory. */
  path: filePath,
  /** The session's working directory first, then its additional roots. */
  roots: z.array(filePath).max(101).default([]),
  /** Host-owned directories no download may reach into, such as its own data. */
  protectedRoots: z.array(filePath).max(16).default([]),
  /** Lets the Node add the session's own Copilot state folder. */
  agentSessionId: z.string().max(128).default(""),
  /** Lets the Node add the scratch directory an orchestrator starts in. */
  coordinator: z.boolean().default(false),
  offset: z.number().int().nonnegative().max(SESSION_FILE_MAX_BYTES),
  /** Zero reads nothing and only reports what the file is. */
  length: z.number().int().nonnegative().max(SESSION_FILE_CHUNK_BYTES),
  /** What the first read reported; later reads fail if the file changed. */
  version: z.string().max(200).default(""),
});
export type SessionFileReadRequest = z.infer<typeof SessionFileReadRequestSchema>;

export const sessionFileErrorCodes = [
  "invalid",
  "not_found",
  "not_a_file",
  "forbidden",
  "too_large",
  "changed",
  "busy",
  "unavailable",
] as const;
export const SessionFileErrorCodeSchema = z.enum(sessionFileErrorCodes);
export type SessionFileErrorCode = z.infer<typeof SessionFileErrorCodeSchema>;

export const SessionFileReadResultSchema = z.discriminatedUnion("ok", [
  z.object({
    requestId: z.string().uuid(),
    ok: z.literal(true),
    /** The file actually read, with links resolved: what later reads name. */
    path: filePath,
    name: z.string().min(1).max(1024),
    size: z.number().int().nonnegative().max(SESSION_FILE_MAX_BYTES),
    modifiedAt: z.string().datetime(),
    version: z.string().min(1).max(200),
    offset: z.number().int().nonnegative(),
    data: z.string().max(Math.ceil(SESSION_FILE_CHUNK_BYTES / 3) * 4),
  }),
  z.object({
    requestId: z.string().uuid(),
    ok: z.literal(false),
    code: SessionFileErrorCodeSchema,
    error: z.string().max(2000),
  }),
]);
export type SessionFileReadResult = z.infer<typeof SessionFileReadResultSchema>;

/** What the browser is told about a file before it asks for the bytes. */
export const SessionFileInfoSchema = z.object({
  path: filePath,
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime(),
});
export type SessionFileInfo = z.infer<typeof SessionFileInfoSchema>;
