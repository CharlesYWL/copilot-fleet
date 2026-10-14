import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import {
  DecisionProviderDraftSchema,
  ProposeWorkerRoutingPolicySchema,
  UpdateWorkerRoutingSchema,
  WorkerRoutingConfigurationSchema,
  WorkerRoutingProposalSchema,
  type DecisionAttempt,
  type DecisionConnectionTest,
  type DecisionProvider,
  type DecisionProviderDraft,
  type UpdateWorkerRouting,
  type WorkerExecutionProfile,
  type WorkerRoutingProposal,
  type WorkerRoutingReceipt,
  type WorkerRoutingSettings,
} from "@fleet/protocol";
import type { FleetStore } from "./store.js";
import { savePrivateJson } from "./private-config.js";
import { securePrivateDirectory } from "./data-permissions.js";
import {
  DECISION_REQUEST_BYTES,
  DecisionProviderError,
  decisionPayload,
  evaluateDecision,
  type DecisionEvaluation,
  type DecisionPayload,
  type RoutingBrief,
} from "./decision-provider.js";

const providerStateSchema = z.record(
  z.string(),
  z.object({
    credentialRevision: z.string().optional(),
    testedRevision: z.string().optional(),
    testedAt: z.string().datetime().optional(),
  }),
);
type ProviderState = z.infer<typeof providerStateSchema>;
const credentialFileSchema = z.object({
  version: z.literal(1),
  keys: z.record(z.string().uuid(), z.string().min(1).max(1000)),
});
type TestProof = {
  signature: string;
  actor: string;
  testedAt: string;
  expiresAt: number;
  key: string;
};

export class WorkerRoutingSettingsError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const revisionFor = (provider: DecisionProvider, credentialRevision: string) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        provider.kind,
        provider.endpoint,
        provider.model,
        credentialRevision,
      ]),
    )
    .digest("hex");

export class WorkerModelRoutingService {
  private keys: Record<string, string> = {};
  private credentialError: string | undefined;
  private saving = false;
  private credentialDirectoryReady = false;
  private inFlight = 0;
  private nextPermitAt = 0;
  private readonly proofs = new Map<string, TestProof>();
  private readonly proofKey = randomBytes(32);
  private readonly decisions = new Set<AbortController>();
  private readonly tests = new Set<AbortController>();
  private readonly evaluate: typeof evaluateDecision;
  private readonly rateIntervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: FleetStore,
    private readonly log: FastifyBaseLogger,
    private readonly credentialPath?: string,
    dependencies: {
      evaluate?: typeof evaluateDecision;
      rateIntervalMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.evaluate = dependencies.evaluate ?? evaluateDecision;
    this.rateIntervalMs = dependencies.rateIntervalMs ?? 2000;
    this.now = dependencies.now ?? (() => Math.floor(performance.now()));
    if (!store.getSetting("workerModelRouting.epoch"))
      store.setSetting("workerModelRouting.epoch", randomUUID());
  }

