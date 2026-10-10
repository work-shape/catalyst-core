import { randomUUID } from "node:crypto";
import { apiOperations } from "@vivd-catalyst/api-contract";
import {
  AppError,
  getSubjectUserId,
  isFileSetId,
  isPageId,
  normalizeAllowedOrigins,
  toErrorEnvelope,
  type FileSet,
  type FileSetId,
  type FileSetSummary,
  type Page,
  type PageId
} from "@vivd-catalyst/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  APP_CONTENT_TOKEN_TTL_SECONDS,
  appContentCacheControl,
  appContentDestinationAllowed,
  appContentHeaders,
  appContentPath,
  checkAppContentToken,
  composePageShell,
  holdsAppContentToken,
  isAppContentAddress,
  isHtmlContentType,
  mintAppContentToken
} from "../app-content";
import { ConversationWorkflow } from "../conversation-workflow";
import type { Route } from "../http/route";
import { fileSetEntryPath, readFileSetFile } from "../page-file-sets";
import { conversationIdParam } from "../request-context";
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

  // The one place a caller's right to a Page is checked. The address it answers is then the
  // whole authorization of every file request until it expires: a frame without an origin has
  // no session to send. Whoever holds the address is served, so it is a secret for that long.
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
    void reply.header("cache-control", "no-store");
    return {
      url: appContentPath(fileSet.id, token),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      fileSetId: fileSet.id,
      number: fileSet.number,
      pageSessionId
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
    // of this answer names the one script of the shell's frame.
    const shell = composePageShell(new TextDecoder().decode(bytes));
    void reply.headers(appContentHeaders(frameAncestors, shell.pageScriptHash));
    return send(reply, file.contentType, cacheControl, shell.document);
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
