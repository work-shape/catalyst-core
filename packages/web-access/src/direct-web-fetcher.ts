import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isOperationTimeout } from "@work-shape/catalyst-core";
import type {
  JsonObject,
  JsonValue,
  ToolExecutionErrorCode,
  ToolRuntimeContext,
  WebSource
} from "@work-shape/catalyst-core";
import { extractWebPageText } from "./html-text";
import {
  type WebFetchAddressResolver,
  type WebFetchResolvedAddress,
  validateWebFetchUrl,
  WebFetchSafetyError
} from "./url-safety";

export const WEB_FETCH_TOOL_NAME = "web_fetch";

export interface WebFetchRuntimeConfig {
  timeoutMs: number;
  maxResponseBytes: number;
  maxTextCharacters: number;
  maxRedirects: number;
}

export interface WebFetchInput {
  url: string;
  maxCharacters?: number;
}

export interface WebSourceMetadata extends WebSource {
  provider: "direct";
  retrievedAt: string;
  contentHash: string;
}

export interface WebFetchOutput {
  finalUrl: string;
  title?: string;
  contentType: string;
  bytes: number;
  text: string;
  truncated: boolean;
  source: WebSourceMetadata;
}

export interface WebFetchResult extends WebFetchOutput {
  redirectCount: number;
}

export interface WebFetchHttpRequestInput {
  url: URL;
  address: WebFetchResolvedAddress;
  maxBytes: number;
  signal: AbortSignal;
  /** The Accept header. Without it, `web_fetch`'s preference for pages. */
  accept?: string;
  /** Whether to read the body of a final response. Without it, `web_fetch`'s rule. */
  readsBody?: (status: number, headers: IncomingHttpHeaders) => boolean;
}

export interface WebFetchHttpResponse {
  status: number;
  statusText?: string;
  headers: IncomingHttpHeaders;
  body: Uint8Array;
  bytesRead: number;
  truncatedByBytes: boolean;
}

export type WebFetchHttpRequest = (
  input: WebFetchHttpRequestInput
) => Promise<WebFetchHttpResponse>;

export type WebFetchFailureStatus = "failed" | "cancelled" | "timed_out";

export class WebFetchFailure extends Error {
  override readonly name = "WebFetchFailure";
  readonly resultStatus: WebFetchFailureStatus;
  readonly code: ToolExecutionErrorCode;
  readonly subject: string;
  readonly metadata: JsonObject;

  constructor(input: {
    message: string;
    resultStatus?: WebFetchFailureStatus;
    code?: ToolExecutionErrorCode;
    subject: string;
    metadata?: JsonObject;
  }) {
    super(input.message);
    this.resultStatus = input.resultStatus ?? "failed";
    this.code = input.code ?? "handler_failed";
    this.subject = redactUrlUserInfoForAudit(input.subject);
    this.metadata = redactWebFetchMetadata(input.metadata ?? {});
  }
}

export interface DirectWebFetcherOptions {
  config?: Partial<WebFetchRuntimeConfig>;
  resolver?: WebFetchAddressResolver;
  request?: WebFetchHttpRequest;
  now?: () => Date;
}

const defaultRuntimeConfig: WebFetchRuntimeConfig = {
  timeoutMs: 10000,
  maxResponseBytes: 1024 * 1024,
  maxTextCharacters: 20000,
  maxRedirects: 5
};

const allowedContentTypes = new Set(["text/html", "text/plain", "application/xhtml+xml"]);

export class DirectWebFetcher {
  private readonly config: WebFetchRuntimeConfig;
  private readonly resolver?: WebFetchAddressResolver;
  private readonly request: WebFetchHttpRequest;
  private readonly now: () => Date;

  constructor(options: DirectWebFetcherOptions = {}) {
    this.config = {
      ...defaultRuntimeConfig,
      ...options.config
    };
    this.resolver = options.resolver;
    this.request = options.request ?? nodeWebFetchHttpRequest;
    this.now = options.now ?? (() => new Date());
  }

