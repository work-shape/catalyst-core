import {
  AppError,
  asUserId,
  createPlatformId,
  getSubjectUserId,
  isAppError,
  isAuthenticatedServicePrincipal,
  liveRevisionId,
  type ActorAccess,
  type ConfigAssetRecord,
  type FileSet,
  type JsonObject
} from "@vivd-catalyst/core";
import { conflict, type AssetCall } from "./asset-access";
import {
  buildAssetFileSet,
  copyFileSetToAsset,
  decodeAssetFiles,
  readSourceFiles,
  removeUnnamedAssetFileSet,
  removeAssetObjects,
  sourceFileEntries,
  type AssetFileInput,
  type AssetFileOutput
} from "./asset-files";
import type { WorkflowAssetKind } from "./asset-kinds/shared";
import { validateAssetSet, withDefinition, withoutDefinition } from "./asset-set";
import {
  recordAssetEvent,
  requireActive,
  requireExpectedRevision,
  requireFreeName,
  requireOwnScope,
  type AssetAddress,
  type AssetTarget
} from "./asset-target";
import { loadStoredAssets, requireMatchingConfigName } from "./asset-write-rules";
import { assertScopeCanOwn } from "./config-asset-writer";
import type { ChatServerOptions } from "./types";

/** What the writes below use of the workflow of every asset. */
export interface AssetWorkflowHost {
  target(address: AssetAddress): Promise<AssetTarget>;
  /** Writes one revision of one asset, checked as every write of the asset set is. */
  upsert(
    call: AssetCall,
    target: AssetTarget,
    config: Record<string, unknown>,
    write: {
      expectedRevision: number | null;
      audit: "config_asset.updated";
      fileSet?: { assetId: string; fileSetId: FileSet["id"] };
    }
  ): Promise<{ version: number; revision: number; warnings: never[] }>;
  authorizeEditing(call: AssetCall, surface: "put"): Promise<void>;
}

/**
 * What an asset has whose kind keeps a draft beside the published revision, or whose revisions
 * hold files: the write of a file set, the publish, the discard of a draft, and the delete
 * that takes the files along. The right of the caller is asked here, on the target of the
 * call; the checks of the asset set stay those of every write.
 */
export class AssetDraftWorkflow {
  private readonly options: ChatServerOptions;
  private readonly host: AssetWorkflowHost;

  constructor(options: ChatServerOptions, host: AssetWorkflowHost) {
    this.options = options;
    this.host = host;
  }

  /**
   * The right a read of one revision asks. The published revision is what the kind's readers
   * are shown, and its writers too. The draft and every numbered revision are for whoever
   * writes or publishes the asset. A kind without a published revision asks its read right.
   */
  readAction(access: ActorAccess, target: AssetTarget, revision: string | undefined): string {
    const { kind, resource } = target;
    const { read, write, publish } = kind.actions;
    const holds = (action: string) => access.authorize(action, resource).allowed;
    if (kind.lifecycle !== "draft_published") {
      return read;
    }
    if (revision === "published") {
      return !holds(read) && holds(write) ? write : read;
    }
    return !holds(write) && publish !== undefined && holds(publish) ? publish : write;
  }

  /**
   * What a read answers of one revision: its config, its number, and its source files where
   * the call asked for them. Nothing here asks a right: the caller of this holds
   * `readAction`.
   */
  async revisionContent(
    target: AssetTarget,
    asset: ConfigAssetRecord & { config: JsonObject },
    input: { revision?: string; files?: boolean }
  ): Promise<{
    config: JsonObject;
    contentRevision?: number;
    files?: AssetFileOutput[];
    filesOmitted?: true;
  }> {
    const { kind, name } = target;
    const selector = input.revision ?? "draft";
    if (input.files && kind.representation !== "files") {
      throw new AppError("VALIDATION_FAILED", `A ${kind.kind} holds no files`, {
        reason: "no_files"
      });
    }
    if (kind.lifecycle !== "draft_published") {
      if (selector !== "draft") {
        throw new AppError(
          "VALIDATION_FAILED",
          `A ${kind.kind} has no published revision: its earlier revisions are read with 'assets.revisions.list'`,
          { reason: "no_draft" }
        );
      }
      return { config: asset.config };
    }
    const content = await this.revisionOf(target, asset, selector);
    if (!input.files) {
      return { config: content.config, contentRevision: content.revision };
    }
    const fileSet = content.fileSetId
      ? await this.options.stores.pages.getAssetFileSet({
          clientInstanceId: this.options.clientInstanceId,
          assetId: asset.id,
          fileSetId: content.fileSetId
        })
      : undefined;
    if (!fileSet) {
      throw new AppError(
        "NOT_FOUND",
        `The files of revision ${content.revision} of ${kind.kind} '${name}' are not stored any more`,
        { reason: "revision_files_removed", revision: content.revision }
      );
    }
    return {
      config: content.config,
      contentRevision: content.revision,
      ...(await readSourceFiles(this.options, fileSet))
    };
  }

