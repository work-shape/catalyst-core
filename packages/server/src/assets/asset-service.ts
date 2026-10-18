import { requireAppAudience } from "../apps/app-audience";
import type { AppAudience } from "@work-shape/catalyst-core";
import { upsertAsset, type AssetUpsert } from "./asset-upsert";
import { AgentDraftWorkflow } from "./agent-drafts";
import {
  AppError,
  auditActorFromIdentity,
  findNamespaceOfAssetName,
  isAppError,
  operationDenialError,
  type AuthenticatedIdentity,
  type ActorAccess,
  type ConfigAssetStore,
  type JsonObject,
  type OperationApproval,
  type OperationAuthorization,
  type OperationOrigin,
  type PolicyTarget
} from "@work-shape/catalyst-core";
import { afterRemove } from "./asset-after-write";
import { AssetDraftWorkflow } from "./asset-draft-service";
import type { AssetFileInput } from "./asset-files";
import {
  readDefinitionName,
  type AssetWriteFollowUp,
  type WorkflowAssetKind
} from "../asset-kinds/shared";
import {
  INVALID_ASSET_SET_MESSAGE,
  findAssetSetIssues,
  findDefinition,
  validateAssetSet,
  withDefaultAgentName,
  withDefinition,
  withoutDefinition,
  type AssetSet
} from "./asset-set";
import { decide, deleteDecision, type AssetCall } from "./asset-access";
import {
  assetSyncPolicyTargets,
  authorizeAssetSync,
  checkAssetSync,
  syncAssets,
  type AssetSyncInput
} from "./asset-sync";
import {
  assertDeleteWithinLimits,
  requireAssetManagementOn,
  assetKey,
  authorizeInteractiveWrite,
  clearsLastDefault,
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
  storedWritableIssues,
  withPublishedConfigs,
  writeIssuesOf
} from "./asset-write-rules";
import {
  assertStoredWritable,
  nameCheckOf,
  notFound,
  readsTarget,
  recordAssetEvent,
  recordCommitted,
  requireDeletable,
  requireExpectedRevision,
  requireOwnScope,
  resolveAssetTarget,
  scopeOf,
  type AssetAddress,
  type AssetTarget
} from "./asset-target";
import { type AssetWarning, type AvailableIn } from "./asset-placement";
import { AssetReadWorkflow } from "./asset-read-service";
import { requirePrecondition, revisionConflictOf } from "./asset-revision";
import { applyValidatedConfigAssetMutations } from "./config-asset-writer";
import { assertReferencesWithinOwners } from "./asset-owner-references";
import { liveRevision } from "./asset-live-revision";
import { appPublishReview } from "../apps/app-publish-reach";
import { publishApproval, publishFromAPerson } from "../approvals/publish-approval";
import type { AssetWorkflowOptions } from "../types";

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
  readonly agentDrafts: AgentDraftWorkflow;
  /** The list, the asset, one revision of it and its history. */
  readonly reads: AssetReadWorkflow;

  constructor(options: AssetWorkflowOptions) {
    this.options = options;
    this.agentDrafts = new AgentDraftWorkflow(options, {
      target: (address) => this.target(address),
      publish: async (call, target, draft) => {
        await authorizeInteractiveWrite(
          options,
          call.actor,
          call,
          call.audit,
          draft.author.release
        );
        return this.upsert(call, target, draft.config, {
          expectedRevision: draft.baseRevision,
          agentPublish: draft.revision,
          releaseDraft: draft.author.release,
          audit: "config_asset.updated"
        });
      }
    });
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
   * The publish right of the kind and the kind's own check of the revision it makes live. A
   * kind without a published revision names none, and a call on it passes here to be refused
   * for that by the operation itself.
   */
  async authorizePublish(
    caller: { actor: AuthenticatedIdentity; access: ActorAccess; origin: OperationOrigin },
    address: AssetAddress & { revision: number; audience?: AppAudience }
  ): Promise<OperationAuthorization> {
    const { access, origin } = caller;
    if (address.kind === "app") requireAppAudience(access, address.audience);
    if (address.kind === "agent")
      return this.agentDrafts.authorizePublish(
        { ...caller, audit: this.options.auditRecorder, correlationId: "" },
        address
      );
    requireAssetManagementOn(this.options, access, "put");
    const target = await this.target(address);
    const { publish } = target.kind.actions;
    if (publish === undefined) return { allowed: true };
    const right = publishFromAPerson(target, origin) ?? decide(access, publish, target.resource);
    // What the revision lends is asked of the caller now too: a publish that waits for an
    // approval is filed only where its caller could make it live.
    if (right.allowed && target.asset?.status === "active") {
      await liveRevision(this.options, caller, target, address.revision);
    }
    return right;
  }

  /**
   * Who decides a publish that a guardrail holds: the holders of the kind's `approve` right,
   * and the caller's own click where they hold it. None for a kind whose publish is not held.
   */
  async publishApproval(
    input: AssetAddress & { revision: number; audience?: AppAudience }
  ): Promise<OperationApproval | undefined> {
    const target = await this.target(input);
    const asset = target.asset;
    const revision =
      target.kind.kind === "app"
        ? await this.options.configAssets.store.getConfigAssetRevision({
            clientInstanceId: this.options.clientInstanceId,
            kind: input.kind,
            name: input.name,
            revision: input.revision
          })
        : undefined;
    const widens =
      asset && revision?.config
        ? appPublishReview(asset, target.kind, revision.config, input.audience).publishWidens
        : undefined;
    return publishApproval(target, input.revision, input.audience, undefined, widens);
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
    // A revert restores content: who does not read the asset is refused before the guardrails
    // read the revision, so no answer of theirs tells what it holds. A name of no asset of
    // this scope has nothing to restore and is refused by the revert as a free name is.
    if (input.revision !== undefined && target.asset && !readsTarget(access, target)) {
      return decide(access, target.kind.actions.read, target.resource);
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
        : setsInitialDefault(stored.set, kind, target.scope);
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
      expectedDraftRevision?: number | null;
      availableIn?: AvailableIn;
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
    if (kind.revisionFiles && input.files !== undefined) {
      if (input.config !== undefined) {
        throw new AppError(
          "VALIDATION_FAILED",
          `A ${kind.kind} is written as its config or as its files, with '${kind.revisionFiles.manifestFile}' among them, and not as both at once`,
          { reason: "config_and_files" }
        );
      }
      requireOwnScope(target, call.access);
      await requireExpectedRevision(this.options, call, target, expectedRevision);
      assertStoredWritable(target, "always");
      return this.drafts.putFolder(call, target, input.files, expectedRevision);
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
      audit: "config_asset.updated",
      expectedDraftRevision: input.expectedDraftRevision ?? null,
      ...(input.availableIn === undefined ? {} : { availableIn: input.availableIn })
    });
  }

  /** Makes an earlier revision the content again, as a new revision. A deleted asset returns. */
  async revert(
    call: AssetCall,
    input: AssetAddress & {
      revision: number;
      expectedRevision?: number;
      expectedDraftRevision?: number | null;
    }
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
      expectedDraftRevision: input.expectedDraftRevision ?? null,
      audit: "config_asset.reverted",
      // The files of the restored revision come back with it. They were never removed.
      ...(target.kind.revisionFiles && restored.fileSetId && target.asset
        ? { fileSet: { assetId: target.asset.id, fileSetId: restored.fileSetId } }
        : {})
    });
  }

  async delete(call: AssetCall, input: AssetAddress & { expectedRevision?: number }) {
    const target = await this.target(input);
    const { kind, name } = target;
    const right = deleteDecision(call.access, target);
    if (!right.allowed) {
      if (right.action === undefined) throw operationDenialError({ kind: "forbidden", ...right });
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
    await kind.assertRemovable?.({
      name,
      assets: (other) => withPublishedConfigs(this.options, stored.assets, other)
    });
    const clearsDefault = clearsLastDefault(stored.set, kind, name);
    requireInstanceDefaultChange(call.access, kind, clearsDefault);
    /** The set as the delete would leave it. */
    const deleted = (set: AssetSet) => {
      const removed = withoutDefinition(set, kind.kind, name);
      return clearsDefault ? withDefaultAgentName(removed, undefined) : removed;
    };
    this.requireTellableChange(call, target, stored, deleted);
    validateAssetSet(this.options.configAssets.kinds.kinds, deleted(stored.set), stored.set);
    const result = await this.apply(
      call,
      target,
      {
        baseRevisions: { [assetKey(kind.kind, name)]: expectedRevision },
        ...(clearsDefault ? { baseDefaultAgentName: name } : {}),
        mutations: [
          { type: "delete", kind: kind.kind, name, scope: target.scope },
          ...(clearsDefault ? [{ type: "setDefaultAgent" as const, agentName: undefined }] : [])
        ]
      },
      { previous: target.asset?.config, config: undefined }
    );
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
   * what the write checks of the content: schema, name, references, the instance's own rules,
   * the lists of the Namespace and the kind's check against what is stored, such as a
   * Workflow's child and dataset contracts. The caller's right to write is not part of the answer.
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
    const found = findAssetSetIssues(kinds, drafted(view.set), view.set);
    const ofDefinition = view.complete
      ? found.issues
      : findIssuesOfChange(
          kinds,
          stored.set,
          view,
          drafted,
          new Set([assetKey(kind.kind, name ?? "")]),
          call.runtime?.locale ?? this.options.config.localization.defaultLocale
        );
    // What is stored and read-only is refused before the definition is read, as a put is.
    const readOnly = storedWritableIssues(kind, current);
    const checked =
      readOnly || ofDefinition.length > 0
        ? { issues: readOnly ?? ofDefinition, warnings: [] }
        : await writeIssuesOf(
            this.options,
            call.access,
            view.set,
            found,
            async () => {
              const { scope } = target;
              const write = { type: "upsert", kind: kind.kind, name: name ?? "", scope } as const;
              await assertReferencesWithinOwners(
                kinds,
                [{ ...write, config: prepared }],
                stored.assets,
                call.runtime?.locale ?? this.options.config.localization.defaultLocale,
                this.options
              );
            },
            {
              names: kind.kind === "agent" && name !== undefined ? [name] : [],
              scope:
                target.scope.kind === "workspace" ? { workspaceId: target.scope.workspaceId } : {}
            },
            // A put asks this of the validated definition before it stores it; so does a check.
            () =>
              kind.assertScopedWrite?.({
                clientInstanceId: this.options.clientInstanceId,
                scope: target.scope,
                name: name ?? "",
                definition: findDefinition(found.accepted, kind.kind, name ?? "") ?? prepared,
                stores: this.options.stores
              }) ?? Promise.resolve()
          );
    return {
      valid: checked.issues.length === 0,
      ...nonEmptyWarnings([
        ...checked.warnings,
        // A definition that holds is asked what its kind warns of; one with issues is not.
        ...(checked.issues.length > 0
          ? []
          : ((await kind.validationWarnings?.({
              clientInstanceId: this.options.clientInstanceId,
              definition: prepared,
              stores: this.options.stores
            })) ?? []))
      ]),
      issues: checked.issues.map(({ message, path, code }) => ({
        message,
        ...(path === undefined || path.length === 0 ? {} : { path: path.map(String) }),
        ...(code === undefined ? {} : { code })
      }))
    };
  }

  /** Whether a create would take the name, asked with the right a create asks. Writes nothing. */
  async checkName(call: AssetCall, input: AssetAddress) {
    const target = await this.target(input);
    call.access.require(target.kind.actions.write, target.resource);
    return nameCheckOf(target);
  }

  sync(call: AssetCall, input: AssetSyncInput) {
    return syncAssets(this.options, call, input);
  }

  /** What `sync` would refuse the batch for, asked without writing anything. */
  checkSync(call: AssetCall, input: AssetSyncInput) {
    return checkAssetSync(this.options, call, input);
  }

  private upsert(
    call: AssetCall,
    target: AssetTarget,
    config: Record<string, unknown>,
    write: AssetUpsert
  ) {
    return upsertAsset(this.options, call, target, config, write, {
      requireTellableChange: (stored, written) =>
        this.requireTellableChange(call, target, stored, written),
      apply: (batch, write) => this.apply(call, target, batch, write)
    });
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
      new Set([assetKey(kind.kind, name)]),
      call.runtime?.locale ?? this.options.config.localization.defaultLocale
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
    batch: MutationBatch,
    write?: { previous: unknown; config: JsonObject | undefined }
  ): ReturnType<ConfigAssetStore["applyConfigAssetMutations"]> {
    const actor = auditActorFromIdentity(call.actor);
    const within = target.kind.withinWrite?.bind(target.kind);
    try {
      if (within === undefined || write === undefined) {
        return await applyValidatedConfigAssetMutations(
          this.options,
          {
            clientInstanceId: this.options.clientInstanceId,
            actor,
            ...batch
          },
          call.runtime?.locale
        );
      }
      // The kind's part of the write commits with the revision or not at all.
      const followUps: AssetWriteFollowUp[] = [];
      let result: Awaited<ReturnType<ConfigAssetStore["applyConfigAssetMutations"]>>;
      try {
        result = await this.options.stores.transaction(async (stores) => {
          const applied = await applyValidatedConfigAssetMutations(
            {
              ...this.options,
              configAssets: { ...this.options.configAssets, store: stores.configAssets }
            },
            { clientInstanceId: this.options.clientInstanceId, actor, ...batch },
            call.runtime?.locale
          );
          const followUp = await within({
            clientInstanceId: this.options.clientInstanceId,
            name: target.name,
            assetId: target.asset?.status === "active" ? target.asset.id : undefined,
            previousRevision: target.asset?.status === "active" ? target.asset.revision : undefined,
            ...write,
            actor,
            correlationId: call.correlationId,
            stores
          });
          if (followUp !== undefined) followUps.push(followUp);
          return applied;
        });
      } catch (error) {
        for (const followUp of followUps) followUp.rolledBack();
        throw error;
      }
      for (const followUp of followUps) await followUp.committed();
      return result;
    } catch (error) {
      if (!isAppError(error) || error.code !== "REVISION_CONFLICT") throw error;
      if (
        typeof error.details === "object" &&
        error.details !== null &&
        "reason" in error.details &&
        error.details.reason === "draft_changed"
      )
        throw error;
      if (
        batch.mutations.some(
          (mutation) => mutation.type === "upsert" && mutation.agentPublish !== undefined
        )
      ) {
        throw new AppError("CONFLICT", "The live agent changed since the draft was written", {
          reason: "stale_base"
        });
      }
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

  private target(address: AssetAddress): Promise<AssetTarget> {
    return resolveAssetTarget(this.options, this.kind(address.kind), address);
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

/** The warnings of an answer, left out where there are none. */
function nonEmptyWarnings(warnings: AssetWarning[]): { warnings?: AssetWarning[] } {
  return warnings.length > 0 ? { warnings } : {};
}
