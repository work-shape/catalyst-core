import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createConnectionCredentialResolver,
  createSecretStore,
  type SecretKeyring
} from "@work-shape/catalyst-connections";
import {
  AppError,
  WORKFLOW_ASSET_KIND,
  WORKFLOW_WEBHOOK_HEADERS,
  WORKFLOW_WEBHOOK_LIMITS,
  WORKFLOW_WEBHOOK_REFUSALS,
  type AuditActor,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type PlatformStores,
  type SecretBinding,
  type SecretState,
  type WorkflowManifest,
  type WorkflowRun,
  type WorkflowTrigger,
  type WorkflowWebhookRefusal
} from "@work-shape/catalyst-core";
import type { WorkflowDefinitionRevision, WorkflowDefinitionSource } from "./definition-source";
import { principalActor } from "./run-identity";
import type { PreparedStart } from "./run-start";
import type { RunOrigin } from "./scheduled-start";

// The `webhook` trigger (EW-4): an outside system posts a run's input to the Workflow's address.
// Each Workflow has its own secret in the Secret Store, bound to its asset, made by a publisher
// and shown once. A request is signed: HMAC-SHA256 with the secret over the timestamp, the nonce
// and the body as sent. A request without a valid signature is refused before its body is read
// as input; a timestamp more than five minutes off, or a nonce the Workflow accepted already, is
// refused too, and each Workflow takes at most `perMinute` requests a minute. The run acts as
// the Workflow's own account, and the body is its input, kept as long as the run's data. Its
// audit records the start and every refusal, never the body.

/** The subject of the Secret Store row of a Workflow's webhook secret. */
export const WORKFLOW_WEBHOOK_SECRET_SUBJECT = "workflow:webhook";

/** The random bytes of a webhook secret. Nobody types it. */
const WEBHOOK_SECRET_BYTES = 32;

const NONCE_PATTERN = /^[A-Za-z0-9._~-]+$/u;

/**
 * The signature of one request: `v1=` and the hex HMAC-SHA256 under the secret of
 * `<timestamp>.<nonce>.<body>`, the timestamp in seconds since the epoch and the body the bytes
 * sent.
 */
export function workflowWebhookSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  body: Uint8Array | string
): string {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}.${nonce}.`);
  mac.update(body);
  return `v1=${mac.digest("hex")}`;
}

type WebhookTrigger = Extract<WorkflowTrigger, { kind: "webhook" }>;

/** The webhook trigger of the definition, where it has one. */
export function workflowWebhookTrigger(
  manifest: Pick<WorkflowManifest, "steps">
): WebhookTrigger | undefined {
  const [trigger] = manifest.steps;
  if (trigger?.type !== "trigger") return undefined;
  return trigger.triggers.find((candidate) => candidate.kind === "webhook");
}

/** What a publisher reads of a Workflow's webhook. Never the secret. */
export interface WorkflowWebhookView {
  /** The published definition has a webhook trigger: requests start runs. */
  enabled: boolean;
  /** The requests a minute the trigger accepts. */
  perMinute: number;
  /** Whether a secret is stored, and its version. */
  secret: SecretState;
  version?: number;
}

export interface WorkflowWebhookRequest {
  workflow: string;
  /** The request's headers, by their lowercase names. */
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** The body as sent: what the signature covers. */
  body: Uint8Array;
  /** The body read as JSON: the run's input. */
  input: unknown;
  correlationId: string;
}

export interface WorkflowWebhooks {
  status(workflow: string): Promise<WorkflowWebhookView>;
  /** Makes a new secret and answers it, once. The old one signs nothing from now on. */
  rotate(input: {
    workflow: string;
    actor: AuditActor;
    correlationId: string;
  }): Promise<{ secret: string; version: number }>;
  /** Checks a request and starts its run; throws the refusal. */
  receive(request: WorkflowWebhookRequest): Promise<{ runId: string }>;
}

interface WebhookTriggerOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  keyring: SecretKeyring;
  definitions: Pick<WorkflowDefinitionSource, "read">;
  now(): Date;
  prepareStart(published: WorkflowDefinitionRevision, given: unknown): Promise<PreparedStart>;
  openRun(
    tx: PlatformStores,
    prepared: PreparedStart,
    started: RunOrigin
  ): Promise<WorkflowRun | undefined>;
}

const REFUSAL_MESSAGES: Record<WorkflowWebhookRefusal, string> = {
  webhook_unsigned: `The request is not signed: send ${WORKFLOW_WEBHOOK_HEADERS.timestamp}, ${WORKFLOW_WEBHOOK_HEADERS.nonce} and ${WORKFLOW_WEBHOOK_HEADERS.signature}`,
  webhook_signature_invalid: "The request's signature does not match the Workflow's secret",
  webhook_timestamp_expired: `The request's timestamp is more than ${WORKFLOW_WEBHOOK_LIMITS.toleranceMs / 60_000} minutes away from now`,
  webhook_nonce_replayed: "The request's nonce was used before",
  webhook_rate_limited: "The Workflow takes no more requests this minute",
  webhook_no_secret: "The Workflow's webhook has no secret yet"
};