  /** The revision a selector names: the draft, the published one, or one by its number. */
  private async revisionOf(
    target: AssetTarget,
    asset: ConfigAssetRecord & { config: JsonObject },
    selector: string
  ): Promise<{ revision: number; config: JsonObject; fileSetId?: FileSet["id"] }> {
    const { kind, name } = target;
    if (selector === "draft") {
      return {
        revision: asset.revision,
        config: asset.config,
        ...(asset.fileSetId ? { fileSetId: asset.fileSetId } : {})
      };
    }
    const published =
      liveRevisionId(asset, kind) === undefined ? undefined : asset.publishedRevision;
    if (selector === "published" && published === undefined) {
      throw new AppError("NOT_FOUND", `The ${kind.kind} '${name}' is not published`, {
        reason: "not_published"
      });
    }
    const number = selector === "published" ? published : Number(selector);
    const revision =
      number === undefined
        ? undefined
        : await this.options.configAssets.store.getConfigAssetRevision({
            clientInstanceId: this.options.clientInstanceId,
            kind: kind.kind,
            name,
            revision: number
          });
    if (!revision || revision.config === null) {
      throw new AppError("NOT_FOUND", `Config ${kind.kind} '${name}' has no revision ${selector}`, {
        reason: "revision_unknown"
      });
    }
    return {
      revision: revision.revision,
      config: revision.config,
      ...(revision.fileSetId ? { fileSetId: revision.fileSetId } : {})
    };
  }

  /**
   * The write of a kind whose revisions hold files: the whole source set is built, its file
   * set stored for the asset, and the revision that names it becomes the draft. Without an
   * expected revision the call creates the asset. A set that does not build, a build that did
   * not end in time and a refused revision each leave no revision and no file set.
   */
  async putFiles(
    call: AssetCall,
    target: AssetTarget,
    input: { files?: readonly AssetFileInput[]; config?: unknown; expectedRevision?: number }
  ) {
    const { kind, name } = target;
    const configOf = kind.configOfFiles;
    if (input.files === undefined || input.config !== undefined || !configOf) {
      throw new AppError(
        "VALIDATION_FAILED",
        `A ${kind.kind} is written as its files: the whole source set, with '${kind.manifestFile ?? "its manifest"}' among it`,
        { reason: "files_required" }
      );
    }
    await this.requireOwner(target);
    const current = target.asset?.status === "active" ? target.asset : undefined;
    if (input.expectedRevision === undefined) {
      requireFreeName(target);
    }
    requireOwnScope(target);
    requireExpectedRevision(target, input.expectedRevision ?? null);
    const files = decodeAssetFiles(input.files);
    // A new asset's id is made here: its files are stored under it before its row exists.
    const assetId = target.asset?.id ?? createPlatformId("cfga");
    const fileSet = await buildAssetFileSet(this.options, {
      kind,
      name,
      assetId,
      files,
      ...(isAuthenticatedServicePrincipal(call.actor)
        ? {}
        : { requestedByUserId: asUserId(getSubjectUserId(call.actor)) })
    });
    return this.writeFilesRevision(call, target.address, {
      assetId,
      fileSet,
      config: configOf({
        name,
        manifest: fileSet.manifest,
        ...(current ? { current: current.config ?? undefined } : {})
      }),
      expectedRevision: input.expectedRevision ?? null
    });
  }

