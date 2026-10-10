import {
  AppError,
  INSTANCE_ASSET_SCOPE,
  asCollaborationWorkspaceId,
  assetScopesEqual,
  auditActorFromIdentity,
  findNamespaceOfAssetName,
  isAppError,
  type AccessResource,
  type ActorAccess,
  type AssetScope,
  type ConfigAssetMutation,
  type ConfigAssetRecord,
  type ConfigAssetStore,
  type JsonObject,
  type Namespace,
  type OperationAuthorization,
  type PolicyTarget,
  type StorePage
} from "@vivd-catalyst/core";
import { z } from "zod";
import { readDefinitionName, type WorkflowAssetKind } from "./asset-kinds/shared";
import {
  INVALID_ASSET_SET_MESSAGE,
  findAssetSetIssues,
  findDefinition,
  validateAssetSet,
  withDefaultAgentName,
  withDefinition,
  withoutDefinition,
  type AssetSet,
  type AssetSetIssue
} from "./asset-set";
import {
  accessResource,
  conflict,
  decide,
  deleteDecision,
  errorIssues,
  type AssetCall
} from "./asset-access";
import {
  assetSyncPolicyTargets,
  authorizeAssetSync,
  syncAssets,
  type AssetSyncInput
} from "./asset-sync";
import {
  assertChangedAgentsAllowed,
  assetKey,
  authorizeInteractiveWrite,
  clearsLastDefault,
  findChangedAgentRefusals,
  findIssuesOfChange,
  loadReferableAssets,
  loadStoredAssets,
  type StoredAssets,
  requireInstanceDefaultChange,
  requireMatchingConfigName,
  setsInitialDefault,
  toJsonObject
} from "./asset-write-rules";
import { applyValidatedConfigAssetMutations, assertScopeCanOwn } from "./config-asset-writer";
import type { ChatServerOptions } from "./types";

/** How many assets a list reads where its caller names no page. */
const DEFAULT_ASSET_LIST_LIMIT = 51;

/** One asset as a call names it. Without a workspace it is one of the instance's own. */
export interface AssetAddress {
  kind: string;
  name: string;
  workspaceId?: string;
}

/** What a call's address comes to once the store is read. */
interface AssetTarget {
  kind: WorkflowAssetKind;
  name: string;
  scope: AssetScope;
  /** The row that carries the name in the addressed scope, a deleted one included. */
  asset?: ConfigAssetRecord;
  /** An asset of another scope carries the name. The call never reads or writes it. */
  elsewhere: boolean;
  /** What the caller's right is decided on. */
  resource: AccessResource;
}

type MutationBatch = Omit<
  Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0],
  "clientInstanceId" | "actor"
>;

const conflictDetailsSchema = z.object({
  conflicts: z
    .array(z.object({ kind: z.string(), name: z.string(), currentRevision: z.number().nullable() }))
    .min(1)
});

/**
 * One asset of any registered kind, read and written through the operation layer. Every call
 * addresses one scope and stays in it: a right on the instance's own assets, a Namespace
 * included, never reads or writes what a workspace owns, and the other way round.
 */
export class AssetWorkflow {
  private readonly options: ChatServerOptions;

  constructor(options: ChatServerOptions) {
    this.options = options;
  }

  async authorizeRead(access: ActorAccess, address: AssetAddress): Promise<OperationAuthorization> {
    const target = await this.target(address);
    return decide(access, target.kind.actions.read, target.resource);
  }

  async authorizeWrite(
    access: ActorAccess,
    address: AssetAddress
  ): Promise<OperationAuthorization> {
    const target = await this.target(address);
    return decide(access, target.kind.actions.write, target.resource);
  }

  async authorizeDelete(
    access: ActorAccess,
    address: AssetAddress
  ): Promise<OperationAuthorization> {
    return deleteDecision(access, await this.target(address));
  }

  /** A definition that names no asset is checked as the kind's right on the whole scope. */
  authorizeValidate(
    access: ActorAccess,
    input: { kind: string; config: unknown; workspaceId?: string }
  ): Promise<OperationAuthorization> {
    return this.authorizeRead(access, { ...input, name: readDefinitionName(input.config) ?? "" });
  }

  /**
   * Every item of a batch, as its own write or delete. A batch with an item its caller may
   * not make throws its refusal here, which names each item, and so never reaches the policy.
   */
  async authorizeSync(access: ActorAccess, input: AssetSyncInput): Promise<OperationAuthorization> {
    await authorizeAssetSync(this.options, access, input);
    return { allowed: true };
  }

