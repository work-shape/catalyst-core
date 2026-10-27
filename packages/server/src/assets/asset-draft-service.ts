import { appPublishReview } from "../apps/app-publish-reach";
import { prepareAppPublication } from "../apps/app-audience";
import { removeDraftHosts } from "../apps/draft-hosts";
import { APP_ASSET_KIND } from "@work-shape/catalyst-api-contract";
import type { AppAudience } from "@work-shape/catalyst-core";
import { createHash } from "node:crypto";
import { clearLiveOnceSwitches } from "./asset-after-write";
import {
  AppError,
  GUARDRAIL_ASSET_KIND,
  asUserId,
  auditActorFromIdentity,
  createPlatformId,
  getSubjectUserId,
  isAppError,
  isAuthenticatedServicePrincipal,
  type AssetRepoWrite,
  type AssetScope,
  type ConfigAssetRevisionOrigin,
  type ConfigAssetStore,
  type FileSet,
  type JsonObject
} from "@work-shape/catalyst-core";
import type { AssetCall } from "./asset-access";
import type { AssetWarning } from "./asset-placement";
import {
  buildAssetFileSet,
  readRevisionFolder,
  copyFileSetToAsset,
  decodeAssetFiles,
  removeUnnamedAssetFileSet,
  removeAssetObjects,
  sourceFileEntries,
  storeRevisionFiles,
  type AssetFileInput
} from "./asset-files";
import type { WorkflowAssetKind } from "../asset-kinds/shared";
import { commitAssetFileSet, reasonOf } from "./asset-repo-save";
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
import { liveRevision } from "./asset-live-revision";
import { loadStoredAssets, requireMatchingConfigName, toJsonObject } from "./asset-write-rules";
import { assertScopeCanOwn } from "./config-asset-writer";
import type { AssetWorkflowOptions } from "../types";

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
      origin?: ConfigAssetRevisionOrigin;
      pageLink?: () => Promise<boolean>;
      /** The files of the write as its event names them: path, hash and size, no content. */
      auditFiles?: readonly { path: string; sha256: string; bytes: number }[];
      /** Files of this folder write, used only for the kind's warnings. Never audited. */
      warningFiles?: readonly { path: string; bytes: Uint8Array }[];
    }
  ): Promise<{ version: number; revision: number; warnings: AssetWarning[] }>;
  authorizeEditing(call: AssetCall, surface: "put"): Promise<void>;
}

/** The Page revision a file set was read from, as the revision that copies it records it. */
export type PageRevisionOrigin = Extract<ConfigAssetRevisionOrigin, { kind: "page" }>;

/**
 * What an asset has whose kind keeps a draft beside the published revision, or whose revisions
 * hold files: the write of a file set, the publish, the discard of a draft, and the delete
 * that takes the files along. The right of the caller is asked here, on the target of the
 * call; the checks of the asset set stay those of every write.
 */
export class AssetDraftWorkflow {
  private readonly options: AssetWorkflowOptions;
  private readonly host: AssetWorkflowHost;

