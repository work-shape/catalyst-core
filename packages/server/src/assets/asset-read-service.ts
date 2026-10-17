import {
  agentConfigSchema,
  resolveStoredAgentReferences
} from "@work-shape/catalyst-config-schema";
import {
  AppError,
  asUserId,
  findNamespaceOfAssetName,
  getSubjectUserId,
  isAppError,
  isAuthenticatedServicePrincipal,
  liveRevisionId,
  type ActorAccess,
  type AgentAvailability,
  type AssetScope,
  type ConfigAssetKey,
  type ConfigAssetRecord,
  type FileSet,
  type JsonObject,
  type Namespace,
  type OperationAuthorization,
  type LocaleCode,
  type StorePage
} from "@work-shape/catalyst-core";
import { resolveConfigLocale } from "@work-shape/catalyst-config-schema";
import { accessResource, decide, type AssetCall } from "./asset-access";
import { readRevisionFiles, readSourceFiles, type AssetFileOutput } from "./asset-files";
import type { WorkflowAssetKind } from "../asset-kinds/shared";
import {
  notFound,
  requireActive,
  scopeOf,
  type AssetAddress,
  type AssetTarget
} from "./asset-target";
import type { AssetWorkflowOptions } from "../types";

/** How many assets a list reads where its caller names no page. */
const DEFAULT_ASSET_LIST_LIMIT = 51;

/** What the reads below use of the workflow of every asset. */
export interface AssetReadHost {
  target(address: AssetAddress): Promise<AssetTarget>;
  /** A kind of a module that is off does not exist here, whatever the store still holds. */
  kind(kind: string): WorkflowAssetKind;
}

/**
 * The reads of one asset of any registered kind: the list, the asset, one revision of it and
 * its history. Every call addresses one scope and stays in it, as the writes do.
 */
export class AssetReadWorkflow {
  private readonly options: AssetWorkflowOptions;
  private readonly host: AssetReadHost;

  constructor(options: AssetWorkflowOptions, host: AssetReadHost) {
    this.options = options;
    this.host = host;
  }

  /**
   * One page of the assets of a kind in one scope, each one the caller may read. The right is
   * decided per asset by the one resolver, so a list never shows what `assets.get` refuses.
   */
  async list(
    call: AssetCall,
    input: { kind: string; prefix?: string; text?: string; workspaceId?: string; locale?: string },
    page: StorePage | undefined
  ) {
    const kind = this.host.kind(input.kind);
    // Names and descriptions in the reader's language where the instance offers it.
    const locale = resolveConfigLocale(this.options.config.localization, {
      requestedLocale: input.locale
    });
    const scope = scopeOf(input.workspaceId);
    const [after] = page?.after ?? [];
    // Whoever reads the asset is shown all of it; a holder of the use right its published view.
    const reads = (resource: AssetTarget["resource"]) =>
      call.access.authorize(kind.actions.read, resource).allowed;
    const [namespaces, defaultName, records] = await Promise.all([
      this.namespaces(scope),
      this.defaultName(kind, scope),
      this.options.configAssets.store.listConfigAssetPage({
        clientInstanceId: this.options.clientInstanceId,
        kind: kind.kind,
        scope,
        namePrefix: input.prefix,
        ...(input.text === undefined
          ? {}
          : {
              text: {
                contains: input.text,
                // The title of the revision the caller is shown, as the summary below is.
                titleOf: (asset, revisions) =>
                  summarizeAsset(
                    kind,
                    asset.name,
                    reads(accessResource(asset.kind, asset.name, asset.scope, asset.id))
                      ? revisions.active
                      : revisions.published
                  ).title
              }
            }),
        afterName: typeof after === "string" ? after : undefined,
        limit: page?.limit ?? DEFAULT_ASSET_LIST_LIMIT,
        readable: (asset) => listedTo(kind, call.access, asset)
      })
    ]);
    const draftSummaries = await this.options.stores.agentProposals.summaries({
      clientInstanceId: this.options.clientInstanceId,
      agentIds:
        kind.kind === "agent"
          ? records
              .filter(
                (record) =>
                  call.access.authorize(
                    "agent.write",
                    accessResource(record.kind, record.name, record.scope, record.id)
                  ).allowed
              )
              .map((record) => record.id)
          : []
    });
    return records.map((record) => {
      const namespace = findNamespaceOfAssetName(namespaces, record.name);
      if (!reads(accessResource(record.kind, record.name, record.scope, record.id))) {
        return this.publishedSummary(kind, record, namespace?.prefix, locale);
      }
      return {
        id: record.id,
        kind: record.kind,
        ...summarizeAsset(kind, record.name, record.config, locale),
        scope: record.scope,
        ...(namespace ? { namespace: namespace.prefix } : {}),
        revision: record.revision,
        ...pointersOf(kind, record),
        ...(draftSummaries.has(record.id) ? { agentDraft: draftSummaries.get(record.id) } : {}),
        ...(record.name === defaultName ? { isDefault: true as const } : {}),
        updatedAt: record.updatedAt
      };
    });
  }

