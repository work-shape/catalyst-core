import { workflowStepFacts } from "../workflows/workflow-step-facts";
import { appCallersByWorkflow } from "../workflows/app-callers";
import { workflowCallers } from "../workflows/workflow-callers";
import { agentDependencyAvailability } from "./agent-dependency-availability";
import { appAudienceReview } from "../apps/app-audience";
import type { AppAudience } from "@work-shape/catalyst-core";
import {
  agentConfigSchema,
  resolveStoredAgentReferences
} from "@work-shape/catalyst-config-schema";
import {
  AppError,
  asCollaborationWorkspaceId,
  asUserId,
  createPersonLabelLookup,
  getSubjectUserId,
  isAppError,
  isAuthenticatedServicePrincipal,
  liveRevisionId,
  type ActorAccess,
  type AuthenticatedIdentity,
  type AgentAvailability,
  type AssetScope,
  type ConfigAssetRecord,
  type FileSet,
  type JsonObject,
  type OperationAuthorization,
  type LocaleCode,
  type StorePage,
  type PolicyTarget
} from "@work-shape/catalyst-core";
import { resolveConfigLocale } from "@work-shape/catalyst-config-schema";
import { accessResource, decide, listedTo, type AssetCall } from "./asset-access";
import { isReleaseSync } from "./asset-write-rules";
import { readRevisionFiles, readSourceFiles, type AssetFileOutput } from "./asset-files";
import type { AddresseeNames, WorkflowAssetKind } from "../asset-kinds/shared";
import {
  notFound,
  requireActive,
  scopeOf,
  type AssetAddress,
  type AssetTarget
} from "./asset-target";
import type { AssetWorkflowOptions } from "../types";
import { assetTitle } from "./asset-reference-labels";
import { unavailablePublishNarrative } from "../publish-narrative/publish-narrator";
import { createPlatformAssetPolicy } from "../platform/platform-asset-policy";
import { heldCallApproverNames } from "../approvals/visible-approvers";
import { HELD_ASSET_OPERATION } from "../approvals/held-asset-preview";

/**
 * Who is told of an agent's pending draft: a holder of `agent.write` on it, and the holder of
 * the release right, whose release sync writes the draft and names the draft revision it saw.
 */
function readsAgentDraft(
  access: ActorAccess,
  resource: ReturnType<typeof accessResource>
): boolean {
  return access.authorize("agent.write", resource).allowed || isReleaseSync(access, "sync");
}

/** How many assets a list reads where its caller names no page. */
const DEFAULT_ASSET_LIST_LIMIT = 51;

/** What the reads below use of the workflow of every asset. */
export interface AssetReadHost {
  target(address: AssetAddress): Promise<AssetTarget>;
  /** A kind of a module that is off does not exist here, whatever the store still holds. */
  kind(kind: string): WorkflowAssetKind;
  policyTargets(address: { kind: string; name?: string; workspaceId?: string }): PolicyTarget[];
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
   * Whether the caller's save of `target`, a create of a name not stored yet included, files a
   * request rather than taking effect, and who may decide it: the policy the save meets and the
   * people its request would name. Nothing where the caller may not write it or a save applies
   * at once.
   */
  async saveApproval(
    call: Pick<AssetCall, "actor" | "access">,
    target: AssetTarget
  ): Promise<{ approverNames: string[] } | undefined> {
    if (
      target.kind.kind !== "skill" ||
      isAuthenticatedServicePrincipal(call.actor) ||
      !call.access.authorize(target.kind.actions.write, target.resource).allowed
    ) {
      return undefined;
    }
    const floor = await createPlatformAssetPolicy(this.options, this.host).centralFloor(
      [HELD_ASSET_OPERATION],
      target.address
    );
    if (floor !== "approval") return undefined;
    return { approverNames: await heldCallApproverNames(this.options, call.actor) };
  }

  /** `saveApproval` of the asset at `address`, read for its caller. */
  async saveApprovalAt(
    call: Pick<AssetCall, "actor" | "access">,
    address: AssetAddress
  ): Promise<{ approverNames: string[] } | undefined> {
    return this.saveApproval(call, await this.host.target(address));
  }