  /**
   * What the policy is asked about for a call on one asset: its kind, its owner, and the
   * Namespace its name belongs to.
   */
  async policyTargets(address: {
    kind: string;
    name?: string;
    workspaceId?: string;
  }): Promise<PolicyTarget[]> {
    const namespace =
      address.name === undefined
        ? undefined
        : findNamespaceOfAssetName(
            await this.namespaces(scopeOf(address.workspaceId)),
            address.name
          );
    return [
      {
        assetKind: address.kind,
        ...(address.workspaceId === undefined ? {} : { workspaceId: address.workspaceId }),
        ...(namespace ? { namespace: namespace.prefix } : {})
      }
    ];
  }

  /** What the policy is asked about for a batch: every kind and Namespace its items name. */
  syncPolicyTargets(input: AssetSyncInput): Promise<PolicyTarget[]> {
    return assetSyncPolicyTargets(this.options, input);
  }

  /**
   * One page of the assets of a kind in one scope, each one the caller may read. The right is
   * decided per asset by the one resolver, so a list never shows what `assets.get` refuses.
   */
  async list(
    call: AssetCall,
    input: { kind: string; prefix?: string; text?: string; workspaceId?: string },
    page: StorePage | undefined
  ) {
    const kind = this.kind(input.kind);
    const scope = scopeOf(input.workspaceId);
    const [after] = page?.after ?? [];
    const [namespaces, records] = await Promise.all([
      this.namespaces(scope),
      this.options.configAssets.store.listConfigAssetPage({
        clientInstanceId: this.options.clientInstanceId,
        kind: kind.kind,
        scope,
        namePrefix: input.prefix,
        nameContains: input.text,
        afterName: typeof after === "string" ? after : undefined,
        limit: page?.limit ?? DEFAULT_ASSET_LIST_LIMIT,
        readable: (asset) =>
          call.access.authorize(
            kind.actions.read,
            accessResource(asset.kind, asset.name, asset.scope, asset.id)
          ).allowed
      })
    ]);
    return records.map((record) => {
      const namespace = findNamespaceOfAssetName(namespaces, record.name);
      return {
        id: record.id,
        kind: record.kind,
        ...summarize(kind, record),
        scope: record.scope,
        ...(namespace ? { namespace: namespace.prefix } : {}),
        revision: record.revision,
        updatedAt: record.updatedAt
      };
    });
  }

  async get(call: AssetCall, address: AssetAddress) {
    const target = await this.target(address);
    call.access.require(target.kind.actions.read, target.resource);
    const asset = requireActive(target);
    const namespace = findNamespaceOfAssetName(await this.namespaces(target.scope), asset.name);
    return {
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      scope: asset.scope,
      ...(namespace ? { namespace: namespace.prefix } : {}),
      revision: asset.revision,
      config: asset.config,
      updatedAt: asset.updatedAt
    };
  }

  /** The history of a name stays readable after its asset is deleted. */
  async listRevisions(call: AssetCall, address: AssetAddress, page: StorePage | undefined) {
    const target = await this.target(address);
    call.access.require(target.kind.actions.read, target.resource);
    if (!target.asset) {
      throw notFound(target);
    }
    const revisions = await this.options.configAssets.store.listConfigAssetRevisions({
      clientInstanceId: this.options.clientInstanceId,
      kind: target.kind.kind,
      name: target.name,
      page
    });
    return revisions.map((revision) => ({
      revision: revision.revision,
      operation: revision.operation,
      config: revision.config,
      actor: revision.actor,
      origin: revision.origin,
      globalVersion: revision.globalVersion,
      createdAt: revision.createdAt
    }));
  }

  /**
   * Creates the asset, or replaces it at the revision the caller read. Without an expected
   * revision the call is a create and is refused where the name is taken.
   */
  async put(
    call: AssetCall,
    input: AssetAddress & { config: Record<string, unknown>; expectedRevision?: number }
  ) {
    const target = await this.target(input);
    const { kind } = target;
    call.access.require(kind.actions.write, target.resource);
    await authorizeInteractiveWrite(this.options, call.actor, call, call.audit);
    requireMatchingConfigName(input.config, input.name);
    requireOwnScope(target);
    requireExpectedRevision(target, input.expectedRevision ?? null);
    return this.upsert(call, target, input.config, {
      expectedRevision: input.expectedRevision ?? null,
      audit: "config_asset.updated"
    });
  }

