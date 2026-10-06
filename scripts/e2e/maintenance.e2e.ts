import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { expect, it } from "vitest";
import { OPERATOR_COOKIE } from "../../apps/host/src/auth.js";
import { FleetAuth, AUTH_MODE_SETTING } from "../../apps/host/src/auth/service.js";
import { FleetStore } from "../../apps/host/src/store.js";
import {
  FakeNode,
  freePort,
  prepareConversations,
  startHost,
  stopHost,
} from "./harness.js";

it("renders exact-decision continuation inside its dialog and explicit retained-worker handback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fleet-maintenance-e2e-"));
  const database = join(directory, "host.sqlite");
  const prepared = prepareConversations(database, { events: 20, sessions: 2 });
  const store = new FleetStore(database);
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  let node: FakeNode | undefined;
  let browser: Browser | undefined;
  let token: string;
  let taskId: string;
  try {
    store.setSetting(AUTH_MODE_SETTING, "microsoft-only");
    const administrator = store.claimFirstAdministrator({
      tenantId: "synthetic-tenant",
      objectId: "synthetic-operator",
      displayName: "Fixture operator",
      username: "fixture@example.test",
    })!;
    const auth = new FleetAuth({
      store,
      announceClaimCode: () => {},
      warn: () => {},
      externalScheme: { publicUrl: () => undefined, tunnels: () => [] },
    });
    token = auth.sessions.issue({
      administratorId: administrator.id,
      authMethod: "microsoft-code",
    }).token;
    const placement = store.listPlacements()[0]!;
    const lead = store.createSession(placement, "Fixture", false, "Continuation lead", {
      runRole: "lead",
    });
    const task = store.createRun({
      workspaceId: placement.workspaceId,
      name: "Continuation fixture",
      objective: "Preserve the existing API contract.",
    });
    taskId = task.id;
    store.updateRun(task.id, { leadSessionId: lead.id, state: "running" });
    const worker = store.createSession(placement, "Fixture", false, "Retained worker", {
      runId: task.id,
      runRole: "worker",
    });
    for (const session of [lead, worker]) {
      store.transitionSession(session.id, "starting");
      store.transitionSession(session.id, "idle");
      store.setSessionFavorite(session.id, true);
    }
    const step = store.upsertRunStep(task.id, {
      stepKey: "repair",
      title: "Retained repair",
      prompt: "Fixture",
      category: "implement",
      placementId: placement.id,
    });
    store.updateRunStep(step.id, { state: "succeeded", sessionId: worker.id });
    const headSha = "a".repeat(40);
    let record = store.prMaintenance.enableFromOperator(
      {
        taskId: task.id,
        workerSessionId: worker.id,
        headSha,
        identity: {
          host: "github.com",
          repositoryId: "fixture",
          repository: "example/fixture",
          prNumber: 1,
          headRepositoryId: "fixture",
          headRepository: "example/fixture",
          headRef: "refs/heads/repair",
          baseRepositoryId: "fixture",
          baseRepository: "example/fixture",
          baseRef: "refs/heads/main",
        },
        scope: {
          baseline: "Preserve the API",
          verification: "Native regression checks",
          publicationAuthorized: true,
        },
        eligibilityEvidence: "Synthetic fixture; no provider or real worker is invoked.",
      },
      administrator.id,
    );
    record = store.prMaintenance.checkpoint(lead.id, record.id, record.version, {
      kind: "observation",
      observation: {
        attemptedAt: new Date().toISOString(),
        complete: true,
        identity: record.identity,
        headSha,
        baseSha: "b".repeat(40),
        state: "open",
        snapshotId: "fixture",
        fingerprint: "fixture",
        evidence: "Synthetic complete observation.",
      },
    });
    store.prMaintenance.holdForDecision(
      lead.id,
      record.id,
      record.version,
      {
        id: "fixture-decision",
        version: 1,
        proposal: "Retain the public API?",
        scope: "Existing null invariant",
        headSha,
      },
      () => store.updateRun(task.id, { state: "awaiting_human" }),
    );
    prepared.ids.push(lead.id, worker.id);
    prepared.nextSequence.set(lead.id, 1);
    prepared.nextSequence.set(worker.id, 1);
  } finally {
    store.close();
  }
  try {
    host = await startHost(
      fileURLToPath(new URL("../../", import.meta.url)),
      database,
      await freePort(),
    );
    node = await FakeNode.connect(host.url, prepared);
    browser = await chromium.launch({
      channel: process.env.FLEET_E2E_BROWSER ?? "msedge",
      headless: true,
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    await context.addCookies([{ name: OPERATOR_COOKIE, value: token, url: host.url }]);
    const page = await context.newPage();
    await page.goto(host.url);
    await page.locator('button[title="Continuation lead"]').first().click();
    await page.getByText("Continuation fixture", { exact: true }).first().click();
    await page.getByRole("button", { name: "Review decision", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Direct PR maintenance" });
    const continuation = dialog.getByRole("checkbox", {
      name: /Continue already-authorized/,
    });
    expect(await continuation.isChecked()).toBe(false);
    await dialog
      .getByRole("textbox", { name: "What needs changing?" })
      .fill("Keep the contract; repair only the existing invariant.");
    await continuation.check();
    const artifacts = process.env.FLEET_E2E_ARTIFACTS;
    if (artifacts) {
      mkdirSync(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, "direction-and-continuation.png") });
    }
    const response = page.waitForResponse(
      (reply) =>
        reply.url().endsWith(`/api/runs/${taskId}/review`) &&
        reply.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Direct and continue" }).click();
    expect((await response).status()).toBe(202);
    await dialog.waitFor({ state: "hidden" });
    const view = await context.request.get(
      `${host.url}/api/runs/${taskId}/pr-maintenance`,
    );
    expect(view.ok()).toBe(true);
    const state = await view.json();
    expect(state.records[0].continuation.state).toBe("checking");
    expect(state.effectiveStates[state.records[0].id].status).toBe("checking");
    await page.getByText("Retained worker", { exact: true }).first().click();
    const handback = page.getByRole("checkbox", { name: /One-turn handback/ });
    await handback.waitFor({ state: "visible" });
    expect(await handback.isChecked()).toBe(false);
    await handback.check();
    if (artifacts)
      await page.screenshot({ path: join(artifacts, "one-turn-handback.png") });
  } finally {
    node?.close();
    await browser?.close();
    if (host) await stopHost(host.child);
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
