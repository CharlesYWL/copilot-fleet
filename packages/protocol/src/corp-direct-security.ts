import { z } from "zod";
import {
  CorpDirectConfigSchema,
  PrivateIpv4Schema,
  PublicCaCertificateSchema,
} from "./corp-direct.js";

/** Private TLS authority: only for protected Host storage and the encrypted envelope. */
export const CorpDirectMaterialSchema = z.object({
  hostId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/),
  hostIp: PrivateIpv4Schema,
  authorityPfx: z.string().min(1).max(131072),
  caCertificate: PublicCaCertificateSchema,
  serverPfx: z.string().min(1).max(131072),
  serverExpiresAt: z.string().datetime(),
  caExpiresAt: z.string().datetime(),
});
export type CorpDirectMaterial = z.infer<typeof CorpDirectMaterialSchema>;
export const CorpDirectSecuritySchema = z.object({
  configuration: CorpDirectConfigSchema,
  material: CorpDirectMaterialSchema.optional(),
  initialized: z.boolean().default(false),
});
