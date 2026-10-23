import type { AssetFileInput } from "./asset-files";
import { validateAssetDefinition } from "./asset-validation";
import type {
  AgentAvailability,
  AuthenticatedIdentity,
  ActorAccess,
  OperationAuthorization,
  PolicyTarget
} from "@work-shape/catalyst-core";
import type { AssetUpsert } from "./asset-upsert";
import { publishAgentDraft, publishFirstVersion } from "./agent-publication";
import { AgentDraftWorkflow } from "./agent-drafts";
import { AssetDraftWorkflow } from "./asset-draft-service";
import { readDefinitionName, type WorkflowAssetKind } from "../asset-kinds/shared";
import { decide, deleteDecision, type AssetCall } from "./asset-access";
import {
  assetSyncPolicyTargets,
  authorizeAssetSync,
  checkAssetSync,
  syncAssets,
  type AssetSyncInput
} from "./asset-sync";
import {
  authorizeInteractiveWrite,
  isReleaseSync,
  requireAssetKindModuleOn
} from "./asset-write-rules";
import {
  nameCheckOf,
  resolveAssetTarget,
  type AssetAddress,
  type AssetTarget
} from "./asset-target";
import { AssetReadWorkflow } from "./asset-read-service";
import type { AssetWorkflowOptions } from "../types";
import type { AssetVerbScope, EditingSurface } from "./verbs/scope";
import { writeAssetConfig } from "./verbs/apply";
import { deleteAsset } from "./verbs/delete";
import { assetPublishApproval, authorizeAssetPublish } from "./verbs/publish-rights";
import { putAsset } from "./verbs/put";
import { revertAsset } from "./verbs/revert";
import { authorizeRevisionWrite } from "./verbs/revision-rights";

/**
 * One asset of any registered kind, read and written through the operation layer. Every call
 * addresses one scope and stays in it: a right on the instance's own assets never reads or
 * writes what a workspace owns, and the other way round.
 */
export class AssetWorkflow {
  private readonly options: AssetWorkflowOptions;
  /** The writes of a kind with a draft or with files. */
  readonly drafts: AssetDraftWorkflow;
  readonly agentDrafts: AgentDraftWorkflow;
  /** The list, the asset, one revision of it and its history. */
  readonly reads: AssetReadWorkflow;
  private readonly scope: AssetVerbScope;

  constructor(options: AssetWorkflowOptions) {
    this.options = options;
    this.agentDrafts = new AgentDraftWorkflow(options, {
      target: (address) => this.target(address),
      publish: (call, target, draft, makeDependenciesAvailable, expectedAvailability) =>
        publishAgentDraft(
          options,
          call,
          target,
          draft,
          { makeDependenciesAvailable, expectedAvailability },
          (within, called) =>
            new AssetWorkflow(within).upsert(called, target, draft.config, {
              expectedRevision: draft.baseRevision,
              agentPublish: draft.revision,
              releaseDraft: draft.author.release,
              audit: "config_asset.updated"
            })
        ),
      publishFirstVersion: (call, target, revision) =>
        publishFirstVersion(options, call, target, revision)
    });
    this.reads = new AssetReadWorkflow(options, {
      target: (address) => this.target(address),
      kind: (kind) => this.kind(kind),
      policyTargets: (address) => this.policyTargets(address)
    });
    this.drafts = new AssetDraftWorkflow(options, {
      target: (address) => this.target(address),
      upsert: (call, target, config, write) => this.upsert(call, target, config, write),
      authorizeEditing: (call, surface) => this.authorizeEditing(call, surface)
    });
    this.scope = {
      options,
      drafts: this.drafts,
      agentDrafts: this.agentDrafts,
      reads: this.reads,
      target: (address) => this.target(address),
      within: (within) => new AssetWorkflow(within).scope,
      authorizeEditing: (call, surface) => this.authorizeEditing(call, surface)
    };
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
  authorizePublish(...args: DropScope<typeof authorizeAssetPublish>) {
    return authorizeAssetPublish(this.scope, ...args);
  }

  /**
   * Who decides a publish that a guardrail holds: the holders of the kind's `approve` right,
   * and the caller's own click where they hold it. None for a kind whose publish is not held.
   */
  publishApproval(...args: DropScope<typeof assetPublishApproval>) {
    return assetPublishApproval(this.scope, ...args);
  }

  async authorizeDelete(
    access: ActorAccess,
    address: AssetAddress
  ): Promise<OperationAuthorization> {
    return deleteDecision(access, await this.target(address));
  }

  /**
   * Every right of a write that names the revision it was made against, and after them the
   * precondition itself (`verbs/revision-rights.ts`).
   */
  authorizeRevisionWrite(...args: DropScope<typeof authorizeRevisionWrite>) {
    return authorizeRevisionWrite(this.scope, ...args);
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

  /** What the policy is asked about for a call on one asset: its kind and its owner. */
  policyTargets(address: { kind: string; name?: string; workspaceId?: string }): PolicyTarget[] {
    return [
      {
        assetKind: address.kind,
        ...(address.workspaceId === undefined ? {} : { workspaceId: address.workspaceId })
      }
    ];
  }

  /** What the policy is asked about for a batch: every kind its items name, and the owner. */
  syncPolicyTargets(input: AssetSyncInput): PolicyTarget[] {
    return assetSyncPolicyTargets(input);
  }

  /** Creates the asset, or replaces it at the revision the caller read (`verbs/put.ts`). */
  put(...args: DropScope<typeof putAsset>) {
    return putAsset(this.scope, ...args);
  }

  /** Makes an earlier revision the content again, as a new revision. A deleted asset returns. */
  revert(...args: DropScope<typeof revertAsset>) {
    return revertAsset(this.scope, ...args);
  }

  delete(...args: DropScope<typeof deleteAsset>) {
    return deleteAsset(this.scope, ...args);
  }

  /**
   * Says what a put of this definition would be refused for, and writes nothing. It checks
   * what the write checks of the content: schema, name, references, the instance's own rules,
   * the build limits of the workspace and the kind's check against what is stored, such as a
   * Workflow's child and dataset contracts. The caller's right to write is not part of the answer.
   * A reference to an asset the caller may not read is answered as one to nothing.
   */
  async validate(
    call: AssetCall,
    input: {
      kind: string;
      config: Record<string, unknown>;
      files?: readonly AssetFileInput[];
      workspaceId?: string;
      availability?: Omit<AgentAvailability, "collaborationWorkspaceIds"> & {
        collaborationWorkspaceIds: string[];
      };
    }
  ) {
    return validateAssetDefinition(this.options, call, input);
  }

  /**
   * Whether a create would take the name, asked with the right a create asks, and whether the
   * caller's create would wait for an approval. Writes nothing.
   */
  async checkName(call: AssetCall, input: AssetAddress) {
    const target = await this.target(input);
    call.access.require(target.kind.actions.write, target.resource);
    const check = nameCheckOf(target);
    if (!check.available) return check;
    const saveApproval = await this.reads.saveApproval(call, target);
    return saveApproval ? { ...check, saveApproval } : check;
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
    return writeAssetConfig(this.scope, call, target, config, write);
  }

  /** The editing switch of the instance, asked for the surface the write arrives through. */
  private authorizeEditing(call: AssetCall, surface: EditingSurface) {
    const releaseSync = isReleaseSync(call.access, surface);
    return authorizeInteractiveWrite(this.options, call.actor, call, call.audit, releaseSync);
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

/** The parameters of a verb after the scope the class passes it. */
type DropScope<Verb> = Verb extends (scope: AssetVerbScope, ...rest: infer Rest) => unknown
  ? Rest
  : never;
