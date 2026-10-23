import net from "node:net";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkCorpDirectHost,
  describeCorpDirectDiagnosis,
  diagnoseCorpDirectFailure,
  type CorpDirectDiagnosis,
} from "./corp-direct-diagnosis.js";

const servers: net.Server[] = [];

/** A real listener on 127.0.0.1 that accepts and drops every connection. */
const listen = async (): Promise<number> => {
  const server = net.createServer((socket) => socket.destroy());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
};

/** A port that was just free and has nothing listening on it now. */
const closedPort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("diagnoseCorpDirectFailure", () => {
  it("reports a stopped Host when the machine refuses the Fleet port", async () => {
    const port = await closedPort();
    const result = await diagnoseCorpDirectFailure(`https://127.0.0.1:${port}`);
    expect(result.diagnosis).toBe("host-not-running");
    expect(result.detail).toContain(String(port));
  });

  it("blames the handshake when the Fleet port accepts and unused ports refuse", async () => {
    const port = await listen();
    const probePorts = [await closedPort(), await closedPort()];
    const result = await diagnoseCorpDirectFailure(`https://127.0.0.1:${port}`, {
      probePorts,
    });
    expect(result.diagnosis).toBe("handshake-failed");
  });

  it("blames the handshake when only one unused port happens to accept", async () => {
    const port = await listen();
    const probePorts = [await listen(), await closedPort()];
    const result = await diagnoseCorpDirectFailure(`https://127.0.0.1:${port}`, {
      probePorts,
    });
    expect(result.diagnosis).toBe("handshake-failed");
  });

  it("detects a device answering for the Host when unused ports also accept", async () => {
    const port = await listen();
    const probePorts = [await listen(), await listen()];
    const result = await diagnoseCorpDirectFailure(`https://127.0.0.1:${port}`, {
      probePorts,
    });
    expect(result.diagnosis).toBe("network-intercepted");
    for (const probe of probePorts) expect(result.detail).toContain(`${probe} accepted`);
  });

  it("reports an unreachable Host when the Fleet port never answers", async () => {
    const sockets: EventEmitter[] = [];
    const result = await diagnoseCorpDirectFailure("https://10.0.5.136:8787", {
      timeoutMs: 20,
      connect: () => {
        const socket = Object.assign(new EventEmitter(), {
          destroyed: false,
          destroy() {
            this.destroyed = true;
            return this;
          },
        });
        sockets.push(socket);
        return socket as unknown as net.Socket;
      },
    });
    expect(result).toEqual({
      diagnosis: "host-unreachable",
      detail: "port 8787: ETIMEDOUT",
    });
    // A probe that times out must not leave its socket open.
    expect(
      sockets.every((socket) => (socket as never as { destroyed: boolean }).destroyed),
    ).toBe(true);
  });

  it("never probes the Fleet port as an unused port", async () => {
    const dialed: number[] = [];
    await diagnoseCorpDirectFailure("https://10.0.5.136:8787", {
      timeoutMs: 20,
      probePorts: [8787, 50_000],
      connect: (options) => {
        dialed.push((options as net.TcpNetConnectOpts).port);
        const socket = new EventEmitter() as net.Socket;
        socket.destroy = () => socket;
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    });
    expect(dialed).toEqual([8787, 50_000]);
  });
});

describe("describeCorpDirectDiagnosis", () => {
  const hostUrl = "https://10.0.5.136:8787";
  const cases: [CorpDirectDiagnosis, RegExp][] = [
    ["host-not-running", /Start the Fleet Host/],
    ["host-unreachable", /stopped or hibernating/],
    ["network-intercepted", /different Dev Box regions/],
    ["handshake-failed", /certificate/],
  ];

  it.each(cases)("explains %s and names the Host's address", (diagnosis, advice) => {
    const message = describeCorpDirectDiagnosis(hostUrl, {
      diagnosis,
      detail: "evidence",
    });
    expect(message).toContain("10.0.5.136");
    expect(message).toMatch(advice);
  });

  it("shapes a check for the Node's status", async () => {
    const port = await closedPort();
    const problem = await checkCorpDirectHost(`https://127.0.0.1:${port}`);
    expect(problem).toMatchObject({
      kind: "host-not-running",
      summary: "Host is not running",
    });
    expect(problem.message).toContain(`port ${port}`);
    expect(Date.parse(problem.checkedAt)).not.toBeNaN();
  });
});
