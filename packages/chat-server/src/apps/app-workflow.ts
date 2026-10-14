import { randomUUID } from "node:crypto";
import { APP_ASSET_KIND, appInterfacePath, type AppMode } from "@vivd-catalyst/api-contract";
import {
  AppError,
  asCollaborationWorkspaceId,
  assetScopesEqual,
  asConversationId,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  isPageId,
  liveRevisionId,
  type ActorAccess,
  type AuthenticatedUser,
  type ConfigAssetFromPage,
  type ConfigAssetRecord,
  type FileSet,
  type FileSetId,
  type OperationAuthorization,
  type OperationBeforeEvent,
  type Page
} from "@vivd-catalyst/core";
import { accessResource, decide, type AssetCall } from "../asset-access";
import { APP_CONTENT_TOKEN_TTL_SECONDS, appContentPath, mintAppContentToken } from "../app-content";
import type { WorkflowAssetKind } from "../asset-kinds/shared";
import { fileSetWriteEvent } from "../asset-guardrail-events";
import { scopeOf } from "../asset-read-workflow";
import { recordAssetEvent } from "../asset-target";
import { requireAssetKindModuleOn } from "../asset-write-rules";
import type { PageRevisionOrigin } from "../asset-draft-workflow";
import { AssetWorkflow } from "../asset-workflow";
import { ConversationWorkflow } from "../conversations/conversation-workflow";
import type { ChatServerOptions } from "../types";
import { APP_ACTIONS, appConfigOf } from "./app-kind";
import { appOutsideHosts } from "./app-outside-hosts";

/**
 * The Page revision the guardrails of a write from a Page read, by the event that read it: the
 * write copies that one. Kept as long as the call holds its events.
 */
const checkedFileSets = new WeakMap<OperationBeforeEvent, FileSetId>();

/** What `apps.create_from_page` is called with. */
export interface CreateAppFromPageInput {
  conversationId: string;
  pageId: string;
  name: string;
  title: string;
  workspaceId: string;
}

/** What `apps.update_from_page` is called with. */
export interface UpdateAppFromPageInput {
  app: string;
  conversationId: string;
  pageId: string;
  workspaceId: string;
  expectedRevision: number;
  link?: boolean | undefined;
}

/** How many Apps of one Page one read answers. The interface makes one per Page. */
const APPS_FROM_PAGE_BATCH = 50;

/**
 * What an App has beside the operations of every asset: it is made from a Page, its draft is
 * written from that Page again, and its revisions are opened by people. Every write goes
 * through the asset workflow, so an App made here is the same revision shape as one written
 * with `assets.put`.
 */
export class AppWorkflow {
  private readonly options: ChatServerOptions;
  private readonly assets: AssetWorkflow;
  private readonly conversations: ConversationWorkflow;

  constructor(options: ChatServerOptions) {
    this.options = options;
    this.assets = new AssetWorkflow(options);
    this.conversations = new ConversationWorkflow(options);
  }

  /**
   * The write right on the workspace the App is to belong to, and the Page read by the caller.
   * The Page is asked here, before the guardrails read it: they never read one the caller
   * cannot.
   */
  async authorizeCreate(
    actor: AssetCall["actor"],
    access: ActorAccess,
    input: CreateAppFromPageInput
  ): Promise<OperationAuthorization> {
    const decision = decide(access, APP_ACTIONS.write, {
      kind: APP_ASSET_KIND,
      name: input.name,
      workspaceId: input.workspaceId
    });
    if (decision.allowed) await this.requireReadablePage(actor, input);
    return decision;
  }

  /**
   * The write right on the App, as a write of its draft with `assets.put` asks it, and the Page
   * read by the caller, as for a new App.
   */
  async authorizeUpdate(
    actor: AssetCall["actor"],
    access: ActorAccess,
    input: UpdateAppFromPageInput
  ): Promise<OperationAuthorization> {
    const decision = await this.assets.authorizeWrite(
      access,
      appAddress(input.app, input.workspaceId)
    );
    if (decision.allowed) await this.requireReadablePage(actor, input);
    return decision;
  }

