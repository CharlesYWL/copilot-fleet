import { z } from "zod";

export const HostMcpSelectionSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    enabled: z.boolean(),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type HostMcpSelection = z.infer<typeof HostMcpSelectionSchema>;

/** Credential-free projection of Host-owned configuration. */
export type HostMcpSettings = {
  revision: string;
  suspended: boolean;
  catalogError?: string;
  servers: {
    name: string;
    transport: "http" | "sse" | "stdio";
    sourceDigest?: string;
    enabled: boolean;
    allNodes: boolean;
    toolCount: number;
    readOnly: boolean;
    unavailable?: string;
  }[];
};
