import { randomUUID } from "node:crypto";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  asUserId,
  authenticatedUserFromRecord,
  getSubjectUserId,
  isAppError,
  isFileSetId,
  isPageId,
  normalizeAllowedOrigins,
  toErrorEnvelope,
  type FileSet,
  type FileSetId,
  type FileSetSummary,
  type Page,
  type PageId,
  type ServedFileSet
} from "@work-shape/catalyst-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  APP_CONTENT_TOKEN_TTL_SECONDS,
  appContentCacheControl,
  appContentDestinationAllowed,
  appContentHeaders,
  appContentPath,
  appContentView,
  checkAppContentToken,
  composePageShell,
  createAppContentViewerChecks,
  holdsAppContentToken,
  isAppContentAddress,
  isHtmlContentType,
  mintAppContentToken
} from "../pages/app-content";
import { draftHostsOffer, frameOutsideHosts } from "../apps/draft-hosts";
import { mayOpenAssetFileSet } from "../assets/asset-access";
import { ConversationWorkflow } from "../conversations/conversation-service";
import type { Route } from "../http/route";
import { fileSetEntryPath, readFileSetFile } from "../pages/page-file-sets";
import { conversationIdParam } from "./request-context";
import type { ResolvedChatServerOptions } from "../types";

/** What the content route refuses with. All are `404`, a code and nothing else. */
type AppContentRefusal = "token_invalid" | "token_expired" | "file_set_unknown" | "file_unknown";

function contentRefusal(reason: AppContentRefusal): AppError {
  return new AppError("NOT_FOUND", "Not available", { reason });
}

const pageNotFound = () => new AppError("NOT_FOUND", "Page is not available");