  /**
   * `asset.before_write` of the App a Page is saved as or written into: its definition and the
   * files of the Page's newest revision, as the write copies them. Asked after `authorize`, so
   * the caller reads the Page.
   */
  writeEventFromPage(input: {
    app: string;
    title?: string;
    conversationId: string;
    pageId: string;
    workspaceId: string;
  }): OperationBeforeEvent {
    const event = fileSetWriteEvent(this.options, {
      kind: APP_ASSET_KIND,
      name: input.app,
      read: async () => {
        const page = isPageId(input.pageId)
          ? await this.options.stores.pages.getPage({
              clientInstanceId: this.options.clientInstanceId,
              conversationId: asConversationId(input.conversationId),
              pageId: input.pageId
            })
          : undefined;
        const fileSet =
          page &&
          (await this.options.stores.pages.getPageFileSet({
            clientInstanceId: this.options.clientInstanceId,
            pageId: page.id
          }));
        if (!fileSet) return undefined;
        // The write copies this revision, whatever the Page is saved as meanwhile.
        checkedFileSets.set(event, fileSet.id);
        const title = input.title ?? (await this.currentTitle(input.app, input.workspaceId));
        return {
          fileSet,
          config: appConfigOf({
            name: input.app,
            manifest: fileSet.manifest,
            ...(title === undefined ? {} : { title })
          })
        };
      }
    });
    return event;
  }