  /**
   * Makes the revision that names a stored file set the draft of its asset. The file set was
   * stored for this write alone: a refused revision takes it along. A failure after the
   * revision was committed leaves the files, which are that revision's from then on.
   */
  private async writeFilesRevision(
    call: AssetCall,
    address: AssetAddress,
    write: {
      assetId: string;
      fileSet: FileSet;
      config: Record<string, unknown>;
      expectedRevision: number | null;
    }
  ) {
    const target = await this.host.target(address);
    try {
      const written = await this.host.upsert(call, target, write.config, {
        expectedRevision: write.expectedRevision,
        audit: "config_asset.updated",
        fileSet: { assetId: write.assetId, fileSetId: write.fileSet.id }
      });
      return {
        ...written,
        fileSetId: write.fileSet.id,
        files: sourceFileEntries(write.fileSet)
      };
    } catch (error) {
      await removeUnnamedAssetFileSet(this.options, write.assetId, write.fileSet.id).catch(
        () => undefined
      );
      throw error;
    }
  }

  /**
   * Creates an asset of a `files` kind from a file set that is stored already, such as the
   * revision of a Page: the files are copied below the asset's own prefix, as they are, and
   * the revision that names the copy is the draft. Nothing is published.
   */
  async createFromFileSet(
    call: AssetCall,
    address: AssetAddress,
    input: { source: FileSet; config: Record<string, unknown> }
  ) {
    const target = await this.host.target(address);
    const { kind } = target;
    call.access.require(kind.actions.write, target.resource);
    await this.host.authorizeEditing(call, "put");
    if (kind.representation !== "files") {
      throw new AppError("VALIDATION_FAILED", `A ${kind.kind} holds no files`, {
        reason: "config_required"
      });
    }
    await this.requireOwner(target);
    requireFreeName(target);
    requireMatchingConfigName(input.config, address.name);
    const assetId = createPlatformId("cfga");
    const fileSet = await copyFileSetToAsset(this.options, {
      source: input.source,
      assetId,
      ...(isAuthenticatedServicePrincipal(call.actor)
        ? {}
        : { createdByUserId: asUserId(getSubjectUserId(call.actor)) })
    });
    const written = await this.writeFilesRevision(call, address, {
      assetId,
      fileSet,
      config: input.config,
      expectedRevision: null
    });
    return { ...written, id: assetId };
  }

  /**
   * Makes one revision the one the asset's users are served, in one transaction. The number is
   * one of this asset; naming an earlier one is the way back. The references of that revision
   * are checked against the instance as it is now, as a write's are.
   */
  async publish(call: AssetCall, input: AssetAddress & { revision: number }) {
    const target = await this.host.target(input);
    const { kind, name } = target;
    const right = publishAction(kind);
    call.access.require(right, target.resource);
    await this.host.authorizeEditing(call, "put");
    const asset = requireActive(target);
    const revision = await this.options.configAssets.store.getConfigAssetRevision({
      clientInstanceId: this.options.clientInstanceId,
      kind: kind.kind,
      name,
      revision: input.revision
    });
    if (!revision || revision.config === null) {
      throw new AppError(
        "NOT_FOUND",
        `Config ${kind.kind} '${name}' has no revision ${input.revision} to publish`,
        { reason: "revision_unknown", revision: input.revision }
      );
    }
    // The set as it would be were this revision the asset's content, checked as a write of it.
    const stored = await loadStoredAssets(this.options);
    const { config } = revision;
    const without = withoutDefinition(stored.set, kind.kind, name);
    validateAssetSet(
      this.options.configAssets.kinds.kinds,
      withDefinition(stored.set, kind.kind, name, config),
      without
    );
    const published = await this.options.configAssets.store.publishConfigAssetRevision({
      clientInstanceId: this.options.clientInstanceId,
      kind: kind.kind,
      name,
      revision: input.revision,
      ...(kind.representation === "files" ? { requireFiles: true as const } : {})
    });
    const metadata = {
      kind: kind.kind,
      name,
      revision: published.revision,
      ...(published.replacedRevision === undefined
        ? {}
        : { replacedRevision: published.replacedRevision })
    };
    // An App's publication is named as its own: what reads the trail looks for it there.
    await (kind.kind === "app"
      ? recordAssetEvent(call, "app.published", metadata)
      : recordAssetEvent(call, "config_asset.published", metadata));
    return {
      draftRevision: asset.revision,
      publishedRevision: published.revision,
      ...(published.replacedRevision === undefined
        ? {}
        : { replacedRevision: published.replacedRevision })
    };
  }