  /** The right a read of the revision the call names asks. */
  async authorizeGet(
    access: ActorAccess,
    input: AssetAddress & { revision?: string; files?: boolean }
  ): Promise<OperationAuthorization> {
    const target = await this.host.target(input);
    return decide(access, this.readAction(access, target, input).action, target.resource);
  }

  async get(call: AssetCall, address: AssetAddress & { revision?: string; files?: boolean }) {
    const target = await this.host.target(address);
    const read = this.readAction(call.access, target, address);
    call.access.require(read.action, target.resource);
    const asset = requireActive(target);
    // Whoever may not read the draft is answered the published revision and nothing of it.
    const publishedOnly = read.publishedView;
    if (publishedOnly) address = { ...address, revision: "published" };
    const [namespaces, defaultName, availability, content] = await Promise.all([
      this.namespaces(target.scope),
      this.defaultName(target.kind, target.scope),
      this.availability(call, target.kind, asset.name),
      this.revisionContent(target, asset, address)
    ]);
    const namespace = findNamespaceOfAssetName(namespaces, asset.name);
    // Resolve only after authorization, from the revision the caller is allowed to read.
    const runsAs = await target.kind.readRunsAs?.(content.config);
    const draftSummary =
      target.kind.kind === "agent" && call.access.authorize("agent.write", target.resource).allowed
        ? (
            await this.options.stores.agentProposals.summaries({
              clientInstanceId: this.options.clientInstanceId,
              agentIds: [asset.id]
            })
          ).get(asset.id)
        : undefined;
    const agentStatus =
      target.kind.kind === "agent" ? await this.agentStatus(content.config) : undefined;
    return {
      ...(agentStatus ?? {}),
      ...(draftSummary ? { agentDraft: draftSummary } : {}),
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      scope: asset.scope,
      ...(namespace ? { namespace: namespace.prefix } : {}),
      revision: publishedOnly ? (content.contentRevision ?? asset.revision) : asset.revision,
      ...(publishedOnly
        ? { publishedRevision: content.contentRevision }
        : pointersOf(target.kind, asset)),
      ...content,
      ...(runsAs === undefined ? {} : { runsAs }),
      ...(asset.name === defaultName ? { isDefault: true as const } : {}),
      ...(availability ? { availability } : {}),
      updatedAt: asset.updatedAt
    };
  }

  private async agentStatus(config: unknown) {
    const assets = await this.options.configAssets.store.listActiveConfigAssets({
      clientInstanceId: this.options.clientInstanceId,
      withoutSkillResources: true
    });
    const { agent: _effective, ...status } = resolveStoredAgentReferences(
      agentConfigSchema.parse(config),
      assets.filter((asset) => asset.kind === "skill").map((asset) => asset.name),
      {
        ...this.options.configAssets.validationRefs,
        offToolModule: (name) => this.options.modules.offModuleOf("tool", name)
      }
    );
    return status;
  }