  async fetch(
    input: WebFetchInput,
    context: Pick<ToolRuntimeContext, "deadline" | "signal"> = {}
  ): Promise<WebFetchResult> {
    const { url, response, mediaType, contentType, redirectCount } = await retrieveWebResponse(
      {
        toolName: WEB_FETCH_TOOL_NAME,
        url: input.url,
        timeoutMs: this.config.timeoutMs,
        maxRedirects: this.config.maxRedirects,
        maxBytes: this.config.maxResponseBytes,
        resolver: this.resolver,
        request: this.request,
        accept: WEB_FETCH_ACCEPT,
        allowsMediaType: (type) => allowedContentTypes.has(type)
      },
      context
    );
    const extracted = extractWebPageText({
      contentType: mediaType,
      body: Buffer.from(response.body).toString("utf8")
    });
    const maxCharacters = Math.min(
      input.maxCharacters ?? this.config.maxTextCharacters,
      this.config.maxTextCharacters
    );
    const text = extracted.text.slice(0, maxCharacters);
    const truncated = response.truncatedByBytes || extracted.text.length > text.length;
    const finalUrl = url.toString();
    const contentHash = createHash("sha256").update(`${finalUrl}\n${text}`).digest("hex");
    const source: WebSourceMetadata = {
      id: `web_${contentHash.slice(0, 16)}`,
      url: finalUrl,
      ...(extracted.title ? { title: extracted.title } : {}),
      provider: "direct",
      retrievedAt: this.now().toISOString(),
      contentHash
    };

    return {
      finalUrl,
      ...(extracted.title ? { title: extracted.title } : {}),
      contentType: contentType || mediaType,
      bytes: response.bytesRead,
      text,
      truncated,
      source,
      redirectCount
    };
  }
}

export const WEB_DOWNLOAD_TOOL_NAME = "web_download";

export interface WebDownloadRuntimeConfig {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /** Media types a response may declare: `type/subtype`, `type/*` or `*\/*`. */
  contentTypes: readonly string[];
}

export interface WebDownloadInput {
  url: string;
}

export interface WebDownloadResult {
  finalUrl: string;
  /** The media type the response declared, without its parameters, such as `application/pdf`. */
  mediaType: string;
  bytes: Uint8Array;
  /** The name the response gave in Content-Disposition, if any. Never trusted as a path. */
  filename?: string;
  redirectCount: number;
}

export interface DirectWebDownloaderOptions {
  config: WebDownloadRuntimeConfig;
  resolver?: WebFetchAddressResolver;
  request?: WebFetchHttpRequest;
}

/**
 * Reads one whole file from a public address on `web_fetch`'s path: the same address checks
 * before every hop, the same redirect and timeout handling, no compressed encodings. A file
 * above `maxBytes` is refused, not cut, and its body is not read when the server says its size.
 */
export class DirectWebDownloader {
  private readonly config: WebDownloadRuntimeConfig;
  private readonly resolver?: WebFetchAddressResolver;
  private readonly request: WebFetchHttpRequest;

  constructor(options: DirectWebDownloaderOptions) {
    this.config = options.config;
    this.resolver = options.resolver;
    this.request = options.request ?? nodeWebFetchHttpRequest;
  }

  async download(
    input: WebDownloadInput,
    context: Pick<ToolRuntimeContext, "deadline" | "signal"> = {}
  ): Promise<WebDownloadResult> {
    const { maxBytes } = this.config;
    const allowsMediaType = (type: string) => mediaTypeAllowed(this.config.contentTypes, type);
    const { url, response, mediaType, redirectCount } = await retrieveWebResponse(
      {
        toolName: WEB_DOWNLOAD_TOOL_NAME,
        url: input.url,
        timeoutMs: this.config.timeoutMs,
        maxRedirects: this.config.maxRedirects,
        maxBytes,
        resolver: this.resolver,
        request: this.request,
        accept: "*/*",
        allowsMediaType,
        readsBody: (status, headers) =>
          shouldReadResponseBody(status, headers, allowsMediaType) &&
          !declaresMoreThan(headers, maxBytes)
      },
      context
    );
    if (response.truncatedByBytes || declaresMoreThan(response.headers, maxBytes)) {
      throw new WebFetchFailure({
        message: `The file is larger than the limit of ${maxBytes} bytes (webAccess.download.maxBytes), so nothing was saved`,
        code: "validation_failed",
        subject: url.toString(),
        metadata: {
          status: "failed",
          reason: "too_large",
          httpStatus: response.status,
          contentType: mediaType,
          maxBytes,
          redirectCount
        }
      });
    }
    const filename = contentDispositionFilename(getHeader(response.headers, "content-disposition"));
    return {
      finalUrl: url.toString(),
      mediaType,
      bytes: response.body,
      ...(filename ? { filename } : {}),
      redirectCount
    };
  }
}