export function registerPageRoutes(route: Route, options: ResolvedChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);
  const frameAncestors = normalizeAllowedOrigins(options.allowedOrigins);

  function contentKey(): Uint8Array {
    if (!options.pages?.contentKey) {
      throw new AppError("INTERNAL", "Pages are not configured on this instance");
    }
    return options.pages.contentKey;
  }

  /** The Page of a conversation the caller may read. Every route below starts here. */
  async function requirePage(
    params: { conversationId: string; pageId: string },
    user: Parameters<ConversationWorkflow["requireConversationAccess"]>[1]
  ): Promise<Page> {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    const page = isPageId(params.pageId)
      ? await options.stores.pages.getPage({
          clientInstanceId: options.clientInstanceId,
          conversationId,
          pageId: params.pageId
        })
      : undefined;
    if (!page) {
      throw pageNotFound();
    }
    return page;
  }

  const viewerChecks = createAppContentViewerChecks();

  /**
   * Whether the user a content token names may be served the file set now: the account is
   * active and, for a Page, the conversation is one this user reads, by the rule of every
   * other route.
   */
  async function viewerMayRead(viewerId: string, fileSet: ServedFileSet): Promise<boolean> {
    const viewer = await options.stores.users.getUser({
      clientInstanceId: options.clientInstanceId,
      userId: asUserId(viewerId)
    });
    if (!viewer || viewer.status !== "active") {
      return false;
    }
    const identity = authenticatedUserFromRecord({
      user: viewer,
      identity: viewer.identities[0] ?? { authSource: "app-content", externalUserId: viewer.id }
    });
    if (fileSet.asset) {
      // A file set of an asset: its users are served the published revision, its writers every
      // one. The rights are loaded as for a call of this viewer, so a membership that ended
      // or a pointer that moved ends the serving at the next check.
      const { asset } = fileSet;
      if (options.modules.offModuleOf("kind", asset.kind) !== undefined) {
        return false;
      }
      return mayOpenAssetFileSet(
        options.configAssets.kinds.get(asset.kind),
        await options.authorizer.forActor(identity),
        asset
      );
    }
    try {
      await conversations.requireConversationAccess(fileSet.conversationId, identity);
      return true;
    } catch (error) {
      if (isAppError(error) && error.code === "NOT_FOUND") {
        return false;
      }
      throw error;
    }
  }

  async function requireFileSet(pageId: PageId, fileSetId: string | undefined): Promise<FileSet> {
    const fileSet =
      fileSetId === undefined || isFileSetId(fileSetId)
        ? await options.stores.pages.getPageFileSet({
            clientInstanceId: options.clientInstanceId,
            pageId,
            ...(fileSetId === undefined ? {} : { fileSetId })
          })
        : undefined;
    if (!fileSet) {
      throw new AppError("NOT_FOUND", "Page revision is not available");
    }
    return fileSet;
  }

  route(apiOperations["pages.list"], async ({ user, params }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    const pages = await options.stores.pages.listPages({
      clientInstanceId: options.clientInstanceId,
      conversationId
    });
    return pages.map(toPageResponse);
  });

  route(apiOperations["pages.get"], async ({ user, params }) => {
    const page = await requirePage(params, user);
    const fileSets = await options.stores.pages.listPageFileSets({
      clientInstanceId: options.clientInstanceId,
      pageId: page.id
    });
    return { ...toPageResponse(page), fileSets: fileSets.map(toFileSetResponse) };
  });

  route(apiOperations["pages.files.list"], async ({ user, params }) => {
    const page = await requirePage(params, user);
    const fileSet = await requireFileSet(page.id, params.fileSetId);
    return {
      files: fileSet.sourceFiles
        .map((file) => ({
          path: file.path,
          contentType: file.contentType,
          bytes: file.bytes,
          sha256: file.sha256
        }))
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    };
  });

  route(apiOperations["pages.files.get"], async ({ user, params, query }) => {
    const page = await requirePage(params, user);
    const fileSet = await requireFileSet(page.id, params.fileSetId);
    const file = fileSet.sourceFiles.find((candidate) => candidate.path === query.path);
    if (!file) {
      throw new AppError("NOT_FOUND", "File is not available");
    }
    const bytes = await readFileSetFile(options, fileSet, "src", file);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new AppError("VALIDATION_FAILED", "The file is not text and cannot be shown");
    }
    return {
      path: file.path,
      contentType: file.contentType,
      bytes: file.bytes,
      sha256: file.sha256,
      text
    };
  });

  // Where a caller's right to a Page is checked with the caller present. A frame without an
  // origin has no session to send, so the address this answers is all a file request carries:
  // it is a secret until it expires, and it serves while its viewer may still read the Page.
  route(apiOperations["pages.preview"], async ({ user, params, body, reply }) => {
    const page = await requirePage(params, user);
    const fileSet = await requireFileSet(page.id, body.fileSetId);
    const expiresAt = Math.floor(Date.now() / 1000) + APP_CONTENT_TOKEN_TTL_SECONDS;
    const pageSessionId = randomUUID();
    const token = mintAppContentToken(contentKey(), options.clientInstanceId, {
      fileSetId: fileSet.id,
      viewerId: getSubjectUserId(user),
      pageSessionId,
      expiresAt
    });
    // What the frame holds back of the hosts the Page lists, and which of them the caller may
    // allow for their own view: a Page is the caller's own draft, never reviewed.
    const hosts = await frameOutsideHosts(
      options,
      { ...fileSet, conversationId: page.conversationId },
      { view: "draft", viewerId: getSubjectUserId(user) }
    );
    const draftHosts = draftHostsOffer(options, {
      caller: user,
      mayWrite: true,
      heldBack: hosts.heldBack,
      manifest: fileSet.manifest
    });
    void reply.header("cache-control", "no-store");
    return {
      url: appContentPath(fileSet.id, token),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      fileSetId: fileSet.id,
      number: fileSet.number,
      pageSessionId,
      heldBackHosts: hosts.heldBack,
      ...(draftHosts ? { draftHosts } : {})
    };
  });

  route(apiOperations["app_content.files.get"], async ({ request, reply }) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const address = parseContentAddress(wildcardOf(request.params));
    if (!address) {
      throw contentRefusal("token_invalid");
    }
    const checked = checkAppContentToken(contentKey(), options.clientInstanceId, {
      token: address.token,
      fileSetId: address.fileSetId,
      nowSeconds
    });
    if (!checked.ok) {
      throw contentRefusal(checked.refusal);
    }
    const fileSet = await options.stores.pages.getServedFileSet({
      clientInstanceId: options.clientInstanceId,
      fileSetId: address.fileSetId
    });
    if (!fileSet) {
      throw contentRefusal("file_set_unknown");
    }
    // Every file request passes here, the document and each file it loads. A viewer who lost
    // access is answered as if the file set were unknown.
    const allowed = await viewerChecks.allows(address.token, nowSeconds, () =>
      viewerMayRead(checked.claims.viewerId, fileSet)
    );
    if (!allowed) {
      throw contentRefusal("file_set_unknown");
    }
    const requested = address.path;
    const cacheControl = appContentCacheControl(checked.claims.expiresAt - nowSeconds);
    const path = requested === "" ? fileSetEntryPath(fileSet) : requested;
    const file = fileSet.builtFiles.find((candidate) => candidate.path === path);
    if (!file) {
      throw contentRefusal("file_unknown");
    }
    if (!appContentDestinationAllowed(request.headers["sec-fetch-dest"], file.contentType)) {
      throw new AppError("FORBIDDEN", "A file of a Page is served to its frame only");
    }
    const bytes = await readFileSetFile(options, fileSet, "dist", file);
    if (!isHtmlContentType(file.contentType)) {
      return send(reply, file.contentType, cacheControl, Buffer.from(bytes));
    }
    // An HTML file is answered as the shell that holds it, never as it is stored. The policy
    // of this answer names the one script of the shell's frame and the outside hosts it may
    // connect to: of an App's, never one that a draft added before it was published.
    const storage = fileSet.asset
      ? {
          persistent: true,
          session: checked.claims.pageSessionId,
          values: await options.stores.pages.getAppUserStorage({
            clientInstanceId: options.clientInstanceId,
            appId: fileSet.asset.id,
            userId: asUserId(checked.claims.viewerId)
          })
        }
      : { persistent: false, session: checked.claims.pageSessionId, values: {} };
    const shell = composePageShell(new TextDecoder().decode(bytes), storage);
    // The viewer is the one the token names: hosts that person allowed for their own view of
    // a draft are theirs alone (DRAFT-HOSTS-1).
    const outsideHosts = await frameOutsideHosts(options, fileSet, {
      view: fileSet.asset ? appContentView(checked.claims.mode, fileSet.asset) : "draft",
      viewerId: checked.claims.viewerId
    });
    void reply.headers(
      appContentHeaders(frameAncestors, {
        pageScriptHash: shell.pageScriptHash,
        outsideHosts: outsideHosts.allowed
      })
    );
    // Personal snapshots change independently of the immutable revision.
    return send(
      reply,
      file.contentType,
      storage.persistent ? "no-store" : cacheControl,
      shell.document
    );
  });
}