  /**
   * The title an App of the workspace keeps when it is written from a Page again. An App of
   * that name in another scope is not the caller's: its title is not read.
   */
  private async currentTitle(name: string, workspaceId: string): Promise<string | undefined> {
    const asset = await this.options.configAssets.store.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      kind: APP_ASSET_KIND,
      name
    });
    if (!asset || !assetScopesEqual(asset.scope, scopeOf(workspaceId))) return undefined;
    const title = asset.config?.title;
    return typeof title === "string" ? title : undefined;
  }

  /**
   * Saves the newest revision of a Page as an App with a draft. The files are copied: the
   * conversation of the Page may expire while the App stays. The App remembers the Page.
   */
  async createFromPage(
    call: AssetCall,
    input: CreateAppFromPageInput,
    checked?: readonly OperationBeforeEvent[]
  ) {
    const { source, origin } = await this.newestPageRevision(call.actor, input, checked);
    const created = await this.assets.drafts.createFromFileSet(
      call,
      appAddress(input.name, input.workspaceId),
      {
        source,
        origin,
        config: appConfigOf({ name: input.name, title: input.title, manifest: source.manifest }),
        firstCommit: "Create from a Page"
      }
    );
    // The App's own event: the asset, its revision and the commit it names. No content.
    await recordAssetEvent(call, "app.created", {
      kind: APP_ASSET_KIND,
      name: input.name,
      assetId: created.id,
      workspaceId: input.workspaceId,
      revision: created.revision,
      ...(created.commit === undefined ? {} : { commit: created.commit })
    });
    return {
      id: created.id,
      name: input.name,
      workspaceId: input.workspaceId,
      revision: created.revision,
      fileSetId: created.fileSetId
    };
  }

  /**
   * Writes the newest revision of a Page as a new draft revision of the App that is updated
   * from it, and with `link` of an App that was not. Nothing is published: the App's users are
   * served what they were served before. The App keeps the name people read.
   */
  async updateFromPage(
    call: AssetCall,
    input: UpdateAppFromPageInput,
    checked?: readonly OperationBeforeEvent[]
  ) {
    const { source, origin } = await this.newestPageRevision(call.actor, input, checked);
    const updated = await this.assets.drafts.replaceFromFileSet(
      call,
      appAddress(input.app, input.workspaceId),
      {
        source,
        origin,
        link: input.link === true,
        expectedRevision: input.expectedRevision,
        configOf: (current) =>
          appConfigOf({
            name: input.app,
            manifest: source.manifest,
            ...(typeof current.title === "string" ? { title: current.title } : {})
          })
      }
    );
    return {
      id: updated.id,
      name: input.app,
      workspaceId: input.workspaceId,
      revision: updated.revision,
      fileSetId: updated.fileSetId
    };
  }

  /**
   * The App of a Page, for one caller who reads the Page: among the Apps that are updated from
   * it and that the caller may write, the one the caller wrote from it last, and without one
   * the earliest. Nothing for a caller who may write none of them, whether or not one exists.
   * With `app`, also what putting the Page into that App would meet.
   */
  async fromPage(
    caller: { user: AuthenticatedUser; access: ActorAccess },
    input: { conversationId: string; pageId: string; app?: string }
  ) {
    const page = await this.requirePage(caller.user, input);
    const kind = this.kind();
    const viewerId = getSubjectUserId(caller.user);
    // Every App of the Page is read, in parts, and the caller's right decides on each: an App
    // the caller may write is found however many of other people come before it.
    const writable: ConfigAssetFromPage[] = [];
    for (let offset = 0; ; offset += APPS_FROM_PAGE_BATCH) {
      const part = await this.options.configAssets.store.listConfigAssetsFromPage({
        clientInstanceId: this.options.clientInstanceId,
        kind: kind.kind,
        pageId: page.id,
        limit: APPS_FROM_PAGE_BATCH,
        offset
      });
      writable.push(...part.filter(({ asset }) => this.mayWrite(caller.access, asset)));
      if (part.length < APPS_FROM_PAGE_BATCH) {
        break;
      }
    }
    const found =
      writable.find(({ savedBy }) => savedBy?.subjectUserId === viewerId) ?? writable.at(0);
    const asset = found?.asset;
    const origin = asset?.revisionOrigin;
    return {
      app:
        asset && asset.scope.kind === "workspace"
          ? {
              name: asset.name,
              title: titleOf(asset),
              workspaceId: asset.scope.workspaceId,
              draftRevision: asset.revision,
              draftFromPage: origin?.kind === "page" && origin.pageId === page.id
            }
          : null,
      ...(input.app === undefined
        ? {}
        : { candidate: await this.candidate(caller.access, page, input.app) })
    };
  }

  /** An App by its id, for a caller who may write it, with the Page it is updated from. */
  private async candidate(access: ActorAccess, page: Page, name: string) {
    const asset = await this.options.configAssets.store.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      kind: APP_ASSET_KIND,
      name
    });
    if (
      !asset ||
      asset.status !== "active" ||
      asset.scope.kind !== "workspace" ||
      !this.mayWrite(access, asset)
    ) {
      return null;
    }
    const current = await this.options.configAssets.store.getConfigAssetPageOrigin({
      clientInstanceId: this.options.clientInstanceId,
      assetId: asset.id
    });
    return {
      name: asset.name,
      title: titleOf(asset),
      workspaceId: asset.scope.workspaceId,
      draftRevision: asset.revision,
      page: !current
        ? ("none" as const)
        : current.pageId === page.id
          ? ("this" as const)
          : current.conversationId === page.conversationId
            ? ("other_page" as const)
            : ("other_conversation" as const)
    };
  }

  private mayWrite(access: ActorAccess, asset: ConfigAssetRecord): boolean {
    const kind = this.kind();
    return access.authorize(
      kind.actions.write,
      accessResource(kind.kind, asset.name, asset.scope, asset.id)
    ).allowed;
  }

  /**
   * The revision of a Page the caller reads that the write copies, and what a copy of it
   * records: the one the guardrails of `checked` read, or else the newest. A revision they read
   * that is gone is refused, never replaced by another they did not read.
   */
  private async newestPageRevision(
    actor: AssetCall["actor"],
    input: { conversationId: string; pageId: string },
    checked: readonly OperationBeforeEvent[] = []
  ): Promise<{ source: FileSet; origin: PageRevisionOrigin }> {
    const page = await this.requireReadablePage(actor, input);
    const pinned = checked.flatMap((event) => checkedFileSets.get(event) ?? []).at(0);
    const source = await this.options.stores.pages.getPageFileSet({
      clientInstanceId: this.options.clientInstanceId,
      pageId: page.id,
      ...(pinned ? { fileSetId: pinned } : {})
    });
    if (!source) {
      throw pinned
        ? new AppError(
            "CONFLICT",
            "The revision of the Page the guardrails read is gone. Save the App from the Page again."
          )
        : pageNotFound();
    }
    return {
      source,
      origin: {
        kind: "page",
        conversationId: page.conversationId,
        pageId: page.id,
        fileSetNumber: source.number
      }
    };
  }

  /** The Page of a conversation the caller may read. A service principal reads none. */
  private requireReadablePage(
    actor: AssetCall["actor"],
    input: { conversationId: string; pageId: string }
  ): Promise<Page> {
    if (isAuthenticatedServicePrincipal(actor)) {
      throw new AppError("FORBIDDEN", "A Page is read by a person");
    }
    return this.requirePage(actor, input);
  }

  /** The Page of a conversation the caller may read. */
  private async requirePage(
    user: AuthenticatedUser,
    input: { conversationId: string; pageId: string }
  ): Promise<Page> {
    const conversation = await this.conversations.requireConversationAccess(
      asConversationId(input.conversationId),
      user
    );
    const page = isPageId(input.pageId)
      ? await this.options.stores.pages.getPage({
          clientInstanceId: this.options.clientInstanceId,
          conversationId: conversation.id,
          pageId: input.pageId
        })
      : undefined;
    if (!page) {
      throw pageNotFound();
    }
    return page;
  }

  /**
   * Where a frame loads the published or the draft revision of an App, for one caller. The
   * published revision is for the App's users, the draft for its writers alone. A caller
   * without the right is refused before anything says whether the App exists.
   */
  async preview(
    caller: { user: AuthenticatedUser; access: ActorAccess },
    input: { app: string; mode: AppMode }
  ) {
    const kind = this.kind();
    const asset = await this.options.configAssets.store.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      kind: kind.kind,
      name: input.app
    });
    const resource = accessResource(
      kind.kind,
      input.app,
      asset?.scope ?? { kind: "instance" },
      asset?.id
    );
    const writes = caller.access.authorize(APP_ACTIONS.write, resource).allowed;
    if (input.mode === "draft") {
      caller.access.require(APP_ACTIONS.write, resource);
    } else if (!writes) {
      // Whoever writes an App sees what its users are served. Everyone else needs the use.
      caller.access.require(APP_ACTIONS.use, resource);
    }
    const shown = asset ? shownRevision(kind, asset, input.mode) : undefined;
    if (!asset || asset.status !== "active" || asset.scope.kind !== "workspace" || !shown) {
      throw new AppError(
        "NOT_FOUND",
        input.mode === "published" && asset?.status === "active"
          ? "The App is not published"
          : "App is not available",
        input.mode === "published" && asset?.status === "active"
          ? { reason: "not_published" }
          : undefined
      );
    }
    const fileSet = await this.options.stores.pages.getAssetFileSet({
      clientInstanceId: this.options.clientInstanceId,
      assetId: asset.id,
      fileSetId: shown.fileSetId
    });
    const contentKey = this.options.pages?.contentKey;
    if (!fileSet || !contentKey) {
      throw new AppError("NOT_FOUND", "App is not available");
    }
    const outsideHosts = await appOutsideHosts(this.options.stores.pages, {
      clientInstanceId: this.options.clientInstanceId,
      assetId: asset.id,
      view: input.mode,
      shown: fileSet,
      publishedFileSetId: asset.publishedFileSetId
    });
    const expiresAt = Math.floor(Date.now() / 1000) + APP_CONTENT_TOKEN_TTL_SECONDS;
    const pageSessionId = randomUUID();
    const token = mintAppContentToken(contentKey, this.options.clientInstanceId, {
      fileSetId: fileSet.id,
      viewerId: getSubjectUserId(caller.user),
      pageSessionId,
      expiresAt,
      // Signed into the address: a call the frame makes is decided by the view that was asked
      // for, whichever revisions share this file set.
      mode: input.mode
    });
    return {
      url: appContentPath(fileSet.id, token),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      fileSetId: fileSet.id,
      number: fileSet.number,
      pageSessionId,
      revision: shown.revision,
      interfacePath: appInterfacePath({
        workspaceId: asCollaborationWorkspaceId(asset.scope.workspaceId),
        app: asset.name,
        mode: input.mode
      }),
      heldBackHosts: outsideHosts.heldBack
    };
  }

  /** The kind `app`, where its module is on. */
  private kind(): WorkflowAssetKind {
    requireAssetKindModuleOn(this.options.modules, APP_ASSET_KIND);
    return this.options.configAssets.kinds.require(APP_ASSET_KIND);
  }
}