  /** Instance availability permits consumption from another workspace, while every right
   * is still evaluated on the App's owning workspace. Writes keep their strict owner address. */
  private async readTarget(address: AssetAddress): Promise<AssetTarget> {
    const target = await this.host.target(address);
    const other = target.other;
    return address.kind === "app" &&
      other?.appAvailability?.audience === "instance" &&
      other.scope.kind === "workspace"
      ? this.host.target({ ...address, workspaceId: other.scope.workspaceId })
      : target;
  }

  /**
   * One page of the assets of a kind in one scope, each one the caller may read. The right is
   * decided per asset by the one resolver, so a list never shows what `assets.get` refuses.
   */
  async list(
    call: AssetCall,
    input: {
      kind: string;
      prefix?: string;
      text?: string;
      workspaceId?: string;
      locale?: string;
      forUse?: true;
    },
    page: StorePage | undefined
  ) {
    const kind = this.host.kind(input.kind);
    // Names and descriptions in the reader's language where the instance offers it.
    const locale = resolveConfigLocale(this.options.config.localization, {
      requestedLocale: input.locale ?? call.runtime?.locale
    });
    const scope = scopeOf(input.workspaceId);
    const searchText = input.text?.toLowerCase();
    const [after] = page?.after ?? [];
    // As in assets.get, a draft is for writers and publishers; readers see the live revision.
    const reads = (resource: AssetTarget["resource"]) =>
      input.forUse !== true &&
      (kind.lifecycle === "draft_published"
        ? call.access.authorize(kind.actions.write, resource).allowed ||
          (kind.actions.publish !== undefined &&
            call.access.authorize(kind.actions.publish, resource).allowed)
        : call.access.authorize(kind.actions.read, resource).allowed);
    const [defaultName, records] = await Promise.all([
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
                // Published titles remain searchable for writers too; only they may also
                // match a draft title. Keep each match within a single visible title.
                titleOf: (asset, revisions) => {
                  const publishedTitle = summarizeAsset(
                    kind,
                    asset.name,
                    revisions.published,
                    locale
                  ).title;
                  if (
                    searchText !== undefined &&
                    publishedTitle.toLowerCase().includes(searchText)
                  ) {
                    return publishedTitle;
                  }
                  return summarizeAsset(
                    kind,
                    asset.name,
                    reads(
                      accessResource(
                        asset.kind,
                        asset.name,
                        asset.scope,
                        asset.id,
                        asset.appAvailability
                      )
                    ) || kind.lifecycle === "active"
                      ? revisions.active
                      : revisions.published,
                    locale
                  ).title;
                }
              }
            }),
        afterName: typeof after === "string" ? after : undefined,
        limit: page?.limit ?? DEFAULT_ASSET_LIST_LIMIT,
        readable: (asset) =>
          input.forUse
            ? asset.published === true &&
              kind.actions.use !== undefined &&
              call.access.authorize(
                kind.actions.use,
                accessResource(asset.kind, asset.name, asset.scope, asset.id, asset.appAvailability)
              ).allowed
            : listedTo(kind, call.access, asset)
      })
    ]);
    const draftSummaries = await this.options.stores.agentProposals.summaries({
      clientInstanceId: this.options.clientInstanceId,
      agentIds:
        kind.kind === "agent"
          ? records
              .filter((record) =>
                readsAgentDraft(
                  call.access,
                  accessResource(record.kind, record.name, record.scope, record.id)
                )
              )
              .map((record) => record.id)
          : []
    });
    const health = new Map(
      (kind.kind === "connection"
        ? await this.options.stores.connections.listConnectionStates({
            clientInstanceId: this.options.clientInstanceId,
            connectionAssetIds: records.map((record) => record.id)
          })
        : []
      ).map((state) => [state.connectionAssetId, state.health])
    );
    // The Apps that start each Workflow of the page, from one pass over the Apps.
    const appCallers =
      kind.kind === "workflow" && records.length > 0
        ? await appCallersByWorkflow(this.options, call.access)
        : undefined;
    const startedBy = (name: string) => {
      const callers = appCallers?.get(name);
      return callers === undefined || callers.length === 0 ? {} : { appCallers: callers };
    };
    return records.map((record) => {
      const resource = accessResource(
        record.kind,
        record.name,
        record.scope,
        record.id,
        record.appAvailability
      );
      const allowed = allowedOn(kind, call, resource);
      if (!reads(resource)) {
        return {
          ...this.publishedSummary(kind, record, locale),
          allowed,
          ...startedBy(record.name)
        };
      }
      const summary = summarizeAsset(kind, record.name, record.config, locale);
      // Health is a `connection.read` field; use holders see the published summary only.
      const attributes =
        kind.kind === "connection"
          ? { ...summary.attributes, health: health.get(record.id) ?? "unknown" }
          : summary.attributes;
      return {
        id: record.id,
        kind: record.kind,
        allowed,
        ...summary,
        ...(attributes === undefined ? {} : { attributes }),
        scope: record.scope,
        revision: record.revision,
        ...pointersOf(kind, record),
        ...(draftSummaries.has(record.id) ? { agentDraft: draftSummaries.get(record.id) } : {}),
        ...(record.name === defaultName ? { isDefault: true as const } : {}),
        ...startedBy(record.name),
        updatedAt: record.updatedAt
      };
    });
  }

  /** The right a read of the revision the call names asks. */
  async authorizeGet(
    access: ActorAccess,
    input: AssetAddress & { revision?: string; files?: boolean },
    actor?: AuthenticatedIdentity
  ): Promise<OperationAuthorization> {
    const target = await this.readTarget(input);
    const decision = decide(access, this.readAction(access, target, input).action, target.resource);
    // A key that cannot read a skill learns neither its existence nor its name in an error.
    if (
      target.kind.kind === "skill" &&
      !decision.allowed &&
      actor !== undefined &&
      !isAuthenticatedServicePrincipal(actor) &&
      actor.keyScopes !== undefined
    ) {
      throw new AppError("NOT_FOUND", "Skill not found");
    }
    return decision;
  }

  async get(
    call: AssetCall,
    address: AssetAddress & {
      revision?: string;
      files?: boolean;
      audience?: AppAudience;
      availabilityMode?: AgentAvailability["mode"];
      availabilityPersonalWorkspaces?: string;
      availabilityWorkspaceIds?: string;
    }
  ) {
    const target = await this.readTarget(address);
    const read = this.readAction(call.access, target, address);
    call.access.require(read.action, target.resource);
    const asset = requireActive(target);
    // Whoever may not read the draft is answered the published revision and nothing of it.
    const publishedOnly = read.publishedView;
    if (publishedOnly) address = { ...address, revision: "published" };
    const [defaultName, availability, content, useLimits] = await Promise.all([
      this.defaultName(target.kind, target.scope),
      this.availability(call, target.kind, asset.name),
      this.revisionContent(target, asset, address),
      target.kind.kind === "agent"
        ? this.options.configAssets.store.listAgentUseLimits({
            clientInstanceId: this.options.clientInstanceId,
            agentName: asset.name
          })
        : undefined
    ]);
    // Resolve only after authorization, from the revision the caller is allowed to read.
    const runsAs = await target.kind.readRunsAs?.(content.config);
    const draftSummary =
      target.kind.kind === "agent" && readsAgentDraft(call.access, target.resource)
        ? (
            await this.options.stores.agentProposals.summaries({
              clientInstanceId: this.options.clientInstanceId,
              agentIds: [asset.id]
            })
          ).get(asset.id)
        : undefined;
    // Only a kind with a publish question reads the reader's language: an App, a Workflow, a
    // Knowledge Base.
    const asksPublish =
      !publishedOnly &&
      (target.kind.publishQuestion !== undefined ||
        target.kind.publishReview !== undefined ||
        target.kind.publishReach !== undefined);
    const locale = asksPublish ? await this.readerLocale(call) : undefined;
    const asking = locale && {
      assetId: asset.id,
      scope: asset.scope,
      config: content.config,
      locale,
      names: this.addresseeNames(call, locale)
    };
    const review =
      asking && target.kind.publishReview ? await target.kind.publishReview(asking) : undefined;
    const publishQuestion =
      review?.lines ??
      (asking && target.kind.publishQuestion
        ? await target.kind.publishQuestion(asking)
        : undefined);
    const publishConfirmation = review?.confirmation;
    const publishProcessing = review?.processing;
    const appAudience =
      target.kind.kind === "app" && locale
        ? await appAudienceReview(
            this.options,
            asset,
            call.access,
            locale,
            address.audience,
            call.actor
          )
        : undefined;
    // The sentence the publish question leads with, for the revision this read returns (PUBQ-1).
    const publishNarrative = locale
      ? await this.options.operationCalls?.publishNarrator
          ?.narrate({
            kind: target.kind.kind,
            name: asset.name,
            scope: asset.scope,
            revision: content.contentRevision ?? asset.revision,
            config: content.config,
            locale,
            access: call.access,
            ...(appAudience ? { audienceLabel: appAudience.label } : {})
          })
          .catch(() => unavailablePublishNarrative(locale))
      : undefined;
    const stepFacts =
      target.kind.kind === "workflow"
        ? await workflowStepFacts(
            this.options,
            content.config,
            asset.name,
            call.access,
            // The zone and the next due time both of the published revision, which is what runs.
            (asset.publishedConfig
              ? target.kind.readSchedule?.(asset.publishedConfig)
              : undefined) ?? { timeZone: this.options.config.clientInstance.timeZone ?? "UTC" }
          )
        : undefined;
    const agentStatus =
      target.kind.kind === "agent" ? await this.agentStatus(content.config) : undefined;
    // What the caller may do here, decided as each write decides it, so the page offers no
    // action the instance refuses and hides none it allows (AD-4).
    const allowed = allowedOn(target.kind, call, target.resource);
    const saveApproval = await this.saveApproval(call, target);
    // The draft header names the publish, which can be by someone other than its author.
    const recorded =
      target.kind.kind === "app" && !publishedOnly && asset.publishedRevision !== undefined
        ? await this.options.stores.audit
            .getAssetPublication({
              clientInstanceId: this.options.clientInstanceId,
              assetId: asset.id,
              revision: asset.publishedRevision
            })
            .catch(() => undefined)
        : undefined;
    // Audit keeps the publisher's name until it is pruned. The page names them as their account
    // is now: a deleted account's name is empty, which the interface shows as "Deleted account".
    const publication = recorded && {
      at: recorded.at,
      ...(recorded.byUserId === undefined
        ? recorded.by === undefined
          ? {}
          : { by: recorded.by }
        : {
            by: await createPersonLabelLookup(
              this.options.stores.users,
              this.options.clientInstanceId
            )(recorded.byUserId, recorded.by ?? "")
          })
    };
    return {
      ...(saveApproval ? { saveApproval } : {}),
      ...(agentStatus ?? {}),
      ...(draftSummary ? { agentDraft: draftSummary } : {}),
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      scope: asset.scope,
      revision: publishedOnly ? (content.contentRevision ?? asset.revision) : asset.revision,
      ...(publishedOnly
        ? { publishedRevision: content.contentRevision }
        : pointersOf(target.kind, asset)),
      ...content,
      ...(runsAs === undefined ? {} : { runsAs }),
      ...(stepFacts === undefined ? {} : { stepFacts }),
      ...(target.kind.kind === "workflow"
        ? {
            workflowCallers: await workflowCallers(this.options, asset.name, call.access),
            appCallers:
              (await appCallersByWorkflow(this.options, call.access)).get(asset.name) ?? []
          }
        : {}),
      ...(publication ? { publication } : {}),
      ...(publishQuestion?.length ? { publishQuestion } : {}),
      ...(publishConfirmation ? { publishConfirmation } : {}),
      ...(publishProcessing ? { publishProcessing } : {}),
      ...(publishNarrative ? { publishNarrative } : {}),
      ...(appAudience ? { appAudience } : {}),
      ...(asset.name === defaultName ? { isDefault: true as const } : {}),
      ...(availability ? { availability } : {}),
      ...(useLimits
        ? { agentUse: useLimits.has(asset.name) ? ("granted" as const) : ("everyone" as const) }
        : {}),
      ...(target.kind.hasWorkspaceAvailability
        ? {
            canSetAvailability:
              call.access.authorize(target.kind.actions.write).allowed &&
              call.access.authorize(target.kind.actions.write, target.resource).allowed
          }
        : {}),
      ...(target.kind.kind === "agent" &&
      (call.access.authorize("agent.write", target.resource).allowed ||
        call.access.authorize("agent.publish", target.resource).allowed)
        ? {
            dependencyAvailability: await agentDependencyAvailability(
              this.options,
              call,
              content.config,
              address.availabilityMode
                ? {
                    mode: address.availabilityMode,
                    personalWorkspaces: address.availabilityPersonalWorkspaces === "true",
                    collaborationWorkspaceIds: (
                      address.availabilityWorkspaceIds?.split(",").filter(Boolean) ?? []
                    ).map(asCollaborationWorkspaceId)
                  }
                : availability
            )
          }
        : {}),
      allowed,
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

  /**
   * The reader's language: the one their account chose, else the one their request names,
   * else the instance's. A service principal has no account language.
   */
  private async readerLocale(call: AssetCall): Promise<LocaleCode> {
    const { clientInstanceId, stores, config } = this.options;
    const chosen = isAuthenticatedServicePrincipal(call.actor)
      ? undefined
      : (
          await stores.users.getUser({
            clientInstanceId,
            userId: asUserId(getSubjectUserId(call.actor))
          })
        )?.locale;
    return chosen ?? call.runtime?.locale ?? config.localization.defaultLocale;
  }

  /** Names of users and Shared Workspaces of the instance, for a question that hides ids. */
  private addresseeNames(call: AssetCall, locale: LocaleCode): AddresseeNames {
    const { clientInstanceId, stores, configAssets } = this.options;
    return {
      user: async (id) =>
        (await stores.users.getUser({ clientInstanceId, userId: asUserId(id) }))?.displayLabel,
      workspace: async (id) =>
        (await stores.workspaces.getWorkspace(clientInstanceId, asCollaborationWorkspaceId(id)))
          ?.name,
      // Only a reader who may read or use the asset is told its title.
      asset: async (kind, name) => {
        const assetKind = configAssets.kinds.kinds.find((each) => each.kind === kind);
        if (assetKind === undefined) return undefined;
        const record = await configAssets.store.getConfigAsset({
          clientInstanceId,
          kind: assetKind.kind,
          name
        });
        if (record === undefined || record.config === null) return undefined;
        const resource = accessResource(record.kind, record.name, record.scope, record.id);
        const { read, use } = assetKind.actions;
        const may = [read, use].some(
          (action) => action !== undefined && call.access.authorize(action, resource).allowed
        );
        return may
          ? assetTitle(configAssets.kinds.kinds, kind, name, record.config, locale)
          : undefined;
      }
    };
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
    // Who wrote each revision is named as the account is now: a deleted account's name is
    // empty, which the interface shows as "Deleted account".
    const labelOf = createPersonLabelLookup(
      this.options.stores.users,
      this.options.clientInstanceId
    );
    const named = await Promise.all(
      revisions.map(async ({ actor }) => {
        if (actor?.userId === undefined) return actor;
        const displayLabel = await labelOf(actor.userId, actor.displayLabel);
        if (displayLabel) return { ...actor, displayLabel };
        // Nor does it name the account at the identity provider.
        const { externalUserId: _externalUserId, ...gone } = actor;
        return { ...gone, displayLabel };
      })
    );
    return revisions.map((revision, index) => ({
      assetId: revision.assetId,
      revision: revision.revision,
      operation: revision.operation,
      config: revision.config,
      actor: named[index] ?? revision.actor,
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
  publishedSummary(kind: WorkflowAssetKind, record: ConfigAssetRecord, locale?: LocaleCode) {
    return {
      id: record.id,
      kind: record.kind,
      ...summarizeAsset(
        kind,
        record.name,
        kind.lifecycle === "active" ? record.config : record.publishedConfig,
        locale
      ),
      scope: record.scope,
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
      agentName: name,
      kind: kind.kind
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
export { listedTo } from "./asset-access";

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
      (kind.useOpensPublishedRevision !== false &&
        use !== undefined &&
        access.authorize(use, resource).allowed))
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

/** List and detail answers use the write paths' in-memory authorization decision. */
function allowedOn(kind: WorkflowAssetKind, call: AssetCall, resource: AssetTarget["resource"]) {
  const { read, write, delete: remove, publish } = kind.actions;
  return (
    [
      ["read", read],
      ["write", write],
      ["delete", remove],
      // Only a person publishes: a key or a service publishes nothing.
      ["publish", isAuthenticatedServicePrincipal(call.actor) ? undefined : publish]
    ] as const
  )
    .filter(([, action]) => action !== undefined && call.access.authorize(action, resource).allowed)
    .map(([verb]) => verb);
}