/**
 * What holds for every request below the prefix of the content route, whatever answers it: the
 * operation, a refusal before the operation is reached (a module that is off, a rate limit),
 * another method, or no route at all. Each answer carries the header set and is never kept,
 * and none names the address, which may hold a token.
 */
export function installAppContentBoundary(
  app: FastifyInstance,
  allowedOrigins: ResolvedChatServerOptions["allowedOrigins"]
): void {
  const headers = {
    ...appContentHeaders(normalizeAllowedOrigins(allowedOrigins)),
    "cache-control": "no-store"
  };
  app.addHook("onRequest", async (request, reply) => {
    if (holdsAppContentToken(request)) {
      void reply.headers(headers);
    }
  });
}

/**
 * Answers a request the framework itself turned away, which is an address it cannot read. The
 * framework's own answer repeats the address; this one says a fixed sentence, and below the
 * prefix of the content route it carries the header set like every other answer there.
 */
export function createFrameworkErrorHandler(
  allowedOrigins: ResolvedChatServerOptions["allowedOrigins"]
): (error: Error, request: FastifyRequest, reply: FastifyReply) => void {
  const headers = {
    ...appContentHeaders(normalizeAllowedOrigins(allowedOrigins)),
    "cache-control": "no-store"
  };
  return (_error, request, reply) => {
    if (isAppContentAddress(request.url)) {
      void reply.headers(headers);
    }
    const envelope = toErrorEnvelope(
      new AppError("VALIDATION_FAILED", "The address of the request cannot be read"),
      request.id
    );
    void reply
      .status(envelope.statusCode)
      .type("application/json; charset=utf-8")
      .send({ error: envelope.error });
  };
}

function send(
  reply: FastifyReply,
  contentType: string,
  cacheControl: string,
  body: string | Buffer
): FastifyReply {
  return reply.header("content-type", contentType).header("cache-control", cacheControl).send(body);
}

/** `<file set id>/<token>/<path>` as its three parts. The path may be empty and hold slashes. */
function parseContentAddress(
  rest: string
): { fileSetId: FileSetId; token: string; path: string } | undefined {
  const [fileSetId = "", token = "", ...path] = rest.split("/");
  // Without the slash after the token a relative address of the Page would resolve one level
  // too high, so such an address names nothing.
  return isFileSetId(fileSetId) && token !== "" && path.length > 0
    ? { fileSetId, token, path: path.join("/") }
    : undefined;
}

/** What the route's wildcard matched: everything after `/app-content/`. */
function wildcardOf(params: unknown): string {
  const value: unknown =
    typeof params === "object" && params !== null ? Reflect.get(params, "*") : undefined;
  return typeof value === "string" ? value : "";
}

function toPageResponse(page: Page) {
  return {
    id: page.id,
    conversationId: page.conversationId,
    name: page.name,
    createdAt: page.createdAt
  };
}

function toFileSetResponse(fileSet: FileSetSummary) {
  return {
    id: fileSet.id,
    number: fileSet.number,
    kitVersion: fileSet.kitVersion,
    sourceFileCount: fileSet.sourceFileCount,
    builtFileCount: fileSet.builtFileCount,
    totalBytes: fileSet.totalBytes,
    createdAt: fileSet.createdAt
  };
}
