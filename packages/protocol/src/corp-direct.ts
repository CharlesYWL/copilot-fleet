import { z } from "zod";

const ipv4Number = (value: string): number | undefined => {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return undefined;
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 255)) return undefined;
  return parts.reduce((address, part) => address * 256 + part, 0);
};

const privateNumber = (value: number): boolean =>
  (value >= 0x0a000000 && value <= 0x0affffff) ||
  (value >= 0xac100000 && value <= 0xac1fffff) ||
  (value >= 0xc0a80000 && value <= 0xc0a8ffff);

export const isPrivateIpv4 = (value: string): boolean => {
  const address = ipv4Number(value);
  return address !== undefined && privateNumber(address);
};

export const PrivateIpv4Schema = z
  .string()
  .trim()
  .refine(isPrivateIpv4, "Choose an RFC1918 private IPv4 address");
export const PublicCaCertificateSchema = z
  .string()
  .max(16_384)
  .refine(
    (value) =>
      /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\s*$/.test(
        value,
      ),
    "Expected one public CA certificate in PEM format",
  );

/** Old allowedSources fields are stripped, including from persisted backups. */
export const CorpDirectConfigSchema = z.object({
  hostIp: PrivateIpv4Schema,
  port: z.number().int().min(1).max(65535).default(8787),
});
export type CorpDirectConfig = z.infer<typeof CorpDirectConfigSchema>;

export const isCorpDirectUrl = (value: string): boolean => {
  // Keep the wire value canonical enough to paste safely into PowerShell/bash.
  const match = /^https:\/\/((?:\d{1,3}\.){3}\d{1,3})(?::([1-9]\d{0,4}))?\/?$/.exec(
    value,
  );
  if (!match || !isPrivateIpv4(match[1]!) || (match[2] && Number(match[2]) > 65535))
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      isPrivateIpv4(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
};

export const CorpDirectConnectionSchema = z.object({
  hostUrl: z
    .string()
    .max(2048)
    .refine(isCorpDirectUrl, "Corp direct requires an HTTPS private-IP origin"),
  caCertificate: PublicCaCertificateSchema,
});
export type CorpDirectConnection = z.infer<typeof CorpDirectConnectionSchema>;

export const CorpDirectInfoSchema = z.object({
  supported: z.boolean(),
  canManage: z.boolean().optional(),
  addresses: z.array(PrivateIpv4Schema),
  configuration: CorpDirectConfigSchema.nullable(),
  caCertificate: PublicCaCertificateSchema.optional(),
  firewallCommand: z.string().optional(),
});
export type CorpDirectInfo = z.infer<typeof CorpDirectInfoSchema>;