  constructor(options: AssetWorkflowOptions, host: AssetWorkflowHost) {
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
   * The write of a kind whose revision is a config with files beside it, as its whole folder:
   * the files are read into the config, checked as every write of the config is, and kept in
   * a file set the revision names. A refused revision leaves no file set. Its caller has
   * asked the right, the owner and the expected revision.
   */
  async putFolder(
    call: AssetCall,
    target: AssetTarget,
    sent: readonly AssetFileInput[],
    expectedRevision: number | null
  ) {
    const { kind, name } = target;
    const files = decodeAssetFiles(sent);
    const read = kind.revisionFiles?.read(name, files);
    if (!read) throw new AppError("INTERNAL", `A ${kind.kind} holds no files`);
    requireMatchingConfigName(read.config, name);
    // What the event of the write says of the files: each by its path and hash, no content.
    const entries = files
      .map((file) => ({
        path: file.path,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        bytes: file.bytes.byteLength
      }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const { written, fileSet } = await this.writeFolder(call, target, {
      ...read,
      files,
      expectedRevision,
      auditFiles: entries,
      warningFiles: files
    });
    return { ...written, ...(fileSet ? { fileSetId: fileSet.id } : {}), files: entries };
  }

  /**
   * The write of the config alone of a kind whose folder is a repository (WF-GIT-1): the
   * folder is the config written out, so the write is the write of that folder, committed as
   * any other. The config is stored as it was sent, after the kind's own preparation of an
   * interactive save, so the folder says what the revision says. Its caller has asked the
   * right, the owner and the expected revision.
   */
  async putConfig(
    call: AssetCall,
    target: AssetTarget,
    sent: Record<string, unknown>,
    expectedRevision: number | null
  ) {
    const { kind } = target;
    const hook = kind.revisionFiles;
    if (!hook) throw new AppError("INTERNAL", `A ${kind.kind} holds no files`);
    const config = kind.prepareInteractiveUpsert({
      current: target.asset?.status === "active" ? target.asset.config : undefined,
      next: sent,
      principalId: call.actor.id
    });
    const own = hook.filesOfConfig(config);
    const previous = target.asset?.status === "active" ? target.asset : undefined;
    const oldOwn = new Set(
      previous ? hook.filesOfConfig(previous.config).map((file) => file.path) : []
    );
    const before = previous?.fileSetId
      ? (
          await readRevisionFolder(this.options, kind, {
            assetId: previous.id,
            config: previous.config,
            fileSetId: previous.fileSetId
          })
        ).files
      : [];
    const edited = own.map((file) => {
      const old = before.find((candidate) => candidate.path === file.path);
      if (!old || file.path !== hook.manifestFile || !hook.editManifest) return file;
      const bytes = hook.editManifest(config, old.bytes);
      if (bytes !== undefined) return { path: file.path, bytes };
      this.options.logger.warn(
        { kind: kind.kind, event: "asset_config_file_edit_fallback" },
        "Config file edit fell back to a full render"
      );
      return file;
    });
    const carried = before.filter(
      (file) => !oldOwn.has(file.path) && !own.some((next) => next.path === file.path)
    );
    const files = [...edited, ...carried];
    const read = files.length ? hook.read(target.name, files) : { config, extras: [] };
    const { written } = await this.writeFolder(call, target, {
      ...read,
      files,
      expectedRevision
    });
    return written;
  }

  /**
   * Stores the folder of one write as a file set of the asset, commits it where the asset's
   * files are a repository, and writes the revision that names both. A new asset of such a
   * kind starts its repository with this write; one whose draft names no commit, from before
   * its kind had a repository, gets the file set and no commit until it is adopted. A write
   * that is refused, or a commit that is not made, leaves no file set; a commit whose
   * revision is refused stays a pending bundle, which the sweeper removes.
   */
  private async writeFolder(
    call: AssetCall,
    target: AssetTarget,
    write: {
      config: Record<string, unknown>;
      files: readonly { path: string; bytes: Uint8Array }[];
      extras: readonly string[];
      expectedRevision: number | null;
      /** What the event of a folder write names of its files. */
      auditFiles?: readonly { path: string; sha256: string; bytes: number }[];
      /** The files of a folder write, for the kind's warnings alone. */
      warningFiles?: readonly { path: string; bytes: Uint8Array }[];
    }
  ) {
    const { kind, name } = target;
    // A new asset's id is made here: its files are stored under it before its row exists.
    const assetId = target.asset?.id ?? createPlatformId("cfga");
    const fileSet =
      write.files.length === 0
        ? undefined
        : await storeRevisionFiles(this.options, {
            kind,
            assetId,
            files: write.files,
            extras: write.extras,
            ...(isAuthenticatedServicePrincipal(call.actor)
              ? {}
              : { createdByUserId: asUserId(getSubjectUserId(call.actor)) })
          });
    try {
      const repository = fileSet
        ? await this.commit(call, target, {
            assetId,
            fileSet,
            ...(target.asset === undefined ? { firstCommit: `Create ${kind.kind} '${name}'` } : {})
          })
        : undefined;
      // The config names the files it does not hold, from the rows of the file set.
      const config =
        kind.revisionFiles?.indexed(toJsonObject(write.config), fileSet) ?? write.config;
      const written = await this.host.upsert(call, target, config, {
        expectedRevision: write.expectedRevision,
        audit: "config_asset.updated",
        ...(write.auditFiles ? { auditFiles: write.auditFiles } : {}),
        ...(write.warningFiles ? { warningFiles: write.warningFiles } : {}),
        ...(fileSet ? { fileSet: { assetId, fileSetId: fileSet.id } } : {}),
        ...(repository ? { repository } : {})
      });
      return { written, fileSet };
    } catch (error) {
      if (fileSet) {
        await removeUnnamedAssetFileSet(this.options, assetId, fileSet.id).catch(() => undefined);
      }
      // Another save moved the draft while this one was committed on it, or the adoption gave
      // the draft read without a commit its commit meanwhile (WF-GIT-2): the caller read a
      // draft that is not the draft any more, which is answered as every stale write is.
      const adoptedMeanwhile =
        isAppError(error) &&
        kind.content === "repository" &&
        target.asset?.commit === undefined &&
        reasonOf(error) === "repository_write_without_commit";
      if (
        isAppError(error) &&
        ((error.code === "CONFLICT" && reasonOf(error) === "draft_moved") || adoptedMeanwhile)
      ) {
        throw await revisionConflictOf(
          this.options,
          call.access,
          await this.host.target(target.address)
        );
      }
      throw error;
    }
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
      origin?: ConfigAssetRevisionOrigin;
      pageLink?: () => Promise<boolean>;
    }
  ) {
    const target = await this.host.target(address);
    try {
      const repository = await this.commit(call, target, write);
      const written = await this.host.upsert(call, target, write.config, {
        expectedRevision: write.expectedRevision,
        audit: "config_asset.updated",
        fileSet: { assetId: write.assetId, fileSetId: write.fileSet.id },
        ...(repository ? { repository } : {}),
        ...(write.origin ? { origin: write.origin } : {}),
        ...(write.pageLink ? { pageLink: write.pageLink } : {})
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
   * the kind are a repository, the copy is its first commit. The revision records the Page,
   * which is how `replaceFromFileSet` knows the asset again.
   */
  async createFromFileSet(
    call: AssetCall,
    address: AssetAddress,
    input: {
      source: FileSet;
      config: Record<string, unknown>;
      origin: PageRevisionOrigin;
      firstCommit: string;
    }
  ) {
    const target = await this.requireFilesWrite(call, address);
    requireFreeName(target);
    requireMatchingConfigName(input.config, address.name);
    const assetId = createPlatformId("cfga");
    const { written, commit } = await this.writeCopy(call, address, {
      assetId,
      source: input.source,
      config: input.config,
      expectedRevision: null,
      origin: input.origin,
      firstCommit: input.firstCommit
    });
    return { ...written, id: assetId, commit };
  }

  /**
   * Writes the revision of a Page as the next draft revision of an asset, from a copy of its
   * files. The published revision stays where it is. The asset's Page is the one its newest
   * revision with a Page names. An asset of another Page, or of none, is written only with
   * `link`, and is that Page's asset from then on. A draft at another revision than the caller
   * read is not written either way.
   */
  async replaceFromFileSet(
    call: AssetCall,
    address: AssetAddress,
    input: {
      source: FileSet;
      /** The config of the new revision, from the config of the draft it replaces. */
      configOf(current: JsonObject): Record<string, unknown>;
      expectedRevision: number;
      origin: PageRevisionOrigin;
      /** Whether an asset that is not this Page's may be made this Page's by the write. */
      link: boolean;
    }
  ) {
    const target = await this.requireFilesWrite(call, address);
    requireOwnScope(target, call.access);
    const asset = requireActive(target);
    // Asked twice: here, so a refused write copies no file, and under the lock of the write,
    // where no other write can give the asset another Page any more.
    await this.linksPage(target, asset.id, input);
    await requireExpectedRevision(this.options, call, target, input.expectedRevision);
    const { written } = await this.writeCopy(call, address, {
      assetId: asset.id,
      source: input.source,
      config: input.configOf(asset.config),
      expectedRevision: input.expectedRevision,
      origin: input.origin,
      pageLink: () => this.linksPage(target, asset.id, input)
    });
    return { ...written, id: asset.id };
  }

  /** The target of a write from a stored file set, for a caller who may write it. */
  private async requireFilesWrite(call: AssetCall, address: AssetAddress): Promise<AssetTarget> {
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
    return target;
  }

  /**
   * Whether the write makes the asset the Page's: `false` for an asset that is the Page's
   * already. An asset of another Page, or of none, is refused unless the write says `link`.
   */
  private async linksPage(
    target: AssetTarget,
    assetId: string,
    write: { origin: PageRevisionOrigin; link: boolean }
  ): Promise<boolean> {
    const { kind, name } = target;
    const current = await this.options.configAssets.store.getConfigAssetPageOrigin({
      clientInstanceId: this.options.clientInstanceId,
      assetId
    });
    if (current?.pageId === write.origin.pageId) {
      return false;
    }
    if (!write.link) {
      throw new AppError(
        "CONFLICT",
        `The ${kind.kind} '${name}' is not updated from this Page. Send 'link' to make it so`,
        { reason: `${kind.kind}_not_from_page`, kind: kind.kind, name }
      );
    }
    return true;
  }

  /** Copies a stored file set below the asset and makes the copy its draft revision. */
  private async writeCopy(
    call: AssetCall,
    address: AssetAddress,
    write: {
      assetId: string;
      source: FileSet;
      config: Record<string, unknown>;
      expectedRevision: number | null;
      origin: PageRevisionOrigin;
      firstCommit?: string;
      pageLink?: () => Promise<boolean>;
    }
  ) {
    const fileSet = await copyFileSetToAsset(this.options, {
      source: write.source,
      assetId: write.assetId,
      ...(isAuthenticatedServicePrincipal(call.actor)
        ? {}
        : { createdByUserId: asUserId(getSubjectUserId(call.actor)) })
    });
    return this.writeFilesRevision(call, address, {
      assetId: write.assetId,
      fileSet,
      config: write.config,
      expectedRevision: write.expectedRevision,
      origin: write.origin,
      ...(write.firstCommit === undefined ? {} : { firstCommit: write.firstCommit }),
      ...(write.pageLink ? { pageLink: write.pageLink } : {})
    });
  }

  /**
   * What a publish asks before it moves anything: the right, the audience of an App, the
   * revision and what it lends, and the set as it would be were this revision the asset's
   * content, checked as a write of it. An App's Publish asks it before it publishes the Data
   * Stores named with it (GOLIVE-1), so a refusal here publishes none of them.
   */
  async checkPublish(
    call: AssetCall,
    input: AssetAddress & { revision: number; audience?: AppAudience }
  ) {
    const target = await this.host.target(input);
    const { kind, name } = target;
    call.access.require(publishAction(kind), target.resource);
    await this.host.authorizeEditing(call, "put");
    const asset = requireActive(target);
    const { audience, personalWorkspace } =
      kind.kind === "app"
        ? await prepareAppPublication(this.options, call, asset, input.audience)
        : { audience: undefined, personalWorkspace: undefined };
    const revision = await liveRevision(this.options, call, target, input.revision);
    const stored = await loadStoredAssets(this.options);
    validateAssetSet(
      this.options.configAssets.kinds.kinds,
      withDefinition(stored.set, kind.kind, name, revision.config),
      withoutDefinition(stored.set, kind.kind, name)
    );
    return { target, asset, audience, personalWorkspace, revision };
  }

  /**
   * Makes one revision the one the asset's users are served, in one transaction. The number is
   * one of this asset; naming an earlier one is the way back. The references of that revision
   * are checked against the instance as it is now, as a write's are.
   */
  async publish(
    call: AssetCall,
    input: AssetAddress & { revision: number; confirmProcessing?: string; audience?: AppAudience }
  ) {
    const { target, asset, audience, personalWorkspace, revision } = await this.checkPublish(
      call,
      input
    );
    const { kind, name } = target;
    const { config } = revision;
    const publishReview = audience ? appPublishReview(asset, kind, config, audience) : undefined;
    const move = (store: Pick<ConfigAssetStore, "publishConfigAssetRevision">) =>
      store.publishConfigAssetRevision({
        clientInstanceId: this.options.clientInstanceId,
        kind: kind.kind,
        name,
        actor: auditActorFromIdentity(call.actor),
        // The asset the right was checked on, and the revision that was checked above.
        assetId: asset.id,
        revision: input.revision,
        revisionId: revision.id,
        ...(audience && publishReview ? { audience, appPublishReview: publishReview } : {}),
        ...(personalWorkspace ? { audienceWorkspaceId: personalWorkspace.id } : {}),
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
            actor: call.actor,
            revisionId: revision.id,
            clientInstanceId: this.options.clientInstanceId,
            access: call.access,
            assetId: moved.assetId,
            scope: asset.scope,
            revision: moved.revision,
            config,
            ...(input.confirmProcessing ? { confirmProcessing: input.confirmProcessing } : {}),
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
      publication: published.publication,
      ...(published.publishWidens === undefined ? {} : { publish_widens: published.publishWidens }),
      ...(audience ? { audience } : {}),
      ...(published.replacedRevision === undefined
        ? {}
        : { replacedRevision: published.replacedRevision })
    };
    // An App's and a Guardrail's publication are named as their own: what reads the trail
    // looks for them there. A guardrail's names its scope, which is where it enforces.
    await (kind.kind === "app"
      ? recordAssetEvent(call, "app.published", metadata)
      : kind.kind === GUARDRAIL_ASSET_KIND
        ? recordAssetEvent(call, "guardrail.published", {
            ...metadata,
            ...scopeMetadata(asset.scope)
          })
        : recordAssetEvent(call, "config_asset.published", metadata));
    return {
      draftRevision: asset.revision,
      publishedRevision: published.revision,
      ...(published.replacedRevision === undefined
        ? {}
        : { replacedRevision: published.replacedRevision })
    };
  }

  /**
   * Takes the published revision of a guardrail away: the draft stays, and nothing of it acts until it is published
   * again. Asks the publish right, as making it live does.
   */
  async unpublish(call: AssetCall, input: AssetAddress) {
    const target = await this.host.target(input);
    const { kind, name } = target;
    // A kind that withdraws live bindings may keep its draft and historical runs.
    if (kind.kind !== GUARDRAIL_ASSET_KIND && kind.onUnpublish === undefined) {
      throw new AppError("VALIDATION_FAILED", `A ${kind.kind} is taken back by a delete`, {
        reason: "no_unpublish"
      });
    }
    call.access.require(publishAction(kind), target.resource);
    await this.host.authorizeEditing(call, "put");
    const asset = requireActive(target);
    if (kind.kind === GUARDRAIL_ASSET_KIND && asset.publishedConfig !== undefined) {
      await kind.authorizeLive?.({
        actor: call.actor,
        access: call.access,
        name,
        revision: asset.publishedRevision ?? asset.revision,
        config: asset.publishedConfig
      });
    }
    const warnings =
      (await kind.liveCallerWarnings?.({
        clientInstanceId: this.options.clientInstanceId,
        name,
        stores: this.options.stores,
        access: call.access
      })) ?? [];
    const unpublished = await this.options.stores.transaction(async (stores) => {
      const moved = await stores.configAssets.unpublishConfigAsset({
        clientInstanceId: this.options.clientInstanceId,
        kind: kind.kind,
        name,
        assetId: asset.id
      });
      await kind.onUnpublish?.({
        clientInstanceId: this.options.clientInstanceId,
        assetId: asset.id,
        ...(asset.publishedConfig === undefined ? {} : { published: asset.publishedConfig }),
        stores
      });
      return moved;
    });
    await recordAssetEvent(
      call,
      kind.kind === GUARDRAIL_ASSET_KIND ? "guardrail.unpublished" : "workflow.unpublished",
      {
        kind: kind.kind,
        name,
        revision: unpublished.revision,
        ...scopeMetadata(asset.scope)
      }
    );
    return {
      draftRevision: asset.revision,
      unpublishedRevision: unpublished.revision,
      warnings
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
    if (kind.draftCalls) {
      // The discard makes the published revision the draft again. A "Run live once" switch
      // set for it before the draft changed would apply once more, so the switches the draft
      // left behind are cleared first (ADR-0031).
      await clearLiveOnceSwitches(this.options, call, kind, name, asset.id);
    }
    if (kind.kind === APP_ASSET_KIND) {
      // The hosts people allowed for their own view of the draft end with it (DRAFT-HOSTS-1).
      // Removed before the discard: a discard whose allowances stay is not made.
      await removeDraftHosts(this.options, asset.id);
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
    // The switches set for the discarded draft are cleared now, in the name of who discarded it.
    await clearLiveOnceSwitches(this.options, call, kind, name, asset.id);
    if (kind.kind === APP_ASSET_KIND) {
      // And any a person allowed while the discard ran.
      await removeDraftHosts(this.options, asset.id).catch((error: unknown) => {
        this.options.logger.error(
          { correlationId: call.correlationId, error: error instanceof Error ? error.message : "" },
          `The draft of App '${name}' was discarded but the hosts allowed for it were not removed`
        );
      });
    }
    return { draftRevision: discarded.revision, publishedRevision: discarded.revision };
  }

  /**
   * "Run live once" (ADR-0031): the next call of one action or step of the draft, as the
   * caller sees it, is made live instead of simulated. It asks the write right on the draft,
   * not the publish right. The switch covers that revision only: a draft saved since is
   * refused here, and one saved later clears the switch before a call could use it.
   */
  async runLiveOnce(
    call: AssetCall,
    input: AssetAddress & { part: string; expectedRevision?: number }
  ) {
    const target = await this.host.target(input);
    const { kind, name } = target;
    call.access.require(kind.actions.write, target.resource);
    const expectedRevision = requirePrecondition(input, input.expectedRevision);
    if (!kind.draftCalls) {
      throw new AppError(
        "VALIDATION_FAILED",
        `A draft of the kind '${kind.kind}' makes no calls that could run live`
      );
    }
    const asset = requireActive(target);
    if (asset.revision !== expectedRevision) {
      throw await revisionConflictOf(this.options, call.access, target);
    }
    const draft = { kind: kind.kind, id: asset.id, name };
    const { cleared } = await this.options.stores.liveOnceSwitches.switchOn({
      clientInstanceId: this.options.clientInstanceId,
      switch: {
        asset: draft,
        revisionId: asset.activeRevisionId,
        part: input.part,
        switchedBy: { id: call.actor.id, label: call.actor.displayLabel },
        switchedAt: new Date().toISOString()
      }
    });
    for (const stale of cleared) {
      await recordAssetEvent(call, "live_once.cleared", {
        kind: kind.kind,
        name,
        revisionId: stale.revisionId,
        part: stale.part,
        switchedBy: stale.switchedBy.id,
        reason: "draft_changed"
      });
    }
    // The switch is its owner's: only a call or a test run of theirs uses it.
    await recordAssetEvent(call, "live_once.switched_on", {
      kind: kind.kind,
      name,
      revision: asset.revision,
      revisionId: asset.activeRevisionId,
      part: input.part,
      switchedBy: call.actor.id
    });
    return { draftRevision: asset.revision, part: input.part };
  }

  /**
   * The caller's own "Run live once" switches on the current draft, with the test run that
   * used each, so a page shows them as they stand after a reload.
   */
  async listLiveOnce(call: AssetCall, input: AssetAddress) {
    const target = await this.host.target(input);
    const { kind } = target;
    call.access.require(kind.actions.write, target.resource);
    if (!kind.draftCalls) {
      throw new AppError(
        "VALIDATION_FAILED",
        `A draft of the kind '${kind.kind}' makes no calls that could run live`
      );
    }
    const asset = requireActive(target);
    const switches = await this.options.stores.liveOnceSwitches.list({
      clientInstanceId: this.options.clientInstanceId,
      assetId: asset.id,
      switchedBy: call.actor.id
    });
    return {
      items: switches.map((set) => ({
        part: set.part,
        switchedAt: set.switchedAt,
        ...(set.usedByRunId === undefined ? {} : { usedByRunId: set.usedByRunId }),
        ...(set.usedAt === undefined ? {} : { usedAt: set.usedAt })
      }))
    };
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
              clientInstanceId: this.options.clientInstanceId,
              assetId: gone.assetId,
              name,
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

/** Where an asset enforces, as its audit names it: the instance or one workspace. */
function scopeMetadata(scope: AssetScope): JsonObject {
  return scope.kind === "workspace"
    ? { scope: "workspace", workspaceId: scope.workspaceId }
    : { scope: "instance" };
}
