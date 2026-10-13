import { randomUUID } from "node:crypto";
import { APP_ASSET_KIND, appInterfacePath, type AppMode } from "@vivd-catalyst/api-contract";
import {
  AppError,
  asCollaborationWorkspaceId,
  asConversationId,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  isPageId,
  liveRevisionId,
  type ActorAccess,
  type AuthenticatedUser,
  type ConfigAssetRecord,
  type OperationAuthorization
} from "@vivd-catalyst/core";
import { accessResource, decide, type AssetCall } from "../asset-access";
import { APP_CONTENT_TOKEN_TTL_SECONDS, appContentPath, mintAppContentToken } from "../app-content";
import type { WorkflowAssetKind } from "../asset-kinds/shared";
import { recordAssetEvent } from "../asset-target";
import { requireAssetKindModuleOn } from "../asset-write-rules";
import { AssetWorkflow } from "../asset-workflow";
import { ConversationWorkflow } from "../conversations/conversation-workflow";
import type { ChatServerOptions } from "../types";
import { APP_ACTIONS, appConfigOf } from "./app-kind";

/** What `apps.create_from_page` is called with. */
export interface CreateAppFromPageInput {
  conversationId: string;
  pageId: string;
  name: string;
  title: string;
  workspaceId: string;
}

/**
 * What an App has beside the operations of every asset: it is made from a Page, and its
 * revisions are opened by people. Every write goes through the asset workflow, so an App made
 * here is the same revision shape as one written with `assets.put`.
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

  /** The write right on the workspace the App is to belong to. */
  authorizeCreate(access: ActorAccess, input: CreateAppFromPageInput): OperationAuthorization {
    return decide(access, APP_ACTIONS.write, {
      kind: APP_ASSET_KIND,
      name: input.name,
      workspaceId: input.workspaceId
    });
  }

  /**
   * Saves the newest revision of a Page as an App with a draft. The files are copied: the
   * conversation of the Page may expire while the App stays.
   */
  async createFromPage(call: AssetCall, input: CreateAppFromPageInput) {
    if (isAuthenticatedServicePrincipal(call.actor)) {
      throw new AppError("FORBIDDEN", "A Page is read by a person");
    }
    const conversation = await this.conversations.requireConversationAccess(
      asConversationId(input.conversationId),
      call.actor
    );
    const address = { clientInstanceId: this.options.clientInstanceId };
    const page = isPageId(input.pageId)
      ? await this.options.stores.pages.getPage({
          ...address,
          conversationId: conversation.id,
          pageId: input.pageId
        })
      : undefined;
    const source = page
      ? await this.options.stores.pages.getPageFileSet({ ...address, pageId: page.id })
      : undefined;
    if (!source) {
      throw new AppError("NOT_FOUND", "Page is not available");
    }
    const created = await this.assets.drafts.createFromFileSet(
      call,
      { kind: APP_ASSET_KIND, name: input.name, workspaceId: input.workspaceId },
      {
        source,
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
      })
    };
  }

  /** The kind `app`, where its module is on. */
  private kind(): WorkflowAssetKind {
    requireAssetKindModuleOn(this.options.modules, APP_ASSET_KIND);
    return this.options.configAssets.kinds.require(APP_ASSET_KIND);
  }
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
