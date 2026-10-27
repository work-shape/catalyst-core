import { randomUUID } from "node:crypto";
import {
  AppError,
  getSubjectUserId,
  type ActorAccess,
  type AssetKindPreview,
  type AuthenticatedUser,
  type FileSetFile
} from "@work-shape/catalyst-core";
import { accessResource } from "../assets/asset-access";
import type { ResolvedChatServerOptions } from "../types";
import { APP_CONTENT_TOKEN_TTL_SECONDS, appContentPath, mintAppContentToken } from "./app-content";

// The preview of an asset's draft, for a kind that brings one (`AssetKindPreview`), such as a
// form page: its writers see the draft beside the chat, in the frame of a Page. The document is
// the kind's own and is served by the content route like a Page's, under its guard and its
// policy, with the files the kind brings and the style sheets, images and fonts of the draft.
// The address is minted as `apps.preview` mints the draft of an App: for one person who may
// write the asset, one file set and one mount of the frame.

const previewUnavailable = () =>
  new AppError("NOT_FOUND", "The preview is not available", { reason: "preview_unavailable" });

/**
 * The preview a kind brings, while the module of the kind is on and the instance serves Pages
 * (the module `apps`, whose key signs the address of a frame).
 */
export function kindPreviewOf(
  options: Pick<ResolvedChatServerOptions, "configAssets" | "modules" | "pages">,
  kind: string
): AssetKindPreview | undefined {
  if (!options.pages?.contentKey || options.modules.offModuleOf("kind", kind) !== undefined) {
    return undefined;
  }
  const registered = options.configAssets.kinds.get(kind);
  // Only a draft is previewed: a kind whose every write is live brings none.
  return registered?.lifecycle === "draft_published" ? registered.preview : undefined;
}

/**
 * Where a frame loads the preview of the draft of one asset, for a caller who may write it. A
 * caller without the right is refused before anything says whether the asset exists.
 */
export async function mintAssetPreview(
  options: ResolvedChatServerOptions,
  caller: { user: AuthenticatedUser; access: ActorAccess },
  input: { kind: string; name: string }
) {
  const kind = options.configAssets.kinds.get(input.kind);
  if (!kind || !kindPreviewOf(options, input.kind)) {
    throw previewUnavailable();
  }
  const asset = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: kind.kind,
    name: input.name
  });
  caller.access.require(
    kind.actions.write,
    accessResource(kind.kind, input.name, asset?.scope ?? { kind: "instance" }, asset?.id)
  );
  if (!asset || asset.status !== "active" || !asset.fileSetId) {
    throw previewUnavailable();
  }
  const fileSet = await options.stores.pages.getAssetFileSet({
    clientInstanceId: options.clientInstanceId,
    assetId: asset.id,
    fileSetId: asset.fileSetId
  });
  const contentKey = options.pages?.contentKey;
  if (!fileSet || !contentKey) {
    throw previewUnavailable();
  }
  const expiresAt = Math.floor(Date.now() / 1000) + APP_CONTENT_TOKEN_TTL_SECONDS;
  const pageSessionId = randomUUID();
  const token = mintAppContentToken(contentKey, options.clientInstanceId, {
    fileSetId: fileSet.id,
    viewerId: getSubjectUserId(caller.user),
    pageSessionId,
    expiresAt,
    mode: "draft"
  });
  return {
    url: appContentPath(fileSet.id, token),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    fileSetId: fileSet.id,
    number: fileSet.number,
    pageSessionId,
    revision: asset.revision
  };
}

/**
 * Whether a file of the revision itself is served to its preview: a style sheet, an image or a
 * font. Its manifest, its data and anything that could run or be a document of its own are not.
 * An SVG is served as an image only: the content route refuses it to a navigation.
 */
export function servesInPreview(file: Pick<FileSetFile, "contentType">): boolean {
  return /^(?:text\/css|image\/(?:png|jpeg|gif|webp|svg\+xml)|font\/(?:woff2?|ttf|otf))\s*(?:;|$)/iu.test(
    file.contentType
  );
}
