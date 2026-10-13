import {
  AppError,
  assetScopesEqual,
  auditActorFromIdentity,
  findNamespaceOfAssetName,
  isAppError,
  operationDenialError,
  type AuthenticatedIdentity,
  type ActorAccess,
  type ConfigAssetMutation,
  type ConfigAssetRevisionOrigin,
  type ConfigAssetStore,
  type AssetRepoWrite,
  type FileSet,
  type JsonObject,
  type OperationAuthorization,
  type PolicyTarget
} from "@vivd-catalyst/core";
import { afterRemove, afterWrite } from "./asset-after-write";
import { AssetDraftWorkflow } from "./asset-draft-workflow";
import type { AssetFileInput } from "./asset-files";
import { readDefinitionName, type WorkflowAssetKind } from "./asset-kinds/shared";
import {
  INVALID_ASSET_SET_MESSAGE,
  definitionsOf,
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
  missingUpsertRightOf,
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
  readsTarget,
  recordAssetEvent,
  recordCommitted,
  requireDeletable,
  requireExpectedRevision,
  requireOwnScope,
  type AssetAddress,
  type AssetTarget
} from "./asset-target";
import { AssetReadWorkflow, scopeOf } from "./asset-read-workflow";
import { requirePrecondition, revisionConflictOf } from "./asset-revision";
import { applyValidatedConfigAssetMutations } from "./config-asset-writer";
import type { AssetWorkflowOptions } from "./types";

type MutationBatch = Omit<
  Parameters<typeof applyValidatedConfigAssetMutations>[1],
  "clientInstanceId" | "actor"
>;
/**
 * One asset of any registered kind, read and written through the operation layer. Every call
 * addresses one scope and stays in it: a right on the instance's own assets, a Namespace
 * included, never reads or writes what a workspace owns, and the other way round.
 */
export class AssetWorkflow {
  private readonly options: AssetWorkflowOptions;
  /** The writes of a kind with a draft or with files. */
  readonly drafts: AssetDraftWorkflow;
  /** The list, the asset, one revision of it and its history. */
  readonly reads: AssetReadWorkflow;