  /** One page of the history, newest first. It stays readable after its asset is deleted. */
  async listRevisions(call: AssetCall, address: AssetAddress, page: StorePage | undefined) {
    const target = await this.host.target(address);
    // The history holds every draft: it is read with the right the draft is read with.
    call.access.require(
      this.readAction(call.access, target, { revision: "draft" }).action,
      target.resource
    );
    if (!target.asset) {
      throw notFound(target);
    }
    const revisions = await this.options.configAssets.store.listConfigAssetRevisions({
      clientInstanceId: this.options.clientInstanceId,
      kind: target.kind.kind,
      name: target.name,
      page,
      newestFirst: true
    });
    return revisions.map((revision) => ({
      assetId: revision.assetId,
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
   * The right a read asks, and whether it answers the published view alone. For a kind with
   * a published revision, that revision is what its readers are shown, and its writers too;
   * the draft and every numbered revision are for whoever writes or publishes the asset. A
   * read that names no revision answers the draft to whoever may read it, and to everybody
   * else who may be shown the published revision (`showsPublishedView`) that revision and
   * nothing of the draft. A kind without a published revision asks its read right.
   */
  readAction(
    access: ActorAccess,
    target: AssetTarget,
    input: { revision?: string; files?: boolean }
  ): { action: string; publishedView: boolean } {
    const { kind, resource } = target;
    const { read, write, publish, use } = kind.actions;
    const holds = (action: string) => access.authorize(action, resource).allowed;
    if (kind.lifecycle !== "draft_published") {
      return { action: read, publishedView: false };
    }
    if (input.revision === "published" && (holds(read) || holds(write))) {
      return { action: holds(read) ? read : write, publishedView: false };
    }
    const draft = !holds(write) && publish !== undefined && holds(publish) ? publish : write;
    if (input.revision !== "published" && (input.revision !== undefined || holds(draft))) {
      return { action: draft, publishedView: false };
    }
    // No revision named by somebody who may not read the draft, or the published one named
    // by somebody who reads through the use right: the published view, without files.
    const shown =
      !input.files && showsPublishedView(kind, access, resource, isPublished(kind, target.asset));
    if (shown) {
      return { action: use !== undefined && !holds(read) ? use : read, publishedView: true };
    }
    return { action: input.revision === "published" ? read : draft, publishedView: false };
  }

  /**
   * One asset as a list shows it to a holder of the use right alone: the published revision
   * under its own number, and nothing of the draft.
   */
  publishedSummary(
    kind: WorkflowAssetKind,
    record: ConfigAssetRecord,
    namespace?: string,
    locale?: LocaleCode
  ) {
    return {
      id: record.id,
      kind: record.kind,
      ...summarizeAsset(kind, record.name, record.publishedConfig, locale),
      scope: record.scope,
      ...(namespace ? { namespace } : {}),
      revision: record.publishedRevision ?? record.revision,
      publishedRevision: record.publishedRevision,
      updatedAt: record.updatedAt
    };
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
    if (input.files && kind.representation !== "files" && !kind.revisionFiles) {
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
      return {
        config: asset.config,
        ...(input.files
          ? await readRevisionFiles(this.options, kind, {
              assetId: asset.id,
              config: asset.config,
              ...(asset.fileSetId ? { fileSetId: asset.fileSetId } : {})
            })
          : {})
      };
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
    // The published revision comes with the asset: no further read.
    if (selector === "published" && isPublished(kind, asset) && asset.publishedConfig) {
      return {
        revision: asset.publishedRevision ?? asset.revision,
        config: asset.publishedConfig,
        ...(asset.publishedFileSetId ? { fileSetId: asset.publishedFileSetId } : {})
      };
    }
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

  /** A Namespace is a prefix among the instance's own assets: a workspace's have none. */
  async namespaces(scope: AssetScope): Promise<Namespace[]> {
    return scope.kind === "instance"
      ? this.options.stores.access.listNamespaceRecords({
          clientInstanceId: this.options.clientInstanceId
        })
      : [];
  }

  /**
   * The name of the instance's default of a kind, read once per call. Only a kind that holds
   * the default has one, and only among the instance's own assets.
   */
  private async defaultName(
    kind: WorkflowAssetKind,
    scope: AssetScope
  ): Promise<string | undefined> {
    if (!kind.holdsInstanceDefault || scope.kind !== "instance") {
      return undefined;
    }
    const state = await this.options.configAssets.store.getConfigAssetState({
      clientInstanceId: this.options.clientInstanceId
    });
    return state.defaultAgentName;
  }

  /**
   * The workspaces one asset is offered in, where its kind is offered per workspace, as far as
   * the caller sees them. Whoever holds the kind's write right on the whole instance sets the
   * availability and lists every Shared Workspace for it, so reads them all. Anyone else reads
   * the workspaces they are a member of, and a service principal is a member of none.
   */
  private async availability(
    call: AssetCall,
    kind: WorkflowAssetKind,
    name: string
  ): Promise<AgentAvailability | undefined> {
    if (!kind.hasWorkspaceAvailability) {
      return undefined;
    }
    const stored = await this.options.configAssets.store.listAgentAvailability({
      clientInstanceId: this.options.clientInstanceId,
      agentName: name
    });
    const availability = stored.get(name);
    if (
      !availability ||
      availability.collaborationWorkspaceIds.length === 0 ||
      call.access.authorize(kind.actions.write).allowed
    ) {
      return availability;
    }
    const memberOf = isAuthenticatedServicePrincipal(call.actor)
      ? []
      : await this.options.stores.workspaces.listWorkspacesForUser({
          clientInstanceId: this.options.clientInstanceId,
          userId: asUserId(getSubjectUserId(call.actor))
        });
    const visible = new Set<string>(memberOf.map((workspace) => workspace.id));
    return {
      ...availability,
      collaborationWorkspaceIds: availability.collaborationWorkspaceIds.filter((id) =>
        visible.has(id)
      )
    };
  }
}

/** The two pointers of an asset of a kind with a published revision, as revision numbers. */
function pointersOf(kind: WorkflowAssetKind, asset: ConfigAssetRecord) {
  if (kind.lifecycle !== "draft_published") {
    return {};
  }
  const published = liveRevisionId(asset, kind) === undefined ? undefined : asset.publishedRevision;
  return {
    draftRevision: asset.revision,
    ...(published === undefined ? {} : { publishedRevision: published })
  };
}

/** Whether the asset has a revision its users are served. */
function isPublished(kind: WorkflowAssetKind, asset: ConfigAssetRecord | undefined): boolean {
  return (
    asset !== undefined &&
    liveRevisionId(asset, kind) !== undefined &&
    asset.publishedRevision !== undefined
  );
}

/**
 * Whether a list of the kind shows the caller this asset: whoever reads it is shown all of it,
 * a holder of the use right its published view.
 */
export function listedTo(
  kind: WorkflowAssetKind,
  access: ActorAccess,
  asset: Pick<ConfigAssetKey, "kind" | "name" | "scope" | "id" | "published">
): boolean {
  const resource = accessResource(asset.kind, asset.name, asset.scope, asset.id);
  return (
    access.authorize(kind.actions.read, resource).allowed ||
    showsPublishedView(kind, access, resource, asset.published === true)
  );
}

/**
 * The rule of every kind with a published revision: whoever holds its read right or its use
 * right is shown the published revision of the asset, as a list entry and as a read, and
 * through the use right nothing of an asset that has none. It is the right `mayOpenAssetFileSet` serves the files
 * of that revision for.
 */
function showsPublishedView(
  kind: WorkflowAssetKind,
  access: ActorAccess,
  resource: AssetTarget["resource"],
  published: boolean
): boolean {
  const { read, use } = kind.actions;
  return (
    kind.lifecycle === "draft_published" &&
    published &&
    (access.authorize(read, resource).allowed ||
      (use !== undefined && access.authorize(use, resource).allowed))
  );
}

/** What a list shows of one asset. A stored definition its kind no longer reads shows its name. */
function summarizeAsset(
  kind: WorkflowAssetKind,
  name: string,
  config: unknown,
  locale?: LocaleCode
) {
  try {
    const { title, description, attributes } = kind.summarize(config, locale);
    return {
      name,
      title,
      ...(description === undefined ? {} : { description }),
      ...(attributes === undefined ? {} : { attributes: { ...attributes } })
    };
  } catch (error) {
    if (isAppError(error) && error.code === "VALIDATION_FAILED") {
      return { name, title: name };
    }
    throw error;
  }
}
