import { X509Certificate } from "node:crypto";
import { CorpDirectConnectionSchema, type CorpDirectConnection } from "@fleet/protocol";
import { createHttpRelay } from "@fleet/protocol/http-relay";

export type CorpDirectForward = { url: string; stop: () => Promise<void> };

export const validateCorpDirectConnection = (value: unknown): CorpDirectConnection => {
  const connection = CorpDirectConnectionSchema.parse(value);
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(connection.caCertificate);
  } catch {
    throw new Error(
      "Corp direct requires a valid public certificate, not a private key or arbitrary PEM text.",
    );
  }
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error(
      "The Corp direct trust certificate is expired or not yet valid. Generate a new command on the Host.",
    );
  }
  return {
    hostUrl: new URL(connection.hostUrl).origin,
    caCertificate: connection.caCertificate,
  };
};

export const corpDirectFromEnv = (
  env: NodeJS.ProcessEnv,
): CorpDirectConnection | undefined => {
  const hostUrl = env.FLEET_CORP_DIRECT_URL;
  const encoded = env.FLEET_HOST_CA;
  if (hostUrl === undefined && encoded === undefined) return undefined;
  if (!hostUrl || !encoded)
    throw new Error(
      "Use --corp-direct and --host-ca together; copy the complete command from the Host.",
    );
  if (
    encoded.length > 24_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    encoded.length % 4 !== 0
  ) {
    throw new Error(
      "--host-ca requires the base64 public certificate from the Host's connect command.",
    );
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded)
    throw new Error("--host-ca is not canonical base64.");
  return validateCorpDirectConnection({
    hostUrl,
    caCertificate: decoded.toString("utf8"),
  });
};

/** All remote HTTP, MCP and WebSocket traffic uses this one verified TLS hop. */
export const startCorpDirectForward = async (
  input: CorpDirectConnection,
): Promise<CorpDirectForward> => {
  const connection = validateCorpDirectConnection(input);
  let localOrigin = "";
  const relay = createHttpRelay({
    upstream: connection.hostUrl,
    caCertificate: connection.caCertificate,
    rewriteHost: true,
    allowPeer: (address) => address === "127.0.0.1" || address === "::ffff:127.0.0.1",
    allowRequest: (request) => {
      if (!localOrigin || request.headers.host !== new URL(localOrigin).host)
        return false;
      const origin = request.headers.origin;
      return origin === undefined || origin === localOrigin;
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      relay.server.once("error", reject);
      relay.server.listen(0, "127.0.0.1", () => {
        relay.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = relay.server.address();
    if (!address || typeof address === "string")
      throw new Error("The Corp direct loopback helper has no TCP address.");
    localOrigin = `http://127.0.0.1:${address.port}`;
    return { url: localOrigin, stop: relay.close };
  } catch (error) {
    await relay.close();
    throw error;
  }
};
