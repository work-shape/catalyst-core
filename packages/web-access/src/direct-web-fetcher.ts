import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type {
  JsonObject,
  JsonValue,
  ToolExecutionErrorCode,
  ToolRuntimeContext,
  WebSource
} from "@vivd-catalyst/core";
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
    const requestedUrl = input.url;
    const operationAbort = createOperationAbort({
      timeoutMs: this.config.timeoutMs,
      deadline: context.deadline,
      signal: context.signal
    });
    let currentUrl = requestedUrl;
    let redirectCount = 0;

    try {
      for (;;) {
        throwIfOperationAborted(operationAbort, currentUrl, redirectCount);
        const target = await this.validateTarget(
          currentUrl,
          requestedUrl,
          redirectCount,
          operationAbort
        );
        throwIfOperationAborted(operationAbort, target.url.toString(), redirectCount);
        const response = await this.requestTarget(
          target.url,
          target.addresses,
          operationAbort.signal,
          requestedUrl,
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
          if (redirectCount >= this.config.maxRedirects) {
            throw new WebFetchFailure({
              message: `web_fetch exceeded redirect limit of ${this.config.maxRedirects}`,
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
            message: `web_fetch received HTTP ${response.status}`,
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
        const contentEncoding = getHeader(response.headers, "content-encoding")
          ?.trim()
          .toLowerCase();
        if (contentEncoding && contentEncoding !== "identity") {
          throw new WebFetchFailure({
            message: `Content encoding '${contentEncoding}' is not allowed for web_fetch`,
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
        if (!mediaType || !allowedContentTypes.has(mediaType)) {
          throw new WebFetchFailure({
            message: contentType
              ? `Content type '${contentType}' is not allowed for web_fetch`
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
        const finalUrl = target.url.toString();
        const contentHash = createHash("sha256")
          .update(`${finalUrl}\n${text}`)
          .digest("hex");
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
    } catch (error) {
      if (error instanceof WebFetchFailure) {
        throw error;
      }
      throw mapWebFetchError(error, {
        abortStatus: operationAbort.status(),
        subject: currentUrl,
        redirectCount
      });
    } finally {
      operationAbort.cleanup();
    }
  }

  private async validateTarget(
    url: string,
    requestedUrl: string,
    redirectCount: number,
    operationAbort: OperationAbort
  ): Promise<Awaited<ReturnType<typeof validateWebFetchUrl>>> {
    try {
      return await raceWithOperationAbort(
        validateWebFetchUrl(url, { resolver: this.resolver }),
        operationAbort,
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
            requestedUrl,
            redirectCount
          }
        });
      }
      throw error;
    }
  }

  private async requestTarget(
    url: URL,
    addresses: WebFetchResolvedAddress[],
    signal: AbortSignal,
    requestedUrl: string,
    redirectCount: number
  ): Promise<WebFetchHttpResponse> {
    let lastError: unknown;
    for (const address of addresses) {
      try {
        return await this.request({
          url,
          address,
          maxBytes: this.config.maxResponseBytes,
          signal
        });
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        lastError = error;
      }
    }

    throw new WebFetchFailure({
      message: lastError instanceof Error ? lastError.message : "web_fetch network request failed",
      code: "handler_failed",
      subject: url.toString(),
      metadata: {
        status: "failed",
        reason: "network_error",
        requestedUrl,
        redirectCount
      }
    });
  }
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
      Accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1",
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
      if (!shouldReadResponseBody(status, response.headers)) {
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

  const onParentAbort = () => abort("cancelled", input.signal?.reason);
  if (input.signal?.aborted) {
    onParentAbort();
  } else {
    input.signal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const now = Date.now();
  const timeoutAt = Math.min(now + input.timeoutMs, input.deadline?.getTime() ?? Number.POSITIVE_INFINITY);
  const timeoutDelay = timeoutAt - now;
  const timeout = Number.isFinite(timeoutDelay)
    ? setTimeout(() => abort("timed_out", new Error("web_fetch timed out")), Math.max(0, timeoutDelay))
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
  subject: string,
  redirectCount: number
): void {
  const abortStatus = operationAbort.status();
  if (!abortStatus) {
    return;
  }
  throw new WebFetchFailure({
    message: abortStatus === "timed_out" ? "web_fetch timed out" : "web_fetch was cancelled",
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
  subject: string,
  redirectCount: number
): Promise<T> {
  if (operationAbort.signal.aborted) {
    throwIfOperationAborted(operationAbort, subject, redirectCount);
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      try {
        throwIfOperationAborted(operationAbort, subject, redirectCount);
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
    abortStatus?: "cancelled" | "timed_out";
    subject: string;
    redirectCount: number;
  }
): WebFetchFailure {
  if (input.abortStatus) {
    return new WebFetchFailure({
      message: input.abortStatus === "timed_out" ? "web_fetch timed out" : "web_fetch was cancelled",
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
    message: error instanceof Error ? error.message : "web_fetch failed",
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

function shouldReadResponseBody(status: number, headers: IncomingHttpHeaders): boolean {
  if (status < 200 || status >= 300) {
    return false;
  }
  const contentEncoding = getHeader(headers, "content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    return false;
  }
  const mediaType = parseMediaType(getHeader(headers, "content-type") ?? "");
  return Boolean(mediaType && allowedContentTypes.has(mediaType));
}

function getHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.+$/gu, "");
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
