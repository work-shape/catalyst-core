import {
  AppError,
  assetScopesEqual,
  auditActorFromIdentity,
  findNamespaceOfAssetName,
  isAppError,
  type AuthenticatedIdentity,
  type ActorAccess,
  type ConfigAssetMutation,
  type ConfigAssetStore,
  type FileSet,
  type JsonObject,
  type OperationAuthorization,
  type PolicyTarget,
} from "@vivd-catalyst/core";
import { z } from "zod";
import { AssetDraftWorkflow } from "./asset-draft-workflow";
import type { AssetFileInput } from "./asset-files";
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
  checkAssetSync,
  syncAssets,
  type AssetSyncInput
} from "./asset-sync";
import {
  assertChangedAgentsAllowed,
  assertDeleteWithinLimits,
  assertUpsertWithinLimits,
  assetKey,
  authorizeInteractiveWrite,
  clearsLastDefault,
  findChangedAgentRefusals,
  findIssuesOfChange,
  isReleaseSync,
  loadReferableAssets,
  loadStoredAssets,
  type StoredAssets,
  requireInstanceDefaultChange,
  requireAssetKindModuleOn,
  requireMatchingConfigName,
  setsInitialDefault,
  toJsonObject
} from "./asset-write-rules";
import {
  assertStoredWritable,
  notFound,
  recordAssetEvent,
  requireActive,
  requireExpectedRevision,
  requireOwnScope,
  type AssetAddress,
  type AssetTarget
} from "./asset-target";
import { AssetReadWorkflow, scopeOf } from "./asset-read-workflow";
import { applyValidatedConfigAssetMutations } from "./config-asset-writer";
import type { ChatServerOptions } from "./types";

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
  /** The writes of a kind with a draft or with files. */
  readonly drafts: AssetDraftWorkflow;
  /** The list, the asset, one revision of it and its history. */
  readonly reads: AssetReadWorkflow;

  constructor(options: ChatServerOptions) {
    this.options = options;
    this.reads = new AssetReadWorkflow(options, {
      target: (address) => this.target(address),
      kind: (kind) => this.kind(kind)
    });
    this.drafts = new AssetDraftWorkflow(options, {
      target: (address) => this.target(address),
      upsert: (call, target, config, write) => this.upsert(call, target, config, write),
      authorizeEditing: (call, surface) => this.authorizeEditing(call, surface)
    });
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

  /**
   * The publish right of the kind. A kind without a published revision names none, and a call
   * on it passes here to be refused for that by the operation itself.
   */
  async authorizePublish(
    access: ActorAccess,
    address: AssetAddress
  ): Promise<OperationAuthorization> {
    const target = await this.target(address);
    const { publish } = target.kind.actions;
    return publish === undefined ? { allowed: true } : decide(access, publish, target.resource);
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
  async authorizeSync(
    actor: AuthenticatedIdentity,
    access: ActorAccess,
    input: AssetSyncInput
  ): Promise<OperationAuthorization> {
    await authorizeAssetSync(this.options, actor, access, input);
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
            await this.reads.namespaces(scopeOf(address.workspaceId)),
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
   * Creates the asset, or replaces it at the revision the caller read. Without an expected
   * revision the call is a create and is refused where the name is taken.
   */
  async put(
    call: AssetCall,
    input: AssetAddress & {
      config?: Record<string, unknown>;
      files?: readonly AssetFileInput[];
      expectedRevision?: number;
    }
  ) {
    const target = await this.target(input);
    const { kind } = target;
    call.access.require(kind.actions.write, target.resource);
    await this.authorizeEditing(call, "put");
    assertStoredWritable(target);
    if (kind.representation === "files") {
      return this.drafts.putFiles(call, target, input);
    }
    if (input.config === undefined || input.files !== undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        `A ${kind.kind} is written as its config. It holds no files`,
        { reason: "config_required" }
      );
    }
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
    await this.authorizeEditing(call, "revert");
    if (target.kind.lifecycle === "draft_published") {
      throw new AppError(
        "VALIDATION_FAILED",
        `A ${target.kind.kind} has a published revision: publish the earlier revision by its number with 'assets.publish'`,
        { reason: "use_publish" }
      );
    }
    assertStoredWritable(target);
    requireOwnScope(target);
    if (!target.asset) {
      throw notFound(target);
    }
    if (target.asset.revision !== input.expectedRevision) {
      throw conflict(target.kind.kind, target.name, target.asset.revision);
    }
    const restored = await this.options.configAssets.store.getConfigAssetRevision({
      clientInstanceId: this.options.clientInstanceId,
      kind: target.kind.kind,
      name: target.name,
      revision: input.revision
    });
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
    await this.authorizeEditing(call, "delete");
    assertStoredWritable(target);
    assertDeleteWithinLimits(call.access, "delete", kind);
    const asset = requireActive(target);
    if (asset.revision !== input.expectedRevision) {
      throw conflict(kind.kind, name, asset.revision);
    }
    if (kind.representation === "files") {
      return this.drafts.remove(call, target, input.expectedRevision);
    }
    const stored = await loadStoredAssets(this.options);
    const clearsDefault = clearsLastDefault(stored.set, kind, name);
    requireInstanceDefaultChange(call.access, kind, clearsDefault);
    /** The set as the delete would leave it. */
    const deleted = (set: AssetSet) => {
      const removed = withoutDefinition(set, kind.kind, name);
      return clearsDefault ? withDefaultAgentName(removed, undefined) : removed;
    };
    this.requireTellableChange(call, target, stored, deleted);
    validateAssetSet(this.options.configAssets.kinds.kinds, deleted(stored.set), stored.set);
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
    const view = loadReferableAssets(this.options, call.access, stored);
    const current = name === undefined ? undefined : findDefinition(view.set, kind.kind, name);
    const prepared = kind.prepareInteractiveUpsert({ current, next: input.config });
    const drafted = (set: AssetSet) => withDefinition(set, kind.kind, name ?? "", prepared);
    const found = findAssetSetIssues(kinds, drafted(view.set));
    const ofDefinition = view.complete
      ? found.issues
      : findIssuesOfChange(
          kinds,
          stored.set,
          view,
          drafted,
          new Set([assetKey(kind.kind, name ?? "")])
        );
    // What is stored and read-only is refused before the definition is read, as a put is.
    const readOnly = storedWritableIssues(kind, current);
    const issues =
      readOnly ??
      (ofDefinition.length > 0 ? ofDefinition : await this.writeIssues(call, view.set, found));
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

  /** What `sync` would refuse the batch for, asked without writing anything. */
  checkSync(call: AssetCall, input: AssetSyncInput) {
    return checkAssetSync(this.options, call, input);
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
      /** The stored file set of the revision, with the id its asset has or gets. */
      fileSet?: { assetId: string; fileSetId: FileSet["id"] };
    }
  ) {
    const { kind, name } = target;
    const surface = write.operation === "revert" ? "revert" : "put";
    const kinds = this.options.configAssets.kinds.kinds;
    const stored = await loadStoredAssets(this.options);
    const current = findDefinition(stored.set, kind.kind, name);
    kind.assertStoredWritable?.({ current });
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
    this.requireTellableChange(call, target, stored, written);
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
    assertUpsertWithinLimits(call.access, surface, kind, { name, current, next, namespaces });
    const mutations: ConfigAssetMutation[] = [
      {
        type: "upsert",
        kind: kind.kind,
        name,
        config: toJsonObject(next),
        scope: target.scope,
        ...(write.operation ? { operation: write.operation } : {}),
        // A kind with a published revision moves its draft with a write and nothing else.
        ...(kind.lifecycle === "draft_published" ? { draft: true as const } : {}),
        ...(write.fileSet ?? {})
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
   * Refuses a change for what its caller may be told: a reference to an asset the caller may
   * not read in the words of a reference to nothing, and an issue of such an asset without
   * its name. A caller who reads everything is left to the check of the whole set after it.
   */
  private requireTellableChange(
    call: AssetCall,
    target: AssetTarget,
    stored: StoredAssets,
    written: (set: AssetSet) => AssetSet
  ): void {
    const { kind, name } = target;
    const view = loadReferableAssets(this.options, call.access, stored);
    if (view.complete) return;
    const issues = findIssuesOfChange(
      this.options.configAssets.kinds.kinds,
      stored.set,
      view,
      written,
      new Set([assetKey(kind.kind, name)])
    );
    if (issues.length > 0) {
      throw new AppError("VALIDATION_FAILED", INVALID_ASSET_SET_MESSAGE, { issues });
    }
  }

  /** The editing switch of the instance, asked for the surface the write arrives through. */
  private authorizeEditing(call: AssetCall, surface: "put" | "delete" | "revert") {
    const releaseSync = isReleaseSync(call.access, surface);
    return authorizeInteractiveWrite(this.options, call.actor, call, call.audit, releaseSync);
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

  private record(call: AssetCall, type: string, metadata: JsonObject): Promise<void> {
    return recordAssetEvent(call, type, metadata);
  }

  /** A kind of a module that is off does not exist here, whatever the store still holds. */
  private kind(kind: string): WorkflowAssetKind {
    requireAssetKindModuleOn(this.options.modules, kind);
    return this.options.configAssets.kinds.require(kind);
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
      resource: accessResource(kind.kind, address.name, scope, asset?.id),
      address
    };
  }
}

/** What the kind refuses a write of the stored asset for, whatever the write says. */
function storedWritableIssues(
  kind: WorkflowAssetKind,
  current: unknown
): AssetSetIssue[] | undefined {
  if (current === undefined) return undefined;
  try {
    kind.assertStoredWritable?.({ current });
    return undefined;
  } catch (error) {
    if (isAppError(error)) return errorIssues(error);
    throw error;
  }
}