  /** Moves the draft back to the published revision. The revisions in between stay readable. */
  async discardDraft(call: AssetCall, input: AssetAddress & { expectedRevision: number }) {
    const target = await this.host.target(input);
    const { kind, name } = target;
    publishAction(kind);
    call.access.require(kind.actions.write, target.resource);
    await this.host.authorizeEditing(call, "put");
    const asset = requireActive(target);
    if (asset.revision !== input.expectedRevision) {
      throw conflict(kind.kind, name, asset.revision);
    }
    let discarded: { revision: number };
    try {
      discarded = await this.options.configAssets.store.discardConfigAssetDraft({
        clientInstanceId: this.options.clientInstanceId,
        kind: kind.kind,
        name,
        expectedRevision: input.expectedRevision
      });
    } catch (error) {
      throw isAppError(error) && error.code === "CONFLICT"
        ? conflict(kind.kind, name, (await this.host.target(input)).asset?.revision ?? null)
        : error;
    }
    await recordAssetEvent(call, "config_asset.draft_discarded", {
      kind: kind.kind,
      name,
      revision: discarded.revision,
      discardedRevision: input.expectedRevision
    });
    return { draftRevision: discarded.revision, publishedRevision: discarded.revision };
  }

  /**
   * The delete of a kind whose revisions hold files: the asset, its revisions and the rows of
   * its file sets go in one transaction, and the stored objects after it. Nothing of it can
   * return, so no revision is appended. The runs and audit rows that name the asset stay.
   */
  async remove(call: AssetCall, target: AssetTarget, expectedRevision: number) {
    const { kind, name } = target;
    const state = await this.options.configAssets.store.getConfigAssetState({
      clientInstanceId: this.options.clientInstanceId
    });
    let removed: { assetId: string; fileSetCount: number };
    try {
      removed = await this.options.configAssets.store.removeConfigAsset({
        clientInstanceId: this.options.clientInstanceId,
        kind: kind.kind,
        name,
        expectedRevision
      });
    } catch (error) {
      throw isAppError(error) && error.code === "CONFLICT"
        ? conflict(
            kind.kind,
            name,
            (await this.host.target(target.address)).asset?.revision ?? null
          )
        : error;
    }
    await recordAssetEvent(call, "config_asset.deleted", {
      kind: kind.kind,
      name,
      revision: expectedRevision,
      version: state.version,
      fileSets: removed.fileSetCount
    });
    // The rows are gone, so nothing serves these objects any more. A failure here leaves bytes
    // nothing reads; the call is answered as failed and repeating it finds no asset.
    await removeAssetObjects(this.options, removed.assetId);
    return { version: state.version, revision: expectedRevision, warnings: [] };
  }

  /** The workspace a write names as the owner exists and is open. */
  private async requireOwner(target: AssetTarget): Promise<void> {
    assertScopeCanOwn(target.kind, target.scope);
    if (target.scope.kind !== "workspace") {
      return;
    }
    const workspace = await this.options.stores.workspaces.getWorkspace(
      this.options.clientInstanceId,
      target.scope.workspaceId
    );
    if (!workspace) {
      throw new AppError("NOT_FOUND", "The workspace is not available");
    }
  }
}

/** The publish right of a kind, or the refusal of a kind that has no published revision. */
function publishAction(kind: WorkflowAssetKind): string {
  const { publish } = kind.actions;
  if (kind.lifecycle !== "draft_published" || publish === undefined) {
    throw new AppError(
      "VALIDATION_FAILED",
      `A ${kind.kind} has no published revision: a write of it is live at once`,
      { reason: "no_draft" }
    );
  }
  return publish;
}