  /** Makes an earlier revision the content again, as a new revision. A deleted asset returns. */
  async revert(
    call: AssetCall,
    input: AssetAddress & { revision: number; expectedRevision: number }
  ) {
    const target = await this.target(input);
    call.access.require(target.kind.actions.write, target.resource);
    await authorizeInteractiveWrite(this.options, call.actor, call, call.audit);
    requireOwnScope(target);
    if (!target.asset) {
      throw notFound(target);
    }
    if (target.asset.revision !== input.expectedRevision) {
      throw conflict(target.kind.kind, target.name, target.asset.revision);
    }
    const revisions = await this.options.configAssets.store.listConfigAssetRevisions({
      clientInstanceId: this.options.clientInstanceId,
      kind: target.kind.kind,
      name: target.name
    });
    const restored = revisions.find((revision) => revision.revision === input.revision);
    if (!restored || restored.config === null) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Config asset revision ${input.revision} does not contain a restorable config`
      );
    }
    requireMatchingConfigName(restored.config, target.name);
    return this.upsert(call, target, restored.config, {
      expectedRevision: input.expectedRevision,
      operation: "revert",
      audit: "config_asset.reverted"
    });
  }

  async delete(call: AssetCall, input: AssetAddress & { expectedRevision: number }) {
    const target = await this.target(input);
    const { kind, name } = target;
    const right = deleteDecision(call.access, target);
    if (!right.allowed) {
      call.access.require(right.action, target.resource);
    }
    await authorizeInteractiveWrite(this.options, call.actor, call, call.audit);
    kind.assertInteractiveDeleteAllowed();
    const asset = requireActive(target);
    if (asset.revision !== input.expectedRevision) {
      throw conflict(kind.kind, name, asset.revision);
    }
    const stored = await loadStoredAssets(this.options);
    const clearsDefault = clearsLastDefault(stored.set, kind, name);
    requireInstanceDefaultChange(call.access, kind, clearsDefault);
    const removed = withoutDefinition(stored.set, kind.kind, name);
    validateAssetSet(
      this.options.configAssets.kinds.kinds,
      clearsDefault ? withDefaultAgentName(removed, undefined) : removed,
      stored.set
    );
    const result = await this.apply(call, {
      baseRevisions: { [assetKey(kind.kind, name)]: input.expectedRevision },
      ...(clearsDefault ? { baseDefaultAgentName: name } : {}),
      mutations: [
        { type: "delete", kind: kind.kind, name, scope: target.scope },
        ...(clearsDefault ? [{ type: "setDefaultAgent" as const, agentName: undefined }] : [])
      ]
    });
    // The store appends exactly one revision to the one the batch was checked against.
    const revision = input.expectedRevision + 1;
    await this.record(call, "config_asset.deleted", {
      kind: kind.kind,
      name,
      revision,
      version: result.version
    });
    return { version: result.version, revision, warnings: [] };
  }

  /**
   * Says what a put of this definition would be refused for, and writes nothing. It checks
   * what the write checks of the content: schema, name, references, the instance's own rules
   * and the lists of the Namespace. The caller's right to write is not part of the answer.
   * A reference to an asset the caller may not read is answered as one to nothing.
   */
  async validate(
    call: AssetCall,
    input: { kind: string; config: Record<string, unknown>; workspaceId?: string }
  ) {
    const name = readDefinitionName(input.config);
    const target = await this.target({ ...input, name: name ?? "" });
    const { kind } = target;
    call.access.require(kind.actions.read, target.resource);
    const kinds = this.options.configAssets.kinds.kinds;
    const stored = await loadStoredAssets(this.options);
    const view = await loadReferableAssets(this.options, call.access, stored, {
      scope: target.scope,
      name
    });
    const current = name === undefined ? undefined : findDefinition(view.set, kind.kind, name);
    const prepared = kind.prepareInteractiveUpsert({ current, next: input.config });
    const candidate = withDefinition(view.set, kind.kind, name ?? "", prepared);
    const found = findAssetSetIssues(kinds, candidate);
    const ofDefinition = view.complete
      ? found.issues
      : findIssuesOfChange(kinds, view.set, candidate, new Set([assetKey(kind.kind, name ?? "")]));
    const issues =
      ofDefinition.length > 0 ? ofDefinition : await this.writeIssues(call, view.set, found);
    return {
      valid: issues.length === 0,
      issues: issues.map(({ message, path }) => ({
        message,
        ...(path === undefined || path.length === 0 ? {} : { path: path.map(String) })
      }))
    };
  }

  sync(call: AssetCall, input: AssetSyncInput) {
    return syncAssets(this.options, call, input);
  }

  /** The instance's own rules, asked once the definitions themselves hold. */
  private async writeIssues(
    call: AssetCall,
    stored: AssetSet,
    found: ReturnType<typeof findAssetSetIssues>
  ): Promise<AssetSetIssue[]> {
    try {
      const issues = found.validateWrite(stored);
      if (issues.length > 0) return issues;
      const { refusals } = await findChangedAgentRefusals(
        this.options,
        call.access,
        stored,
        found.accepted
      );
      return refusals.flatMap(({ error }) => errorIssues(error));
    } catch (error) {
      if (isAppError(error) && error.code === "VALIDATION_FAILED") {
        return errorIssues(error);
      }
      throw error;
    }
  }

  private async upsert(
    call: AssetCall,
    target: AssetTarget,
    config: Record<string, unknown>,
    write: {
      expectedRevision: number | null;
      operation?: "revert";
      audit: "config_asset.updated" | "config_asset.reverted";
    }
  ) {
    const { kind, name } = target;
    const kinds = this.options.configAssets.kinds.kinds;
    const stored = await loadStoredAssets(this.options);
    const current = findDefinition(stored.set, kind.kind, name);
    const setsDefault = setsInitialDefault(stored.set, kind);
    requireInstanceDefaultChange(call.access, kind, setsDefault);
    // A revert restores what was stored: nothing is adjusted on the way.
    const definition =
      write.operation === "revert"
        ? config
        : kind.prepareInteractiveUpsert({ current, next: config });
    /** The set as the write would leave it. */
    const written = (set: AssetSet) => {
      const replaced = withDefinition(set, kind.kind, name, definition);
      return setsDefault ? withDefaultAgentName(replaced, name) : replaced;
    };
    await this.requireReadableReferences(call, target, stored, written);
    const validated = validateAssetSet(kinds, written(stored.set), stored.set);
    const namespaces = await assertChangedAgentsAllowed(
      this.options,
      call.access,
      stored.set,
      validated
    );
    const next = findDefinition(validated, kind.kind, name);
    if (next === undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Validated config ${kind.kind} '${name}' was not found`
      );
    }
    kind.assertInteractiveUpsertAllowed({ access: call.access, name, current, next, namespaces });
    const mutations: ConfigAssetMutation[] = [
      {
        type: "upsert",
        kind: kind.kind,
        name,
        config: toJsonObject(next),
        scope: target.scope,
        ...(write.operation ? { operation: write.operation } : {})
      }
    ];
    if (setsDefault) {
      mutations.push({ type: "setDefaultAgent", agentName: name });
    }
    const result = await this.apply(call, {
      baseRevisions: { [assetKey(kind.kind, name)]: write.expectedRevision },
      // The default is set for the first asset only, so the instance has none before.
      ...(setsDefault ? { baseDefaultAgentName: null } : {}),
      mutations
    });
    const updated = requireActive(
      await this.target({
        kind: kind.kind,
        name,
        ...(target.scope.kind === "workspace" ? { workspaceId: target.scope.workspaceId } : {})
      })
    );
    await this.record(call, write.audit, {
      kind: kind.kind,
      name,
      revision: updated.revision,
      version: result.version
    });
    return { version: result.version, revision: updated.revision, warnings: [] };
  }

  /**
   * Refuses a definition for what it refers to and its caller may not read, in the words of a
   * reference to nothing. The whole set is checked after it, as for every write.
   */
  private async requireReadableReferences(
    call: AssetCall,
    target: AssetTarget,
    stored: StoredAssets,
    written: (set: AssetSet) => AssetSet
  ): Promise<void> {
    const { kind, name, scope } = target;
    const view = await loadReferableAssets(this.options, call.access, stored, { scope, name });
    if (view.complete) return;
    const issues = findIssuesOfChange(
      this.options.configAssets.kinds.kinds,
      view.set,
      written(view.set),
      new Set([assetKey(kind.kind, name)])
    );
    if (issues.length > 0) {
      throw new AppError("VALIDATION_FAILED", INVALID_ASSET_SET_MESSAGE, { issues });
    }
  }

  /** Applies a batch. The store checks the expected revisions once more under its lock. */
  private async apply(call: AssetCall, batch: MutationBatch): Promise<{ version: number }> {
    try {
      return await applyValidatedConfigAssetMutations(this.options, {
        clientInstanceId: this.options.clientInstanceId,
        actor: auditActorFromIdentity(call.actor),
        ...batch
      });
    } catch (error) {
      const stale =
        isAppError(error) && error.code === "CONFLICT"
          ? conflictDetailsSchema.safeParse(error.details)
          : undefined;
      const [first] = stale?.success ? stale.data.conflicts : [];
      throw first ? conflict(first.kind, first.name, first.currentRevision) : error;
    }
  }

  private async record(call: AssetCall, type: string, metadata: JsonObject): Promise<void> {
    // The recorder of the Operation Run: the row names the run that wrote it.
    const auditRecorder = call.audit;
    await auditRecorder.record({
      type,
      status: "success",
      actor: auditActorFromIdentity(call.actor),
      correlationId: call.correlationId,
      metadata
    });
  }

  private kind(kind: string): WorkflowAssetKind {
    return this.options.configAssets.kinds.require(kind);
  }

  /** A Namespace is a prefix among the instance's own assets: a workspace's have none. */
  private async namespaces(scope: AssetScope): Promise<Namespace[]> {
    return scope.kind === "instance"
      ? this.options.stores.access.listNamespaceRecords({
          clientInstanceId: this.options.clientInstanceId
        })
      : [];
  }

  private async target(address: AssetAddress): Promise<AssetTarget> {
    const kind = this.kind(address.kind);
    const scope = scopeOf(address.workspaceId);
    const row =
      address.name === ""
        ? undefined
        : await this.options.configAssets.store.getConfigAsset({
            clientInstanceId: this.options.clientInstanceId,
            kind: kind.kind,
            name: address.name
          });
    // A deleted asset keeps its row, its revisions and the deny rows on it, so its history and
    // its name are decided with the same id as before the delete. A row of another scope is
    // not this call's asset: its id is no part of what the right is decided on.
    const asset = row && assetScopesEqual(row.scope, scope) ? row : undefined;
    return {
      kind,
      name: address.name,
      scope,
      ...(asset ? { asset } : {}),
      elsewhere: row !== undefined && asset === undefined,
      resource: accessResource(kind.kind, address.name, scope, asset?.id)
    };
  }
}