/** Whether a media type is one of `patterns`: exact, `type/*` or `*\/*`. */
export function mediaTypeAllowed(patterns: readonly string[], mediaType: string): boolean {
  const type = mediaType.trim().toLowerCase();
  const slash = type.indexOf("/");
  if (slash <= 0) {
    return false;
  }
  const family = `${type.slice(0, slash)}/*`;
  return patterns.some((pattern) => {
    const wanted = pattern.trim().toLowerCase();
    return wanted === "*/*" || wanted === type || wanted === family;
  });
}

const WEB_FETCH_ACCEPT = "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1";

interface RetrieveWebResponseInput {
  toolName: string;
  url: string;
  timeoutMs: number;
  maxRedirects: number;
  maxBytes: number;
  resolver?: WebFetchAddressResolver;
  request: WebFetchHttpRequest;
  accept: string;
  allowsMediaType(mediaType: string): boolean;
  readsBody?: WebFetchHttpRequestInput["readsBody"];
}

interface RetrievedWebResponse {
  url: URL;
  response: WebFetchHttpResponse;
  contentType: string;
  mediaType: string;
  redirectCount: number;
}

/**
 * The one path both web tools take to a response: every address, the first and each redirect,
 * is checked before it is reached; a 2xx response with an identity encoding and an allowed media
 * type comes back, anything else is a `WebFetchFailure`.
 */
async function retrieveWebResponse(
  input: RetrieveWebResponseInput,
  context: Pick<ToolRuntimeContext, "deadline" | "signal">
): Promise<RetrievedWebResponse> {
  const { toolName } = input;
  const requestedUrl = input.url;
  const operationAbort = createOperationAbort({
    toolName,
    timeoutMs: input.timeoutMs,
    deadline: context.deadline,
    signal: context.signal
  });
  let currentUrl = requestedUrl;
  let redirectCount = 0;

  try {
    for (;;) {
      throwIfOperationAborted(operationAbort, toolName, currentUrl, redirectCount);
      const target = await validateTarget(input, currentUrl, redirectCount, operationAbort);
      throwIfOperationAborted(operationAbort, toolName, target.url.toString(), redirectCount);
      const response = await requestTarget(
        input,
        target.url,
        target.addresses,
        operationAbort.signal,
        redirectCount
      );

      if (isRedirectStatus(response.status)) {
        const location = getHeader(response.headers, "location");
        if (!location) {
          throw new WebFetchFailure({
            message: `Redirect response from '${target.url.toString()}' did not include a Location header`,
            code: "handler_failed",
            subject: target.url.toString(),
            metadata: {
              status: "failed",
              reason: "missing_redirect_location",
              httpStatus: response.status,
              redirectCount
            }
          });
        }
        if (redirectCount >= input.maxRedirects) {
          throw new WebFetchFailure({
            message: `${toolName} exceeded redirect limit of ${input.maxRedirects}`,
            code: "handler_failed",
            subject: target.url.toString(),
            metadata: {
              status: "failed",
              reason: "redirect_limit_exceeded",
              httpStatus: response.status,
              redirectCount
            }
          });
        }

        currentUrl = resolveRedirectUrl(location, target.url, requestedUrl, redirectCount);
        redirectCount += 1;
        continue;
      }

      const contentType = getHeader(response.headers, "content-type") ?? "";
      const mediaType = parseMediaType(contentType);
      if (response.status < 200 || response.status >= 300) {
        throw new WebFetchFailure({
          message: `${toolName} received HTTP ${response.status}`,
          code: "handler_failed",
          subject: target.url.toString(),
          metadata: {
            status: "failed",
            reason: "http_error",
            httpStatus: response.status,
            ...(contentType ? { contentType } : {}),
            bytes: response.bytesRead,
            redirectCount
          }
        });
      }
      const contentEncoding = getHeader(response.headers, "content-encoding")?.trim().toLowerCase();
      if (contentEncoding && contentEncoding !== "identity") {
        throw new WebFetchFailure({
          message: `Content encoding '${contentEncoding}' is not allowed for ${toolName}`,
          code: "validation_failed",
          subject: target.url.toString(),
          metadata: {
            status: "failed",
            reason: "unsupported_content_encoding",
            httpStatus: response.status,
            contentEncoding,
            bytes: response.bytesRead,
            redirectCount
          }
        });
      }
      if (!mediaType || !input.allowsMediaType(mediaType)) {
        throw new WebFetchFailure({
          message: contentType
            ? `Content type '${contentType}' is not allowed for ${toolName}`
            : "Response did not include an allowed content type",
          code: "validation_failed",
          subject: target.url.toString(),
          metadata: {
            status: "failed",
            reason: "unsupported_content_type",
            httpStatus: response.status,
            ...(contentType ? { contentType } : {}),
            bytes: response.bytesRead,
            redirectCount
          }
        });
      }

      return { url: target.url, response, contentType, mediaType, redirectCount };
    }
  } catch (error) {
    if (error instanceof WebFetchFailure) {
      throw error;
    }
    throw mapWebFetchError(error, {
      toolName,
      abortStatus: operationAbort.status(),
      subject: currentUrl,
      redirectCount
    });
  } finally {
    operationAbort.cleanup();
  }
}