  async initialize(): Promise<void> {
    if (!this.credentialPath) return;
    try {
      const file = await lstat(this.credentialPath);
      if (!file.isFile() || file.isSymbolicLink())
        throw new Error("Decision credential path must be a regular file.");
      await this.prepareCredentialDirectory();
      this.keys = credentialFileSchema.parse(
        JSON.parse(await readFile(this.credentialPath, "utf8")),
      ).keys;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT" &&
        !Object.values(this.providerState()).some((state) => state.credentialRevision)
      )
        return;
      this.credentialError =
        "Decision API keys could not be read. Enter replacement keys and test the connections again.";
      this.log.error("Decision API credential file is missing, unreadable, or invalid.");
    }
  }

  private async prepareCredentialDirectory(): Promise<void> {
    if (!this.credentialPath || this.credentialDirectoryReady) return;
    const directory = dirname(this.credentialPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Decision credential directory must not be a symbolic link.");
    await securePrivateDirectory(directory);
    this.credentialDirectoryReady = true;
  }

  private providerState(): ProviderState {
    const value = this.store.getSetting("workerModelRouting.providerState");
    return providerStateSchema.parse(value ? JSON.parse(value) : {});
  }

  private keyFor(
    provider: DecisionProvider,
    states = this.providerState(),
  ): string | undefined {
    const revision = states[provider.id]?.credentialRevision;
    return revision ? this.keys[revision] : undefined;
  }

  private ready(provider: DecisionProvider, states = this.providerState()): boolean {
    const state = states[provider.id];
    return Boolean(
      state?.credentialRevision &&
      this.keyFor(provider, states) &&
      state.testedRevision === revisionFor(provider, state.credentialRevision),
    );
  }

  view(): WorkerRoutingSettings {
    const configuration = this.store.getWorkerModelRouting();
    const states = this.providerState();
    return {
      ...configuration,
      providers: configuration.providers.map((provider) => ({
        ...provider,
        keyConfigured: Boolean(this.keyFor(provider, states)),
        ready: this.ready(provider, states),
        ...(states[provider.id]?.testedAt
          ? { testedAt: states[provider.id]!.testedAt }
          : {}),
      })),
      suspended: this.store.getSetting("workerModelRouting.suspended") === "true",
      ...(this.credentialError ? { credentialError: this.credentialError } : {}),
      proposals: this.proposals(),
    };
  }

  private signature(provider: DecisionProvider, key: string): string {
    return createHmac("sha256", this.proofKey)
      .update(
        JSON.stringify([
          this.store.getSetting("workerModelRouting.epoch"),
          provider.id,
          provider.kind,
          provider.endpoint,
          provider.model,
          key,
        ]),
      )
      .digest("hex");
  }

  private draftKey(draft: DecisionProviderDraft, actor: string): string | undefined {
    if (draft.keyAction === "replace") {
      if (draft.key) return draft.key;
      const proof = draft.testToken ? this.proofs.get(draft.testToken) : undefined;
      if (
        proof &&
        proof.actor === actor &&
        proof.expiresAt >= this.now() &&
        proof.signature === this.signature(draft.provider, proof.key)
      )
        return proof.key;
      else
        throw new WorkerRoutingSettingsError(
          400,
          "key_required",
          "Enter a replacement API key.",
        );
    }
    if (draft.key !== undefined)
      throw new WorkerRoutingSettingsError(
        400,
        "key_action",
        "Choose Replace to change an API key.",
      );
    if (draft.keyAction === "clear") return undefined;
    const previous = this.store
      .getWorkerModelRouting()
      .providers.find((provider) => provider.id === draft.provider.id);
    if (
      previous &&
      (previous.kind !== draft.provider.kind ||
        previous.endpoint !== draft.provider.endpoint)
    )
      throw new WorkerRoutingSettingsError(
        400,
        "key_destination_changed",
        "Enter a new API key when changing the provider or endpoint. Saved keys cannot be sent to a different destination.",
      );
    return previous ? this.keyFor(previous) : undefined;
  }

  async update(
    input: UpdateWorkerRouting,
    actor: string,
  ): Promise<WorkerRoutingSettings> {
    const parsed = UpdateWorkerRoutingSchema.parse(input);
    const current = this.store.getWorkerModelRouting();
    if (this.saving || current.revision !== parsed.expectedRevision)
      throw new WorkerRoutingSettingsError(
        409,
        "stale_revision",
        "Routing settings changed. Refresh before saving; your unsaved edits are still available.",
      );
    const epoch = this.store.getSetting("workerModelRouting.epoch");
    const configuration = WorkerRoutingConfigurationSchema.parse({
      ...parsed,
      revision: current.revision + 1,
      providers: parsed.providers.map((draft) => draft.provider),
    });
    const previousStates = this.providerState();
    const states: ProviderState = {};
    const keys: Record<string, string> = {};
    // Keep the old generation until the metadata commit, so a crash before it
    // cannot replace a still-authorized key with an unrelated new one.
    for (const state of Object.values(previousStates))
      if (state.credentialRevision && this.keys[state.credentialRevision])
        keys[state.credentialRevision] = this.keys[state.credentialRevision]!;

    for (const draft of parsed.providers) {
      const provider = draft.provider;
      const key = this.draftKey(draft, actor);
      const old = previousStates[provider.id];
      const credentialRevision = key
        ? draft.keyAction === "replace"
          ? randomUUID()
          : old?.credentialRevision
        : undefined;
      const state: ProviderState[string] = {
        ...(credentialRevision ? { credentialRevision } : {}),
      };
      if (key && credentialRevision) {
        keys[credentialRevision] = key;
        if (old?.testedRevision === revisionFor(provider, credentialRevision)) {
          state.testedRevision = old.testedRevision;
          if (old.testedAt) state.testedAt = old.testedAt;
        }
        if (draft.testToken) {
          const proof = this.proofs.get(draft.testToken);
          if (
            !proof ||
            proof.actor !== actor ||
            proof.expiresAt < this.now() ||
            proof.signature !== this.signature(provider, key)
          )
            throw new WorkerRoutingSettingsError(
              409,
              "test_stale",
              "This connection changed or its test expired. Test it again before saving.",
            );
          state.testedRevision = revisionFor(provider, credentialRevision);
          state.testedAt = proof.testedAt;
        }
      }
      states[provider.id] = state;
    }
    const hasReady = configuration.providers.some(
      (provider) =>
        states[provider.id]?.credentialRevision &&
        states[provider.id]?.testedRevision ===
          revisionFor(provider, states[provider.id]!.credentialRevision!),
    );
    if (configuration.mode === "route" && !hasReady)
      throw new WorkerRoutingSettingsError(
        409,
        "test_required",
        "Test at least one decision model before choosing Route new workers.",
      );

    this.saving = true;
    try {
      if (this.credentialPath) await this.prepareCredentialDirectory();
      if (this.credentialPath)
        await savePrivateJson(this.credentialPath, { version: 1, keys });
      if (
        this.store.getWorkerModelRouting().revision !== current.revision ||
        this.store.getSetting("workerModelRouting.epoch") !== epoch
      )
        throw new WorkerRoutingSettingsError(
          409,
          "stale_revision",
          "The Host changed while saving. Refresh the routing settings and retry.",
        );
      this.store.writeAtomically(() => {
        this.store.setWorkerModelRouting(configuration);
        this.store.setSetting("workerModelRouting.providerState", JSON.stringify(states));
        if (hasReady) this.store.setSetting("workerModelRouting.suspended", "false");
      });
      const activeKeys: Record<string, string> = {};
      for (const state of Object.values(states))
        if (state.credentialRevision && keys[state.credentialRevision])
          activeKeys[state.credentialRevision] = keys[state.credentialRevision]!;
      this.keys = activeKeys;
      this.credentialError = undefined;
      for (const draft of parsed.providers)
        if (draft.testToken) this.proofs.delete(draft.testToken);
      if (configuration.mode === "off")
        for (const controller of this.decisions) controller.abort();
      if (this.credentialPath) {
        try {
          await savePrivateJson(this.credentialPath, { version: 1, keys: activeKeys });
        } catch {
          this.log.error(
            "Decision settings saved, but obsolete API keys could not be removed.",
          );
          throw new WorkerRoutingSettingsError(
            500,
            "key_cleanup_failed",
            "Settings were saved, but obsolete API keys could not be removed. Check Host data permissions, refresh, and save again.",
          );
        }
      }
      return this.view();
    } catch (error) {
      if (error instanceof WorkerRoutingSettingsError) throw error;
      this.log.error("Could not persist decision API credentials or settings.");
      throw new WorkerRoutingSettingsError(
        500,
        "save_failed",
        "Could not save decision settings. Check the Host data directory permissions and retry.",
      );
    } finally {
      this.saving = false;
    }
  }

  private async acquire(signal: AbortSignal, deadline: number): Promise<() => void> {
    while (!signal.aborted && this.now() < deadline) {
      const now = this.now();
      if (this.inFlight < 2 && now >= this.nextPermitAt) {
        this.inFlight++;
        this.nextPermitAt = now + this.rateIntervalMs;
        return () => this.inFlight--;
      }
      await sleep(
        Math.min(deadline - now, Math.max(25, this.nextPermitAt - now)),
        undefined,
        { signal },
      );
    }
    throw new DecisionProviderError("timeout");
  }

  private async call(
    provider: DecisionProvider,
    key: string,
    payload: DecisionPayload,
    deadline: number,
    parentSignal: AbortSignal,
    remainingModels = 1,
  ): Promise<DecisionEvaluation> {
    const controller = new AbortController();
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, deadline - this.now()),
    );
    let httpDeadline = deadline;
    let httpTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (let attempt = 0; ; attempt++) {
        let release: (() => void) | undefined;
        try {
          release = await this.acquire(signal, httpDeadline);
          if (httpTimer === undefined) {
            httpDeadline =
              this.now() + Math.floor((deadline - this.now()) / remainingModels);
            httpTimer = setTimeout(
              () => controller.abort(),
              Math.max(0, httpDeadline - this.now()),
            );
          }
          const aborted = new Promise<never>((_resolve, reject) => {
            if (signal.aborted) reject(new DecisionProviderError("timeout"));
            else
              signal.addEventListener(
                "abort",
                () => reject(new DecisionProviderError("timeout")),
                { once: true },
              );
          });
          const result = await Promise.race([
            this.evaluate(provider, key, payload, signal),
            aborted,
          ]);
          return {
            ...result,
            returnedModel: result.returnedModel.includes(key)
              ? "[redacted provider model identity]"
              : result.returnedModel,
          };
        } catch (error) {
          const failure =
            error instanceof DecisionProviderError
              ? error
              : new DecisionProviderError(signal.aborted ? "timeout" : "network");
          const delay = failure.retryAfterMs ?? 500;
          if (
            attempt === 0 &&
            failure.code === "throttled" &&
            Number.isFinite(delay) &&
            delay + 100 < httpDeadline - this.now() &&
            !signal.aborted
          ) {
            if (release) {
              release();
              release = undefined;
            }
            await sleep(delay, undefined, { signal });
            continue;
          }
          throw failure;
        } finally {
          release?.();
        }
      }
    } catch (error) {
      if (error instanceof DecisionProviderError) throw error;
      throw new DecisionProviderError(signal.aborted ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
      if (httpTimer !== undefined) clearTimeout(httpTimer);
      controller.abort();
    }
  }

  async test(
    input: DecisionProviderDraft,
    actor: string,
  ): Promise<DecisionConnectionTest> {
    const draft = DecisionProviderDraftSchema.parse(input);
    const key = this.draftKey(draft, actor);
    if (!key)
      throw new WorkerRoutingSettingsError(
        400,
        "key_required",
        "Enter an API key to test this connection.",
      );
    const started = this.now();
    const epoch = this.store.getSetting("workerModelRouting.epoch");
    const controller = new AbortController();
    this.tests.add(controller);
    try {
      const result = await this.call(
        draft.provider,
        key,
        decisionPayload(
          draft.provider.model,
          {
            category: "implement",
            title: "Connection test",
            deliverable: "Correct a supplied spelling mistake.",
            scope: "One supplied line of sample text; no repository data.",
            verify: "The corrected word matches the supplied spelling.",
          },
          [
            { id: "mechanical", description: "A precisely supplied mechanical change." },
            {
              id: "investigation",
              description: "Investigate interacting behavior or an unknown cause.",
            },
          ],
        ),
        started + this.store.getWorkerModelRouting().timeoutMs,
        controller.signal,
      );
      const testToken = randomUUID();
      if (
        controller.signal.aborted ||
        this.store.getSetting("workerModelRouting.epoch") !== epoch
      )
        throw new DecisionProviderError("timeout");
      const testedAt = new Date().toISOString();
      for (const [token, proof] of this.proofs)
        if (proof.expiresAt < this.now()) this.proofs.delete(token);
      if (this.proofs.size >= 32) this.proofs.delete(this.proofs.keys().next().value!);
      this.proofs.set(testToken, {
        signature: this.signature(draft.provider, key),
        actor,
        testedAt,
        expiresAt: this.now() + 15 * 60_000,
        key,
      });
      return {
        success: true,
        providerId: draft.provider.id,
        durationMs: this.now() - started,
        returnedModel: result.returnedModel,
        usage: result.usage,
        message:
          "Connection tested: the provider returned a valid decision. No worker was started.",
        testToken,
      };
    } catch (error) {
      const failure =
        error instanceof DecisionProviderError
          ? error
          : new DecisionProviderError("network");
      if (failure.code === "authentication") this.invalidateProvider(draft.provider, key);
      this.log.warn(
        { providerId: draft.provider.id, code: failure.code, status: failure.status },
        "Decision provider connection test failed",
      );
      return {
        success: false,
        providerId: draft.provider.id,
        durationMs: this.now() - started,
        usage: null,
        code: failure.code,
        message: failure.message,
      };
    } finally {
      this.tests.delete(controller);
    }
  }

  private invalidateProvider(provider: DecisionProvider, key: string): void {
    for (const [token, proof] of this.proofs)
      if (proof.signature === this.signature(provider, key)) this.proofs.delete(token);
    const current = this.store
      .getWorkerModelRouting()
      .providers.find((entry) => entry.id === provider.id);
    const states = this.providerState();
    if (
      !current ||
      current.kind !== provider.kind ||
      current.endpoint !== provider.endpoint ||
      current.model !== provider.model ||
      this.keyFor(current, states) !== key
    )
      return;
    const credentialRevision = states[provider.id]?.credentialRevision;
    states[provider.id] = credentialRevision ? { credentialRevision } : {};
    this.store.setSetting("workerModelRouting.providerState", JSON.stringify(states));
  }

  async decide(
    brief: RoutingBrief & { profile?: string | undefined },
  ): Promise<WorkerRoutingReceipt | undefined> {
    const configuration = this.store.getWorkerModelRouting();
    if (configuration.mode === "off") return undefined;
    const started = this.now();
    const receipt: WorkerRoutingReceipt = {
      version: 1,
      mode: configuration.mode,
      source: "fallback",
      policyRevision: configuration.revision,
      createdAt: new Date().toISOString(),
      durationMs: 0,
      attempts: [],
      defaults: {
        model: this.store.getDefaultModel(),
        reasoningEffort: this.store.getDefaultReasoningEffort() || null,
      },
    };
    const select = (
      profile: WorkerExecutionProfile,
      source: "explicit" | "single" | "decision",
    ) => {
      receipt.source =
        configuration.mode === "shadow" && source !== "explicit" ? "shadow" : source;
      receipt.profileId = profile.id;
      receipt.profileName = profile.name;
      receipt.model = profile.model;
      receipt.reasoningEffort = profile.reasoningEffort;
      if (receipt.source === "shadow") receipt.fallbackReason = "shadow";
      receipt.durationMs = this.now() - started;
      return receipt;
    };
    if (brief.profile && brief.profile !== "auto") {
      const profile = configuration.profiles.find((entry) => entry.id === brief.profile);
      if (!profile)
        throw new WorkerRoutingSettingsError(
          400,
          "unknown_profile",
          `Unknown profile "${brief.profile}". Available IDs: ${configuration.profiles.map((entry) => entry.id).join(", ") || "none"}.`,
        );
      return select(profile, "explicit");
    }
    const candidates = configuration.profiles.filter((profile) =>
      profile.categories.some((category) => category === brief.category),
    );
    if (!candidates.length) {
      receipt.fallbackReason = "no_candidates";
      return receipt;
    }
    const states = this.providerState();
    const providers = configuration.providers.filter((provider) =>
      this.ready(provider, states),
    );
    const baseBytes = Buffer.byteLength(
      JSON.stringify(decisionPayload("", brief, candidates)),
    );
    const modelBytes = Math.max(
      0,
      ...configuration.providers.map(
        (provider) => Buffer.byteLength(JSON.stringify(provider.model)) - 2,
      ),
    );
    if (baseBytes + modelBytes > DECISION_REQUEST_BYTES) {
      receipt.fallbackReason = "over_size";
      return receipt;
    }
    if (candidates.length === 1) return select(candidates[0]!, "single");
    if (!providers.length) {
      receipt.fallbackReason = "provider_unavailable";
      return receipt;
    }

    const epoch = this.store.getSetting("workerModelRouting.epoch");
    const controller = new AbortController();
    this.decisions.add(controller);
    const deadline = started + configuration.timeoutMs;
    try {
      for (const [index, provider] of providers.entries()) {
        const current = this.store.getWorkerModelRouting();
        if (
          controller.signal.aborted ||
          current.mode === "off" ||
          this.store.getSetting("workerModelRouting.epoch") !== epoch
        ) {
          receipt.fallbackReason = "disabled";
          break;
        }
        const fresh = current.providers.find((entry) => entry.id === provider.id);
        if (
          !fresh ||
          revisionFor(fresh, this.providerState()[fresh.id]?.credentialRevision ?? "") !==
            revisionFor(provider, states[provider.id]?.credentialRevision ?? "") ||
          !this.ready(fresh)
        )
          continue;
        const attemptStarted = this.now();
        const attempt: DecisionAttempt = {
          providerId: provider.id,
          providerName: provider.name,
          kind: provider.kind,
          requestedModel: provider.model,
          durationMs: 0,
          success: false,
          usage: null,
        };
        const key = this.keyFor(provider, states)!;
        try {
          const remaining = deadline - this.now();
          if (remaining <= 0) throw new DecisionProviderError("timeout");
          const result = await this.call(
            provider,
            key,
            decisionPayload(provider.model, brief, candidates),
            deadline,
            controller.signal,
            providers.length - index,
          );
          attempt.returnedModel = result.returnedModel;
          attempt.usage = result.usage;
          receipt.probabilities = result.probabilities;
          if (
            (result.probabilities[result.profileId] ?? 0) < configuration.minProbability
          )
            throw new DecisionProviderError("low_probability");
          if (
            controller.signal.aborted ||
            this.store.getWorkerModelRouting().mode === "off" ||
            this.store.getSetting("workerModelRouting.epoch") !== epoch
          ) {
            receipt.fallbackReason = "disabled";
            break;
          }
          attempt.success = true;
          attempt.durationMs = this.now() - attemptStarted;
          receipt.attempts.push(attempt);
          return select(
            candidates.find((profile) => profile.id === result.profileId)!,
            "decision",
          );
        } catch (error) {
          const failure =
            error instanceof DecisionProviderError
              ? error
              : new DecisionProviderError("network");
          attempt.code = failure.code;
          if (failure.status !== undefined) attempt.status = failure.status;
          if (failure.code === "authentication") this.invalidateProvider(provider, key);
          receipt.fallbackReason =
            failure.code === "low_probability"
              ? "low_probability"
              : failure.code === "invalid_answer"
                ? "invalid_answer"
                : failure.code === "timeout"
                  ? "timeout"
                  : "provider_error";
          this.log.warn(
            { providerId: provider.id, code: failure.code, status: failure.status },
            "Worker model decision failed; trying the next decision model or worker defaults",
          );
        }
        attempt.durationMs = this.now() - attemptStarted;
        receipt.attempts.push(attempt);
      }
      receipt.fallbackReason ??= "provider_unavailable";
      if (controller.signal.aborted) receipt.fallbackReason = "disabled";
      receipt.durationMs = this.now() - started;
      return receipt;
    } finally {
      this.decisions.delete(controller);
    }
  }

  proposals(): WorkerRoutingProposal[] {
    const value = this.store.getSetting("workerModelRouting.proposals");
    return z
      .array(WorkerRoutingProposalSchema)
      .max(20)
      .parse(value ? JSON.parse(value) : []);
  }

  propose(
    input: z.infer<typeof ProposeWorkerRoutingPolicySchema>,
    leadSessionId: string,
    leadName: string,
  ): WorkerRoutingProposal {
    const parsed = ProposeWorkerRoutingPolicySchema.parse(input);
    if (parsed.expectedRevision !== this.store.getWorkerModelRouting().revision)
      throw new WorkerRoutingSettingsError(
        409,
        "stale_revision",
        "Read the current routing policy before proposing an edit.",
      );
    const proposals = this.proposals().filter(
      (proposal) => proposal.leadSessionId !== leadSessionId,
    );
    if (proposals.length >= 20)
      throw new WorkerRoutingSettingsError(
        409,
        "proposal_limit",
        "The operator must review the existing proposals first.",
      );
    const proposal: WorkerRoutingProposal = {
      ...parsed,
      id: randomUUID(),
      leadSessionId,
      leadName,
      createdAt: new Date().toISOString(),
    };
    this.store.setSetting(
      "workerModelRouting.proposals",
      JSON.stringify([...proposals, proposal]),
    );
    this.store.recordSecurityAudit({
      eventType: "worker_model_routing_policy_proposed",
      actorKind: "lead",
      actorId: leadSessionId,
      targetId: proposal.id,
      outcome: "proposed",
      detail: `Policy revision ${parsed.expectedRevision}; ${parsed.profiles.length} profiles; ${parsed.reason}`,
    });
    return proposal;
  }

  reviewProposal(
    id: string,
    action: "apply" | "reject",
    expectedRevision: number,
  ): WorkerRoutingSettings {
    const proposals = this.proposals();
    const proposal = proposals.find((entry) => entry.id === id);
    if (!proposal)
      throw new WorkerRoutingSettingsError(
        404,
        "proposal_missing",
        "The proposal is no longer available.",
      );
    const configuration = this.store.getWorkerModelRouting();
    if (
      action === "apply" &&
      (this.saving ||
        proposal.expectedRevision !== configuration.revision ||
        expectedRevision !== configuration.revision)
    )
      throw new WorkerRoutingSettingsError(
        409,
        "stale_revision",
        "The policy changed after this proposal. Ask the lead to propose against the current policy.",
      );
    this.store.writeAtomically(() => {
      if (action === "apply")
        this.store.setWorkerModelRouting({
          ...configuration,
          profiles: proposal.profiles,
          revision: configuration.revision + 1,
        });
      this.store.setSetting(
        "workerModelRouting.proposals",
        JSON.stringify(proposals.filter((entry) => entry.id !== id)),
      );
    });
    return this.view();
  }

  reset(): void {
    for (const controller of [...this.decisions, ...this.tests]) controller.abort();
    this.proofs.clear();
  }
}