  constructor(options: AssetWorkflowOptions) {
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

  /**
   * Every right of a write that names the revision it was made against, and after them the
   * precondition itself: the right on the asset, then what the write needs beside it, then
   * the revision. A caller without a right learns nothing else, and a write that names no
   * revision reaches neither the policy nor a guardrail.
   */
  async authorizeRevisionWrite(
    access: ActorAccess,
    input: AssetAddress & {
      expectedRevision?: number | null;
      config?: Record<string, unknown>;
      /** The revision a revert makes the content again: its config is what the write puts. */
      revision?: number;
    },
    right: "write" | "delete"
  ): Promise<OperationAuthorization> {
    const target = await this.target(input);
    const decision =
      right === "delete"
        ? deleteDecision(access, target)
        : decide(access, target.kind.actions.write, target.resource);
    if (!decision.allowed) {
      return decision;
    }
    const config =
      input.config ??
      (input.revision === undefined
        ? undefined
        : ((await this.revisionOf(target, input.revision))?.config ?? undefined));
    const further = await this.furtherRight(access, target, right, config);
    if (further.allowed) {
      requirePrecondition(input, input.expectedRevision);
    }
    return further;
  }

  /**
   * The rights a write of one asset needs beside the one on the asset: what the kind asks for
   * a put of this definition, such as the right to manage model settings, and the write right
   * on the instance where the write changes the instance default. They are decided on what the
   * caller sent and on the stored asset, before the revision is: a caller who lacks one is
   * told that and nothing of the revision.
   */
  private async furtherRight(
    access: ActorAccess,
    target: AssetTarget,
    right: "write" | "delete",
    config?: Record<string, unknown>
  ): Promise<OperationAuthorization> {
    const { kind, name } = target;
    if (right === "write" && config !== undefined && kind.representation !== "files") {
      const current = target.asset?.status === "active" ? target.asset.config : undefined;
      const action = missingUpsertRightOf(access, "put", kind, {
        name,
        current,
        next: kind.prepareInteractiveUpsert({ current, next: config }),
        namespaces: await this.options.stores.access.listNamespaceRecords({
          clientInstanceId: this.options.clientInstanceId
        })
      });
      if (action !== undefined) {
        return { allowed: false, action, reason: "no_grant" };
      }
    }
    // Only a holder of the write right on the instance changes its default, so only for
    // everyone else is the set read to see whether this write would.
    const instanceWrite = access.authorize(kind.actions.write);
    if (!kind.holdsInstanceDefault || instanceWrite.allowed) {
      return { allowed: true };
    }
    const stored = await loadStoredAssets(this.options);
    const changesDefault =
      right === "delete"
        ? target.asset?.status === "active" && clearsLastDefault(stored.set, kind, name)
        : setsInitialDefault(stored.set, kind);
    return changesDefault
      ? { allowed: false, action: kind.actions.write, reason: instanceWrite.reason }
      : { allowed: true };
  }

  private revisionOf(target: AssetTarget, revision: number) {
    return this.options.configAssets.store.getConfigAssetRevision({
      clientInstanceId: this.options.clientInstanceId,
      kind: target.kind.kind,
      name: target.name,
      revision
    });
  }

  /** Throws the refusal of `furtherRight`, as the operation layer answers a missing right. */
  private async requireFurtherRight(
    access: ActorAccess,
    target: AssetTarget,
    right: "write" | "delete",
    config?: Record<string, unknown>
  ): Promise<void> {
    const further = await this.furtherRight(access, target, right, config);
    if (!further.allowed) {
      throw operationDenialError({
        kind: "forbidden",
        action: further.action,
        reason: further.reason
      });
    }
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
   * Creates the asset, or replaces it at the revision the caller read. `null` as the expected
   * revision creates it and is refused where the name is taken or was deleted: a deleted
   * asset is created again by naming the revision of its delete. A call that names no
   * revision is refused.
   */
  async put(
    call: AssetCall,
    input: AssetAddress & {
      config?: Record<string, unknown>;
      files?: readonly AssetFileInput[];
      expectedRevision?: number | null;
    }
  ) {
    const target = await this.target(input);
    const { kind } = target;
    call.access.require(kind.actions.write, target.resource);
    await this.requireFurtherRight(call.access, target, "write", input.config);
    const expectedRevision = requirePrecondition(input, input.expectedRevision);
    await this.authorizeEditing(call, "put");
    assertStoredWritable(target, call.access);
    if (kind.representation === "files") {
      return this.drafts.putFiles(call, target, { ...input, expectedRevision });
    }
    if (input.config === undefined || input.files !== undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        `A ${kind.kind} is written as its config. It holds no files`,
        { reason: "config_required" }
      );
    }
    requireMatchingConfigName(input.config, input.name);
    requireOwnScope(target, call.access);
    await requireExpectedRevision(this.options, call, target, expectedRevision);
    assertStoredWritable(target, "always");
    return this.upsert(call, target, input.config, {
      expectedRevision,
      audit: "config_asset.updated"
    });
  }

  /** Makes an earlier revision the content again, as a new revision. A deleted asset returns. */
  async revert(
    call: AssetCall,
    input: AssetAddress & { revision: number; expectedRevision?: number }
  ) {
    const target = await this.target(input);
    call.access.require(target.kind.actions.write, target.resource);
    const restored = await this.revisionOf(target, input.revision);
    if (restored?.config) {
      await this.requireFurtherRight(call.access, target, "write", restored.config);
    }
    const expectedRevision = requirePrecondition(input, input.expectedRevision);
    await this.authorizeEditing(call, "revert");
    if (target.kind.lifecycle === "draft_published") {
      throw new AppError(
        "VALIDATION_FAILED",
        `A ${target.kind.kind} has a published revision: publish the earlier revision by its number with 'assets.publish'`,
        { reason: "use_publish" }
      );
    }
    assertStoredWritable(target, call.access);
    requireOwnScope(target, call.access);
    // A caller who does not read the asset is not told whether it was ever stored.
    if (!target.asset && readsTarget(call.access, target)) {
      throw notFound(target);
    }
    if (target.asset?.revision !== expectedRevision) {
      throw await revisionConflictOf(this.options, call.access, target);
    }
    assertStoredWritable(target, "always");
    if (!restored || restored.config === null) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Config asset revision ${input.revision} does not contain a restorable config`
      );
    }
    requireMatchingConfigName(restored.config, target.name);
    return this.upsert(call, target, restored.config, {
      expectedRevision,
      operation: "revert",
      audit: "config_asset.reverted"
    });
  }

  async delete(call: AssetCall, input: AssetAddress & { expectedRevision?: number }) {
    const target = await this.target(input);
    const { kind, name } = target;
    const right = deleteDecision(call.access, target);
    if (!right.allowed) {
      call.access.require(right.action, target.resource);
    }
    await this.requireFurtherRight(call.access, target, "delete");
    const expectedRevision = requirePrecondition(input, input.expectedRevision);
    await this.authorizeEditing(call, "delete");
    assertStoredWritable(target, call.access);
    assertDeleteWithinLimits(call.access, "delete", kind);
    await requireDeletable(this.options, call, target, expectedRevision);
    assertStoredWritable(target, "always");
    if (kind.representation === "files") {
      return this.drafts.remove(call, target, expectedRevision);
    }
    const stored = await loadStoredAssets(this.options);
    kind.assertRemovable?.({ name, definitions: (other) => definitionsOf(stored.set, other) });
    const clearsDefault = clearsLastDefault(stored.set, kind, name);
    requireInstanceDefaultChange(call.access, kind, clearsDefault);
    /** The set as the delete would leave it. */
    const deleted = (set: AssetSet) => {
      const removed = withoutDefinition(set, kind.kind, name);
      return clearsDefault ? withDefaultAgentName(removed, undefined) : removed;
    };
    this.requireTellableChange(call, target, stored, deleted);
    validateAssetSet(this.options.configAssets.kinds.kinds, deleted(stored.set), stored.set);
    const result = await this.apply(call, target, {
      baseRevisions: { [assetKey(kind.kind, name)]: expectedRevision },
      ...(clearsDefault ? { baseDefaultAgentName: name } : {}),
      mutations: [
        { type: "delete", kind: kind.kind, name, scope: target.scope },
        ...(clearsDefault ? [{ type: "setDefaultAgent" as const, agentName: undefined }] : [])
      ]
    });
    const revision = allocatedRevision(result, kind.kind, name);
    await recordCommitted(this.options, call, [
      () =>
        this.record(call, "config_asset.deleted", {
          kind: kind.kind,
          name,
          revision,
          version: result.version
        })
    ]);
    await afterRemove(this.options, call, target);
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
    const prepared = kind.prepareInteractiveUpsert({
      current,
      next: input.config,
      principalId: call.actor.id
    });
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
      issues: issues.map(({ message, path, code }) => ({
        message,
        ...(path === undefined || path.length === 0 ? {} : { path: path.map(String) }),
        ...(code === undefined ? {} : { code })
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
      /** The commit the revision names, for an asset whose files are a repository. */
      repository?: AssetRepoWrite;
      /** Where the revision came from, where it is not written as it stands. */
      origin?: ConfigAssetRevisionOrigin;
      /**
       * Asked under the lock of the write: whether the write makes the asset the asset of the
       * Page its origin names. It refuses the write by throwing.
       */
      pageLink?: () => Promise<boolean>;
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
        : kind.prepareInteractiveUpsert({ current, next: config, principalId: call.actor.id });
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
        ...(write.fileSet ?? {}),
        ...(write.repository ? { repository: write.repository } : {})
      }
    ];
    if (setsDefault) {
      mutations.push({ type: "setDefaultAgent", agentName: name });
    }
    let pageLinked = false;
    const { pageLink } = write;
    const result = await this.apply(call, target, {
      ...(pageLink
        ? {
            underLock: async () => {
              pageLinked = await pageLink();
            }
          }
        : {}),
      baseRevisions: { [assetKey(kind.kind, name)]: write.expectedRevision },
      // The default is set for the first asset only, so the instance has none before.
      ...(setsDefault ? { baseDefaultAgentName: null } : {}),
      ...(write.origin ? { origin: write.origin } : {}),
      mutations
    });
    // The revision this write was given. The asset is not read again: by now another write
    // may have given it a later one, which this caller did not make and must not be told as
    // the revision of its own content.
    const revision = allocatedRevision(result, kind.kind, name);
    await recordCommitted(this.options, call, [
      () =>
        this.record(call, write.audit, {
          kind: kind.kind,
          name,
          revision,
          version: result.version,
          // A revision that copies a Page names it: the trail says where the content came from.
          ...(write.origin?.kind === "page" ? { pageId: write.origin.pageId } : {}),
          ...(pageLinked ? { pageLinked: true } : {})
        })
    ]);
    await afterWrite(this.options, call, target, { previous: current, config: toJsonObject(next) });
    return { version: result.version, revision, warnings: [] };
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

  /**
   * Applies the write of one asset. The store checks the expected revision once more under
   * its lock, and a write that got in between is answered as every stale write is.
   */
  private async apply(
    call: AssetCall,
    target: AssetTarget,
    batch: MutationBatch
  ): ReturnType<ConfigAssetStore["applyConfigAssetMutations"]> {
    try {
      return await applyValidatedConfigAssetMutations(this.options, {
        clientInstanceId: this.options.clientInstanceId,
        actor: auditActorFromIdentity(call.actor),
        ...batch
      });
    } catch (error) {
      if (!isAppError(error) || error.code !== "REVISION_CONFLICT") throw error;
      const now = await this.target(target.address);
      throw await revisionConflictOf(this.options, call.access, now);
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
      ...(row !== undefined && asset === undefined
        ? { other: { id: row.id, scope: row.scope } }
        : {}),
      resource: accessResource(kind.kind, address.name, scope, asset?.id),
      address
    };
  }
}

/** The revision the store gave the asset in the write that just committed. */
function allocatedRevision(
  result: { revisions: Record<string, number> },
  kind: string,
  name: string
): number {
  const revision = result.revisions[assetKey(kind, name)];
  if (revision === undefined) {
    throw new AppError("INTERNAL", `The write of config ${kind} '${name}' has no revision`);
  }
  return revision;
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