/** What people read as an App's name. */
function titleOf(asset: ConfigAssetRecord): string {
  const title = asset.config?.title;
  return typeof title === "string" ? title : asset.name;
}

const pageNotFound = () => new AppError("NOT_FOUND", "Page is not available");

/** An App as the workflow of every asset addresses it. */
function appAddress(name: string, workspaceId: string) {
  return { kind: APP_ASSET_KIND, name, workspaceId };
}

/**
 * The revision a mode shows: the one `liveRevisionId` names for the App's users, the draft for
 * its writers. Nothing for `published` before the first publish.
 */
function shownRevision(
  kind: WorkflowAssetKind,
  asset: ConfigAssetRecord,
  mode: AppMode
): { revision: number; fileSetId: NonNullable<ConfigAssetRecord["fileSetId"]> } | undefined {
  if (mode === "draft") {
    return asset.fileSetId ? { revision: asset.revision, fileSetId: asset.fileSetId } : undefined;
  }
  const live = liveRevisionId(asset, kind);
  if (live === undefined || live !== asset.publishedRevisionId) {
    return undefined;
  }
  return asset.publishedRevision !== undefined && asset.publishedFileSetId
    ? { revision: asset.publishedRevision, fileSetId: asset.publishedFileSetId }
    : undefined;
}
