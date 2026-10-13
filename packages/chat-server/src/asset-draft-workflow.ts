import {
  AppError,
  asUserId,
  createPlatformId,
  getSubjectUserId,
  isAppError,
  isAuthenticatedServicePrincipal,
  type AssetRepoWrite,
  type ConfigAssetStore,
  type FileSet
} from "@vivd-catalyst/core";
import type { AssetCall } from "./asset-access";
import {
  buildAssetFileSet,
  copyFileSetToAsset,
  decodeAssetFiles,
  removeUnnamedAssetFileSet,
  removeAssetObjects,
  sourceFileEntries,
  type AssetFileInput
} from "./asset-files";
import type { WorkflowAssetKind } from "./asset-kinds/shared";
import { commitAssetFileSet } from "./asset-repo-save";
import { requirePrecondition, revisionConflictOf } from "./asset-revision";
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
      repository?: AssetRepoWrite;
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
   * The write of a kind whose revisions hold files: the whole source set is built, its file
   * set stored for the asset, and the revision that names it becomes the draft. `null` as the
   * expected revision creates the asset. A set that does not build, a build that did
   * not end in time and a refused revision each leave no revision and no file set.
   */
  async putFiles(
    call: AssetCall,
    target: AssetTarget,
    input: { files?: readonly AssetFileInput[]; config?: unknown; expectedRevision: number | null }
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
    if (input.expectedRevision === null) {
      requireFreeName(target);
    }
    requireOwnScope(target, call.access);
    await requireExpectedRevision(this.options, call, target, input.expectedRevision);
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
    const { written } = await this.writeFilesRevision(call, target.address, {
      assetId,
      fileSet,
      config: configOf({
        name,
        manifest: fileSet.manifest,
        ...(current ? { current: current.config ?? undefined } : {})
      }),
      expectedRevision: input.expectedRevision
    });
    return written;
  }

  /**
   * Makes the revision that names a stored file set the draft of its asset. The file set was
   * stored for this write alone: a refused revision takes it along. A failure after the
   * revision was committed leaves the files, which are that revision's from then on.
   *
   * What a kind checks of a write has two phases, and a refusal in either writes nothing a
   * reader can see. In the container: what the files alone decide. The build that left the
   * file set read the manifest, which reached here as data, and for a repository the command
   * that makes the commit checks the tree. In this process, before the compare-and-swap of
   * the store: what the instance decides, which is the kind's `validateWrite` in the write
   * below. A commit whose revision is refused there stays a pending bundle, which the sweeper
   * removes.
   */
  private async writeFilesRevision(
    call: AssetCall,
    address: AssetAddress,
    write: {
      assetId: string;
      fileSet: FileSet;
      config: Record<string, unknown>;
      expectedRevision: number | null;
      /** Starts the repository of a new asset, with the one line its first commit carries. */
      firstCommit?: string;
    }
  ) {
    const target = await this.host.target(address);
    try {
      const repository = await this.commit(call, target, write);
      const written = await this.host.upsert(call, target, write.config, {
        expectedRevision: write.expectedRevision,
        audit: "config_asset.updated",
        fileSet: { assetId: write.assetId, fileSetId: write.fileSet.id },
        ...(repository ? { repository } : {})
      });
      return {
        written: {
          ...written,
          fileSetId: write.fileSet.id,
          files: sourceFileEntries(write.fileSet)
        },
        commit: repository?.commit
      };
    } catch (error) {
      await removeUnnamedAssetFileSet(this.options, write.assetId, write.fileSet.id).catch(
        () => undefined
      );
      throw error;
    }
  }

  /**
   * The commit of a write to an asset whose files are a repository: the source files of the
   * file set, on the commit of the draft. An asset of such a kind that has no repository yet
   * gets one where its write says so; until then its revisions name file sets alone.
   */
  private async commit(
    call: AssetCall,
    target: AssetTarget,
    write: { assetId: string; fileSet: FileSet; firstCommit?: string }
  ): Promise<AssetRepoWrite | undefined> {
    const baseCommit = target.asset?.commit ?? null;
    if (
      target.kind.content !== "repository" ||
      (baseCommit === null && write.firstCommit === undefined)
    ) {
      return undefined;
    }
    if (call.runId === undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The files of ${target.kind.kind} '${target.name}' are a repository, which is written by an Operation Run`,
        { reason: "repository_write_without_commit" }
      );
    }
    return commitAssetFileSet(this.options, {
      assetId: write.assetId,
      operationRunId: call.runId,
      fileSet: write.fileSet,
      baseCommit,
      actor: call.actor,
      kind: target.kind.kind,
      message: write.firstCommit ?? `Write ${target.kind.kind} '${target.name}'`
    });
  }

  /**
   * Creates an asset of a `files` kind from a file set that is stored already, such as the
   * revision of a Page: the files are copied below the asset's own prefix, as they are, and
   * the revision that names the copy is the draft. Nothing is published. Where the files of
   * the kind are a repository, the copy is its first commit.
   */
  async createFromFileSet(
    call: AssetCall,
    address: AssetAddress,
    input: { source: FileSet; config: Record<string, unknown>; firstCommit: string }
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
    const { written, commit } = await this.writeFilesRevision(call, address, {
      assetId,
      fileSet,
      config: input.config,
      expectedRevision: null,
      firstCommit: input.firstCommit
    });
    return { ...written, id: assetId, commit };
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
    const { config } = revision;
    await kind.authorizeLive?.({
      actor: call.actor,
      access: call.access,
      name,
      revision: input.revision,
      config
    });
    // The set as it would be were this revision the asset's content, checked as a write of it.
    const stored = await loadStoredAssets(this.options);
    const without = withoutDefinition(stored.set, kind.kind, name);
    validateAssetSet(
      this.options.configAssets.kinds.kinds,
      withDefinition(stored.set, kind.kind, name, config),
      without
    );
    const move = (store: Pick<ConfigAssetStore, "publishConfigAssetRevision">) =>
      store.publishConfigAssetRevision({
        clientInstanceId: this.options.clientInstanceId,
        kind: kind.kind,
        name,
        // The asset the right was checked on, and the revision that was checked above.
        assetId: asset.id,
        revision: input.revision,
        revisionId: revision.id,
        // A kind that reads its files itself has no built files to serve.
        ...(kind.representation === "files" && !kind.manifestOfFiles
          ? { requireFiles: true as const }
          : {})
      });
    const onPublish = kind.onPublish?.bind(kind);
    const published = onPublish
      ? await this.options.stores.transaction(async (stores) => {
          const moved = await move(stores.configAssets);
          await onPublish({
            clientInstanceId: this.options.clientInstanceId,
            access: call.access,
            assetId: moved.assetId,
            scope: asset.scope,
            revision: moved.revision,
            config,
            ...(asset.publishedConfig === undefined ? {} : { replaced: asset.publishedConfig }),
            stores
          });
          return moved;
        })
      : await move(this.options.configAssets.store);
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
  async discardDraft(call: AssetCall, input: AssetAddress & { expectedRevision?: number }) {
    const target = await this.host.target(input);
    const { kind, name } = target;
    call.access.require(kind.actions.write, target.resource);
    const expectedRevision = requirePrecondition(input, input.expectedRevision);
    publishAction(kind);
    await this.host.authorizeEditing(call, "put");
    const asset = requireActive(target);
    if (asset.revision !== expectedRevision) {
      throw await revisionConflictOf(this.options, call.access, target);
    }
    let discarded: { revision: number };
    try {
      discarded = await this.options.configAssets.store.discardConfigAssetDraft({
        clientInstanceId: this.options.clientInstanceId,
        kind: kind.kind,
        name,
        assetId: asset.id,
        expectedRevision: expectedRevision
      });
    } catch (error) {
      throw isAppError(error) && error.code === "CONFLICT"
        ? await revisionConflictOf(this.options, call.access, await this.host.target(input))
        : error;
    }
    await recordAssetEvent(call, "config_asset.draft_discarded", {
      kind: kind.kind,
      name,
      revision: discarded.revision,
      discardedRevision: expectedRevision
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
    const remove = (store: Pick<ConfigAssetStore, "removeConfigAsset">) =>
      store.removeConfigAsset({
        clientInstanceId: this.options.clientInstanceId,
        kind: kind.kind,
        name,
        assetId: requireActive(target).id,
        expectedRevision
      });
    const onRemove = kind.onRemove?.bind(kind);
    let removed: { assetId: string; fileSetCount: number };
    try {
      removed = onRemove
        ? await this.options.stores.transaction(async (stores) => {
            const gone = await remove(stores.configAssets);
            const published = target.asset?.publishedConfig;
            await onRemove({
              assetId: gone.assetId,
              ...(published === undefined ? {} : { published }),
              stores
            });
            return gone;
          })
        : await remove(this.options.configAssets.store);
    } catch (error) {
      throw isAppError(error) && error.code === "CONFLICT"
        ? await revisionConflictOf(
            this.options,
            call.access,
            await this.host.target(target.address)
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