async function validateTarget(
  input: RetrieveWebResponseInput,
  url: string,
  redirectCount: number,
  operationAbort: OperationAbort
): Promise<Awaited<ReturnType<typeof validateWebFetchUrl>>> {
  try {
    return await raceWithOperationAbort(
      validateWebFetchUrl(url, { resolver: input.resolver }),
      operationAbort,
      input.toolName,
      url,
      redirectCount
    );
  } catch (error) {
    if (error instanceof WebFetchSafetyError) {
      throw new WebFetchFailure({
        message: error.message,
        code: "validation_failed",
        subject: url,
        metadata: {
          status: "failed",
          reason: "blocked_url",
          requestedUrl: input.url,
          redirectCount
        }
      });
    }
    throw error;
  }
}

async function requestTarget(
  input: RetrieveWebResponseInput,
  url: URL,
  addresses: WebFetchResolvedAddress[],
  signal: AbortSignal,
  redirectCount: number
): Promise<WebFetchHttpResponse> {
  let lastError: unknown;
  for (const address of addresses) {
    try {
      return await input.request({
        url,
        address,
        maxBytes: input.maxBytes,
        signal,
        accept: input.accept,
        ...(input.readsBody ? { readsBody: input.readsBody } : {})
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      lastError = error;
    }
  }

  throw new WebFetchFailure({
    message:
      lastError instanceof Error ? lastError.message : `${input.toolName} network request failed`,
    code: "handler_failed",
    subject: url.toString(),
    metadata: {
      status: "failed",
      reason: "network_error",
      requestedUrl: input.url,
      redirectCount
    }
  });
}

export function nodeWebFetchHttpRequest(
  input: WebFetchHttpRequestInput
): Promise<WebFetchHttpResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = input.url.protocol === "https:";
    const request = isHttps ? httpsRequest : httpRequest;
    const hostname = normalizeHostname(input.url.hostname);
    const port = input.url.port ? Number.parseInt(input.url.port, 10) : isHttps ? 443 : 80;
    const headers: Record<string, string> = {
      Accept: input.accept ?? WEB_FETCH_ACCEPT,
      "Accept-Encoding": "identity",
      Host: input.url.host,
      "User-Agent": "VivdCatalystWebFetch/0.1"
    };
    const requestOptions: RequestOptions & { servername?: string } = {
      method: "GET",
      protocol: input.url.protocol,
      hostname,
      port,
      path: `${input.url.pathname || "/"}${input.url.search}`,
      headers,
      lookup(_hostname, optionsOrCallback, callback) {
        const lookupCallback =
          typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
        if (!lookupCallback) {
          return;
        }
        if (
          typeof optionsOrCallback === "object" &&
          optionsOrCallback !== null &&
          "all" in optionsOrCallback &&
          optionsOrCallback.all
        ) {
          lookupCallback(null, [
            {
              address: input.address.address,
              family: input.address.family
            }
          ]);
          return;
        }
        lookupCallback(null, input.address.address, input.address.family);
      },
      signal: input.signal
    };
    if (isHttps && !isIP(hostname)) {
      requestOptions.servername = hostname;
    }

    const req = request(requestOptions, (response) => {
      const status = response.statusCode ?? 0;
      if (isRedirectStatus(status)) {
        response.resume();
        resolve({
          status,
          statusText: response.statusMessage,
          headers: response.headers,
          body: new Uint8Array(),
          bytesRead: 0,
          truncatedByBytes: false
        });
        return;
      }
      const readsBody =
        input.readsBody ??
        ((bodyStatus: number, headers: IncomingHttpHeaders) =>
          shouldReadResponseBody(bodyStatus, headers, (type) => allowedContentTypes.has(type)));
      if (!readsBody(status, response.headers)) {
        response.on("error", () => undefined);
        response.destroy();
        resolve({
          status,
          statusText: response.statusMessage,
          headers: response.headers,
          body: new Uint8Array(),
          bytesRead: 0,
          truncatedByBytes: false
        });
        return;
      }

      const chunks: Buffer[] = [];
      let storedBytes = 0;
      let truncatedByBytes = false;
      let settled = false;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          status,
          statusText: response.statusMessage,
          headers: response.headers,
          body: Buffer.concat(chunks, storedBytes),
          bytesRead: storedBytes,
          truncatedByBytes
        });
      };

      response.on("data", (chunk: Buffer) => {
        if (settled) {
          return;
        }
        const remaining = input.maxBytes - storedBytes;
        if (remaining > 0) {
          const chunkToStore = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          chunks.push(chunkToStore);
          storedBytes += chunkToStore.length;
        }
        if (chunk.length > remaining) {
          truncatedByBytes = true;
          finish();
          response.destroy();
        }
      });
      response.on("end", finish);
      response.on("error", (error) => {
        if (!settled) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

interface OperationAbort {
  signal: AbortSignal;
  cleanup(): void;
  status(): "cancelled" | "timed_out" | undefined;
}

function createOperationAbort(input: {
  toolName: string;
  timeoutMs: number;
  deadline?: Date;
  signal?: AbortSignal;
}): OperationAbort {
  const controller = new AbortController();
  let status: "cancelled" | "timed_out" | undefined;

  const abort = (nextStatus: "cancelled" | "timed_out", reason?: unknown) => {
    if (!status) {
      status = nextStatus;
    }
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const onParentAbort = () =>
    abort(isOperationTimeout(input.signal) ? "timed_out" : "cancelled", input.signal?.reason);
  if (input.signal?.aborted) {
    onParentAbort();
  } else {
    input.signal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const now = Date.now();
  const timeoutAt = Math.min(
    now + input.timeoutMs,
    input.deadline?.getTime() ?? Number.POSITIVE_INFINITY
  );
  const timeoutDelay = timeoutAt - now;
  const timeout = Number.isFinite(timeoutDelay)
    ? setTimeout(
        () => abort("timed_out", new Error(`${input.toolName} timed out`)),
        Math.max(0, timeoutDelay)
      )
    : undefined;

  return {
    signal: controller.signal,
    cleanup() {
      if (timeout) {
        clearTimeout(timeout);
      }
      input.signal?.removeEventListener("abort", onParentAbort);
    },
    status() {
      return status;
    }
  };
}

function throwIfOperationAborted(
  operationAbort: OperationAbort,
  toolName: string,
  subject: string,
  redirectCount: number
): void {
  const abortStatus = operationAbort.status();
  if (!abortStatus) {
    return;
  }
  throw new WebFetchFailure({
    message: abortStatus === "timed_out" ? `${toolName} timed out` : `${toolName} was cancelled`,
    resultStatus: abortStatus,
    code: abortStatus === "timed_out" ? "timed_out" : "cancelled",
    subject,
    metadata: {
      status: abortStatus,
      redirectCount
    }
  });
}

function raceWithOperationAbort<T>(
  promise: Promise<T>,
  operationAbort: OperationAbort,
  toolName: string,
  subject: string,
  redirectCount: number
): Promise<T> {
  if (operationAbort.signal.aborted) {
    throwIfOperationAborted(operationAbort, toolName, subject, redirectCount);
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      try {
        throwIfOperationAborted(operationAbort, toolName, subject, redirectCount);
      } catch (error) {
        reject(error);
      }
    };
    operationAbort.signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        operationAbort.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        operationAbort.signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function mapWebFetchError(
  error: unknown,
  input: {
    toolName: string;
    abortStatus?: "cancelled" | "timed_out";
    subject: string;
    redirectCount: number;
  }
): WebFetchFailure {
  if (input.abortStatus) {
    return new WebFetchFailure({
      message:
        input.abortStatus === "timed_out"
          ? `${input.toolName} timed out`
          : `${input.toolName} was cancelled`,
      resultStatus: input.abortStatus,
      code: input.abortStatus === "timed_out" ? "timed_out" : "cancelled",
      subject: input.subject,
      metadata: {
        status: input.abortStatus,
        redirectCount: input.redirectCount
      }
    });
  }
  return new WebFetchFailure({
    message: error instanceof Error ? error.message : `${input.toolName} failed`,
    code: "handler_failed",
    subject: input.subject,
    metadata: {
      status: "failed",
      reason: "handler_error",
      redirectCount: input.redirectCount
    }
  });
}

function resolveRedirectUrl(
  location: string,
  baseUrl: URL,
  requestedUrl: string,
  redirectCount: number
): string {
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    throw new WebFetchFailure({
      message: `Redirect response from '${baseUrl.toString()}' included an invalid Location header`,
      code: "validation_failed",
      subject: baseUrl.toString(),
      metadata: {
        status: "failed",
        reason: "invalid_redirect_location",
        requestedUrl,
        redirectCount
      }
    });
  }
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function parseMediaType(contentType: string): string | undefined {
  return contentType.split(";")[0]?.trim().toLowerCase() || undefined;
}

function shouldReadResponseBody(
  status: number,
  headers: IncomingHttpHeaders,
  allowsMediaType: (mediaType: string) => boolean
): boolean {
  if (status < 200 || status >= 300) {
    return false;
  }
  const contentEncoding = getHeader(headers, "content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    return false;
  }
  const mediaType = parseMediaType(getHeader(headers, "content-type") ?? "");
  return Boolean(mediaType && allowsMediaType(mediaType));
}

/** Whether the response says in Content-Length that its body has more than `maxBytes`. */
function declaresMoreThan(headers: IncomingHttpHeaders, maxBytes: number): boolean {
  const declared = getHeader(headers, "content-length")?.trim();
  if (!declared || !/^\d+$/u.test(declared)) {
    return false;
  }
  return Number(declared) > maxBytes;
}

/**
 * The file name of a Content-Disposition header: `filename*` (RFC 5987) first, then
 * `filename`. Only the last path segment is kept; the caller makes it a safe workspace name.
 */
export function contentDispositionFilename(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/iu.exec(header);
  let name: string | undefined;
  if (extended?.[2]) {
    try {
      name = decodeURIComponent(extended[2].trim().replace(/^"|"$/gu, ""));
    } catch {
      name = undefined;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/iu.exec(header);
    name = (plain?.[1]?.replace(/\\(.)/gu, "$1") ?? plain?.[2])?.trim();
  }
  const lastSegment = name?.split(/[\\/]/u).at(-1)?.trim();
  return lastSegment || undefined;
}

function getHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.+$/gu, "");
}

function redactWebFetchMetadata(metadata: JsonObject): JsonObject {
  const redacted: JsonObject = {};
  for (const [key, value] of Object.entries(metadata)) {
    redacted[key] = redactWebFetchAuditValue(value);
  }
  return redacted;
}

function redactWebFetchAuditValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return redactUrlUserInfoForAudit(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactWebFetchAuditValue);
  }
  if (value && typeof value === "object") {
    return redactWebFetchMetadata(value);
  }
  return value;
}

function redactUrlUserInfoForAudit(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) {
      return value;
    }
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+@)/giu, "$1");
  }
}
