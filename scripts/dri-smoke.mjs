import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixtureProviders } from "../apps/host/dist/server/dri/fixtures.js";

// The CLI module auto-starts outside tests. Import its factory without opening
// the operator's default database/listener, then exercise production behavior.
process.env.NODE_ENV = "test";
const { buildServer } = await import("../apps/host/dist/server/server.js");
process.env.NODE_ENV = "production";
process.env.PORT = "0";
delete process.env.npm_lifecycle_event;

let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
let delayed = false;
const calls = [];
const app = await buildServer({
  databasePath: ":memory:",
  enrollmentToken: "synthetic-loopback-smoke-token",
  operatorPassword: "synthetic-loopback-smoke-password",
  announceClaimCode: () => {},
  useBuiltInEntra: false,
  dri: {
    allowFixtures: true,
    fixtures: fixtureProviders({
      delay: async (context) => {
        calls.push(context.query.capability);
        if (!delayed && context.query.capability === "telemetry.query") {
          delayed = true;
          await gate;
        }
      },
    }),
  },
});
app.log.level = "silent";
try {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const { stdout: html } = await promisify(execFile)(
    process.platform === "win32" ? "curl.exe" : "curl",
    ["--silent", "--show-error", "--fail", "--max-time", "10", address],
    { encoding: "utf8" },
  );
  assert.match(html, /<div id="root"/);
  const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(asset, "Production browser asset is linked");
  const browserAsset = await fetch(`${address}${asset}`);
  assert.equal(browserAsset.status, 200);
  assert.match(await browserAsset.text(), /Create DRI Investigation/);
  assert.equal((await fetch(`${address}/api/dri`)).status, 401);
  const login = await fetch(`${address}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "synthetic-loopback-smoke-password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const csrf = await (
    await fetch(`${address}/api/auth/csrf`, { headers: { cookie } })
  ).json();
  const headers = { cookie, "x-csrf-token": csrf.csrfToken };
  assert.equal(
    (
      await fetch(`${address}/api/dri`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: '{"icm":"42"}',
      })
    ).status,
    403,
  );
  const api = async (path, options = {}) => {
    const response = await fetch(`${address}${path}`, {
      ...options,
      headers: { ...headers, ...options.headers },
    });
    assert.equal(response.ok, true, `HTTP ${response.status} from ${path}`);
    return response.json();
  };
  const created = await api("/api/dri", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"icm":"42","mode":"fixture"}',
  });
  const availability = await api("/api/dri/profiles");
  assert.equal(availability.availability.liveRegistration, "embedding_only");
  assert.equal(availability.availability.liveProvidersConfigured, false);
  const head = async () => (await api(`/api/dri/${created.id}`)).investigation;
  const until = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Fixture smoke deadline exceeded");
  };
  await until(async () =>
    (await api(`/api/dri/${created.id}/queries`)).items.some(
      (query) => query.capability === "telemetry.query" && query.state === "running",
    ),
  );
  const beforeStop = await head();
  assert.equal(beforeStop.profile.profileId, "dms");
  await api(`/api/dri/${created.id}/stop`, {
    method: "POST",
    headers: { "if-match": `"${beforeStop.revision}"` },
  });
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const stopped = await head();
  assert.equal(stopped.status, "stopped");
  await api(`/api/dri/${created.id}/resume`, {
    method: "POST",
    headers: { "if-match": `"${stopped.revision}"` },
  });
  await until(async () =>
    ["awaiting_review", "partial", "failed"].includes((await head()).status),
  );
  const final = await head();
  assert.equal(final.status, "awaiting_review");
  const callCount = calls.length;
  await api(`/api/dri/${created.id}/resume`, {
    method: "POST",
    headers: { "if-match": `"${final.revision}"` },
  });
  assert.equal(calls.length, callCount);
  assert.equal(calls.filter((capability) => capability === "incident.read").length, 2);
  const reports = await api(`/api/dri/${created.id}/reports`);
  assert.equal(reports.items.length, 1);
  assert.ok(reports.items[0].evidenceIds.length);
  await api(`/api/dri/${created.id}/evidence/${reports.items[0].evidenceIds[0]}`);
  assert.equal(
    (await fetch(`${address}/api/runs/${created.runId}`, { method: "DELETE", headers }))
      .status,
    409,
  );
  const evidencePage = await api(`/api/dri/${created.id}/evidence?limit=1`);
  if (evidencePage.nextCursor !== null) {
    const continuation = await api(
      `/api/dri/${created.id}/evidence?limit=1&cursor=${evidencePage.nextCursor}&revision=${evidencePage.revision}&generation=${evidencePage.generation}`,
    );
    assert.notEqual(continuation.items[0].id, evidencePage.items[0].id);
  }
  const backup = await api("/api/backup");
  assert.equal(backup.dri.coverage.state, "complete");
  assert.equal(
    (await api(`/api/dri/${created.id}/similar`)).items.filter(
      (item) => item.match === "strong",
    ).length,
    1,
  );
  assert.equal(
    (await api(`/api/dri/${created.id}/changes`)).items[0].assessment,
    "temporal_only",
  );
  const snapshot = JSON.stringify(await api("/api/snapshot"));
  assert.ok(
    !snapshot.includes("synthetic-not-a-credential") && !snapshot.includes("causalChain"),
  );
  console.log(
    JSON.stringify({
      web: "curl 200",
      browserAsset: 200,
      unauthenticated: 401,
      csrf: 403,
      fixture: "DMS report and citations verified",
      stopResume: "passed",
      completedCallsReplayed: 0,
      genericPurge: 409,
      backupCoverage: "complete",
      liveProviders: "not_tested",
    }),
  );
} finally {
  release();
  await app.close();
}