function scopeOf(workspaceId: string | undefined): AssetScope {
  return workspaceId === undefined
    ? INSTANCE_ASSET_SCOPE
    : { kind: "workspace", workspaceId: asCollaborationWorkspaceId(workspaceId) };
}

function requireActive(target: AssetTarget): ConfigAssetRecord & { config: JsonObject } {
  const { asset } = target;
  if (!asset || asset.status !== "active" || asset.config === null) {
    throw notFound(target);
  }
  return { ...asset, config: asset.config };
}

function notFound(target: Pick<AssetTarget, "kind" | "name">): AppError {
  return new AppError("NOT_FOUND", `Config ${target.kind.kind} '${target.name}' was not found`);
}

/**
 * A name belongs to one owner. A write that means another one is refused, never moved. Whether
 * the owner the call names can own the kind at all is asked first, so that refusal is the same
 * whether or not another owner holds the name: it tells nothing of an asset the caller may not
 * read.
 */
function requireOwnScope(target: AssetTarget): void {
  assertScopeCanOwn(target.kind.kind, target.scope);
  if (target.elsewhere) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Config ${target.kind.kind} '${target.name}' belongs to another scope`,
      { reason: "invalid_scope" }
    );
  }
}

/** `null` expects no active asset of the name: the call creates it. */
function requireExpectedRevision(target: AssetTarget, expected: number | null): void {
  const current = target.asset?.status === "active" ? target.asset.revision : null;
  if (current !== expected) {
    throw conflict(target.kind.kind, target.name, current);
  }
}

/** What a list shows of one asset. A stored definition its kind no longer reads shows its name. */
function summarize(kind: WorkflowAssetKind, record: ConfigAssetRecord) {
  try {
    const { title, description } = kind.summarize(record.config);
    return { name: record.name, title, ...(description === undefined ? {} : { description }) };
  } catch (error) {
    if (isAppError(error) && error.code === "VALIDATION_FAILED") {
      return { name: record.name, title: record.name };
    }
    throw error;
  }
}