/** The refusal of a webhook request, as the caller hears it. */
export function workflowWebhookRefusal(reason: WorkflowWebhookRefusal): AppError {
  return new AppError(
    reason === WORKFLOW_WEBHOOK_REFUSALS.rateLimited ? "RATE_LIMITED" : "UNAUTHENTICATED",
    REFUSAL_MESSAGES[reason],
    { reason }
  );
}

const noWebhook = () => new AppError("NOT_FOUND", "There is no webhook at this address");

function header(headers: WorkflowWebhookRequest["headers"], name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sameSignature(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createWebhookTrigger(options: WebhookTriggerOptions): WorkflowWebhooks {
  const { clientInstanceId, stores, keyring, definitions, now, prepareStart, openRun } = options;
  const bindingOf = (asset: Pick<ConfigAssetRecord, "id">): SecretBinding => ({
    connectionAssetId: asset.id,
    subject: WORKFLOW_WEBHOOK_SECRET_SUBJECT
  });
  const secretStore = (rows: PlatformStores["connections"]) =>
    createSecretStore({ clientInstanceId, keyring, store: rows });

  async function assetOf(workflow: string): Promise<ConfigAssetRecord | undefined> {
    const asset = await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name: workflow
    });
    return asset?.status === "active" ? asset : undefined;
  }

  /** The stored secret, or nothing where none is stored or it does not open. */
  async function secretOf(asset: ConfigAssetRecord): Promise<string | undefined> {
    const binding = bindingOf(asset);
    const options = { clientInstanceId, keyring, store: stores.connections };
    const status = await createSecretStore(options).status(binding);
    if (status.state !== "set" || status.handle === undefined) return undefined;
    return createConnectionCredentialResolver(options).resolve({ handle: status.handle, binding });
  }

  async function refuse(
    asset: ConfigAssetRecord,
    reason: WorkflowWebhookRefusal,
    correlationId: string
  ): Promise<never> {
    await stores.audit.appendAuditEvent({
      clientInstanceId,
      type: "workflow.webhook_refused",
      status: "failed",
      actor: { displayLabel: "webhook", roles: [] },
      subject: asset.id,
      correlationId,
      metadata: { workflow: asset.name, reason }
    });
    throw workflowWebhookRefusal(reason);
  }

  return {
    async status(workflow) {
      const asset = await assetOf(workflow);
      if (!asset) throw new AppError("NOT_FOUND", "There is no such Workflow");
      const published = await definitions.read(workflow).catch(() => undefined);
      const trigger = published ? workflowWebhookTrigger(published.manifest) : undefined;
      const stored = await secretStore(stores.connections).status(bindingOf(asset));
      return {
        enabled: trigger !== undefined,
        perMinute: trigger?.perMinute ?? WORKFLOW_WEBHOOK_LIMITS.perMinute,
        secret: stored.state,
        ...(stored.version === undefined ? {} : { version: stored.version })
      };
    },

    async rotate({ workflow, actor, correlationId }) {
      const asset = await assetOf(workflow);
      if (!asset) throw new AppError("NOT_FOUND", "There is no such Workflow");
      const secret = randomBytes(WEBHOOK_SECRET_BYTES).toString("base64url");
      const { version } = await stores.transaction(async (tx) => {
        const written = await secretStore(tx.connections).put({
          binding: bindingOf(asset),
          value: secret,
          source: "runtime"
        });
        await tx.audit.appendAuditEvent({
          clientInstanceId,
          type: "workflow.webhook_secret_rotated",
          status: "success",
          actor,
          subject: asset.id,
          correlationId,
          metadata: { workflow, version: written.version }
        });
        return written;
      });
      return { secret, version };
    },

    async receive(request) {
      const { workflow, headers, body, correlationId } = request;
      const published = await definitions.read(workflow).catch(() => undefined);
      const trigger = published ? workflowWebhookTrigger(published.manifest) : undefined;
      const asset = trigger ? await assetOf(workflow) : undefined;
      if (!published || !trigger || !asset) throw noWebhook();
      const timestamp = header(headers, WORKFLOW_WEBHOOK_HEADERS.timestamp);
      const nonce = header(headers, WORKFLOW_WEBHOOK_HEADERS.nonce);
      const signature = header(headers, WORKFLOW_WEBHOOK_HEADERS.signature);
      if (
        timestamp === undefined ||
        nonce === undefined ||
        signature === undefined ||
        nonce.length > WORKFLOW_WEBHOOK_LIMITS.nonceMaxLength ||
        !NONCE_PATTERN.test(nonce)
      )
        return refuse(asset, WORKFLOW_WEBHOOK_REFUSALS.unsigned, correlationId);
      const secret = await secretOf(asset);
      if (secret === undefined)
        return refuse(asset, WORKFLOW_WEBHOOK_REFUSALS.noSecret, correlationId);
      // The signature first: an unsigned caller learns nothing of the clock or the nonces.
      if (!sameSignature(signature, workflowWebhookSignature(secret, timestamp, nonce, body)))
        return refuse(asset, WORKFLOW_WEBHOOK_REFUSALS.signature, correlationId);
      const received = now();
      const sentAt = /^\d{1,12}$/u.test(timestamp) ? Number(timestamp) * 1000 : Number.NaN;
      if (
        !Number.isFinite(sentAt) ||
        Math.abs(received.getTime() - sentAt) > WORKFLOW_WEBHOOK_LIMITS.toleranceMs
      )
        return refuse(asset, WORKFLOW_WEBHOOK_REFUSALS.expired, correlationId);
      // Only now is the body read as the run's input.
      const prepared = await prepareStart(published, request.input);
      const { principal } = prepared;
      const outcome = await stores.transaction(async (tx) => {
        const admission = await tx.workflowWebhooks.admit({
          clientInstanceId,
          workflowAssetId: asset.id,
          nonce,
          receivedAt: received.toISOString(),
          perMinute: trigger.perMinute ?? WORKFLOW_WEBHOOK_LIMITS.perMinute,
          // A nonce is remembered as long as a timestamp it came with could still pass.
          forgetBefore: new Date(
            received.getTime() - 2 * WORKFLOW_WEBHOOK_LIMITS.toleranceMs
          ).toISOString()
        });
        if (admission !== "admitted") return { admission };
        const run = await openRun(tx, prepared, {
          trigger: "webhook",
          // Nobody is present behind a webhook: the run is started as its own principal.
          startedBy: { kind: "service_principal", id: principal.id, label: principal.displayLabel },
          actor: principalActor({ principal }),
          correlationId
        });
        if (!run) throw new AppError("INTERNAL", "The Workflow Run was not written");
        return { admission, runId: run.id };
      });
      if (outcome.admission === "replayed")
        return refuse(asset, WORKFLOW_WEBHOOK_REFUSALS.replayed, correlationId);
      if (outcome.admission === "rate_limited")
        return refuse(asset, WORKFLOW_WEBHOOK_REFUSALS.rateLimited, correlationId);
      if (outcome.runId === undefined)
        throw new AppError("INTERNAL", "The Workflow Run was not written");
      return { runId: outcome.runId };
    }
  };
}
