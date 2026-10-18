import { retryAfterSeconds } from "../retry-after";
import type { IncomingMessage } from "node:http";
import {
  CONNECTION_CREDENTIAL_WORDS,
  CONNECTION_REFUSALS,
  connectionCallError,
  connectionCallReasonOf,
  isJsonObject,
  unknownToJsonValue,
  type ConnectionCallReason,
  type ConnectionOperationConfig,
  type ConnectorContext,
  type ConnectorTestStatus,
  type ConnectorTypeDefinition,
  type JsonObject,
  type JsonValue
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { holdsCredential } from "../connector-context";
import { egressTargetOfUrl } from "../egress";
import { hostHeaderOf, oneRequestAgent, sendPinnedRequest } from "../pinned-request";
import { httpApiDeclaredOperations, isDotSegment, pathPlaceholders } from "./declaration";

// The Connector type `http_api`, first cut (CS-5a): a REST interface reached by GET. Each
// Connection declares its operations itself (`./declaration`). A call sends the declared path
// with its path parameters percent-encoded, the declared query parameters, the fixed headers
// of the settings and the credential, to the checked address, and nothing else. No redirect
// is followed. The answer is JSON under a byte bound; a list is answered as `{ items }`, so
// every result is an object.

/** The id a Connection names as its `connectorType`. */
export const HTTP_API_CONNECTOR_TYPE = "http_api";
/** How long one call may take. Reached: `upstream_timeout`. */
export const HTTP_API_CALL_TIMEOUT_MS = 30_000;
/** How long a test of a Connection may take. */
export const HTTP_API_TEST_TIMEOUT_MS = 10_000;
/** The largest answer of one call, in bytes as sent. Reached: `output_invalid`. */
export const HTTP_API_RESULT_MAX_BYTES = 2 * 1024 * 1024;
/** Calls of one Connection that run side by side in one process. */
export const HTTP_API_MAX_PARALLEL_CALLS = 8;
/** The longest base address and test path. */
const HTTP_API_URL_MAX_CHARS = 2_048;
/** Keeps encoded requests within common server URL bounds; reached: `input_invalid`, naming the byte limit. */
const HTTP_API_REQUEST_URL_MAX_BYTES = 8_000;
/** How many fixed headers a Connection sends, and how long one value is. */
const FIXED_HEADERS_MAX = 16;
const FIXED_HEADER_VALUE_MAX_CHARS = 1_024;

/**
 * The words that make a header name one that can carry a credential, compared without case.
 * Such a header is refused in the settings with `credential_in_settings`: a credential goes
 * through the auth scheme, never into a fixed header. The release's one list, which an agent's
 * draft also refuses parameters by.
 */
export const HTTP_API_CREDENTIAL_HEADER_WORDS = CONNECTION_CREDENTIAL_WORDS;
/** Names refused as a whole, beside the words: `Authorization` holds `auth` already. */
const CREDENTIAL_HEADER_NAMES = ["proxy-authorization", "cookie"];

/**
 * The headers the connector writes itself, and those of the one connection a request travels
 * on. Neither a fixed header nor the credential's header may be one of them. Lower case.
 */
const TRANSPORT_HEADER_NAMES: ReadonlySet<string> = new Set([
  "host",
  "accept",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
  "expect"
]);

const HEADER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/u;
/** Printable characters only: no line break can end a header early. */
const HEADER_VALUE_PATTERN = /^[\x20-\x7e]*$/u;

/** Whether a header name can carry a credential, by the release's list. */
export function isCredentialHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    CREDENTIAL_HEADER_NAMES.includes(lower) ||
    HTTP_API_CREDENTIAL_HEADER_WORDS.some((word) => lower.includes(word))
  );
}

/**
 * The address every request starts with: `https`, or `http` for a target the operator's
 * egress list marks as private, as for an MCP server. It may hold a path, and no user name,
 * password, query or fragment: a key in an address ends up in the logs of the other side.
 */
const baseUrlSchema = z
  .string()
  .max(HTTP_API_URL_MAX_CHARS)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }, "must be an http or https address without user name, password, query or fragment");

/** A GET path for the test, relative to the base address, without query. */
const testPathSchema = z
  .string()
  .max(HTTP_API_URL_MAX_CHARS)
  .regex(/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/u, {
    message: "must be a path that starts with '/' and holds no query, fragment or space"
  })
  .refine(
    (path) => !path.split("/").some(isDotSegment),
    "must hold no '.' or '..' segment, also not written as %2e"
  );

const headerNameSchema = z.string().regex(HEADER_NAME_PATTERN, {
  message: "must be a header name of letters, digits and hyphens"
});

const settingsSchema = z
  .object({
    baseUrl: baseUrlSchema,
    /** Sent with every request, such as `x-client-instance-id`. Never a credential. */
    headers: z
      .record(
        headerNameSchema,
        z
          .string()
          .max(FIXED_HEADER_VALUE_MAX_CHARS)
          .regex(HEADER_VALUE_PATTERN, { message: "must be printable text on one line" })
      )
      .refine((headers) => Object.keys(headers).length <= FIXED_HEADERS_MAX, {
        message: `A Connection sends at most ${FIXED_HEADERS_MAX} fixed headers`
      })
      .optional(),
    testPath: testPathSchema.optional(),
    /** The header the key goes into under the auth scheme `header`. */
    headerName: headerNameSchema.optional(),
    personContextHeader: headerNameSchema.optional()
  })
  .strict()
  .superRefine((settings, context) => {
    const fixed = Object.keys(settings.headers ?? {});
    for (const name of fixed) {
      const lower = name.toLowerCase();
      if (isCredentialHeaderName(lower)) {
        context.addIssue({
          code: "custom",
          path: ["headers", name],
          message: `${CONNECTION_REFUSALS.credentialInSettings}: the header '${name}' can carry a credential. A key goes into the key field and is sent by the auth scheme`
        });
      } else if (TRANSPORT_HEADER_NAMES.has(lower)) {
        context.addIssue({
          code: "custom",
          path: ["headers", name],
          message: `The header '${name}' is written by the connector itself`
        });
      }
    }
    if (fixed.length !== new Set(fixed.map((name) => name.toLowerCase())).size) {
      context.addIssue({ code: "custom", path: ["headers"], message: "A header is named once" });
    }
    const personHeader = settings.personContextHeader?.toLowerCase();
    if (
      personHeader !== undefined &&
      (isCredentialHeaderName(personHeader) ||
        TRANSPORT_HEADER_NAMES.has(personHeader) ||
        fixed.some((name) => name.toLowerCase() === personHeader) ||
        settings.headerName?.toLowerCase() === personHeader)
    ) {
      context.addIssue({
        code: "custom",
        path: ["personContextHeader"],
        message: "must not be a credential, transport or fixed header"
      });
    }
    const credentialHeader = settings.headerName?.toLowerCase();
    if (credentialHeader !== undefined) {
      if (TRANSPORT_HEADER_NAMES.has(credentialHeader)) {
        context.addIssue({
          code: "custom",
          path: ["headerName"],
          message: "must not be a header the connector writes itself, such as Host or Accept"
        });
      } else if (fixed.some((name) => name.toLowerCase() === credentialHeader)) {
        context.addIssue({
          code: "custom",
          path: ["headerName"],
          message: "must not be one of the fixed headers"
        });
      }
    }
  });

type HttpApiSettings = z.infer<typeof settingsSchema>;

function settingsOf(settings: JsonObject): HttpApiSettings {
  const read = settingsSchema.safeParse(settings);
  // The platform hands a type only settings its schema accepted.
  if (!read.success) throw connectionCallError("connection_not_configured");
  return read.data;
}

/**
 * The address of a path relative to the base address: the base's path, then this one. A dot
 * segment is refused here as well as at save, so a path stored before the save refused it,
 * or a filled placeholder, never leaves the base path.
 */
function addressOf(baseUrl: string, path: string, query?: URLSearchParams): URL {
  if (path.split("/").some(isDotSegment)) {
    throw connectionCallError("input_invalid", "the path holds a '.' or '..' segment");
  }
  const url = new URL(baseUrl);
  const base = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${base}${path}` || "/";
  if (query !== undefined) url.search = query.toString();
  if (Buffer.byteLength(url.href, "utf8") > HTTP_API_REQUEST_URL_MAX_BYTES) {
    throw connectionCallError(
      "input_invalid",
      `the request URL exceeds HTTP_API_REQUEST_URL_MAX_BYTES (${HTTP_API_REQUEST_URL_MAX_BYTES} bytes)`
    );
  }
  return url;
}

function reasonOfStatus(status: number): ConnectionCallReason {
  if (status === 401 || status === 403) return "upstream_unauthorized";
  if (status === 409) return "upstream_conflict";
  if (status === 429) return "upstream_rate_limited";
  if (status === 502 || status === 503 || status === 504) return "connection_unavailable";
  return "upstream_error";
}

/**
 * Sends one GET to the Connection's own origin and answers once the status line arrived.
 * The headers are the fixed ones of the settings, the credential's, `Accept` and `Host`,
 * and no other. The socket belongs to this request alone and ends with its answer.
 */
async function get(
  context: ConnectorContext,
  settings: HttpApiSettings,
  url: URL,
  signal: AbortSignal
): Promise<IncomingMessage> {
  const grant = context.target;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(settings.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  for (const [name, value] of Object.entries(context.credentialFor(grant)?.headers ?? {})) {
    const lower = name.toLowerCase();
    // The settings refuse this. A credential that names a header of its own all the same is
    // not sent, and neither is the request.
    if (TRANSPORT_HEADER_NAMES.has(lower) || lower in headers) {
      throw connectionCallError("connection_not_configured");
    }
    headers[lower] = value;
  }
  if (settings.personContextHeader !== undefined) {
    const person = context.personContext;
    const header = settings.personContextHeader.toLowerCase();
    // Defence at dispatch too: no caller can make a scoped request without its mapping.
    if (
      person === undefined ||
      person.header !== header ||
      person.value.trim().length === 0 ||
      person.value.length > FIXED_HEADER_VALUE_MAX_CHARS ||
      !HEADER_VALUE_PATTERN.test(person.value)
    ) {
      throw connectionCallError("person_context_unmapped");
    }
    if (header in headers) throw connectionCallError("connection_not_configured");
    headers[header] = person.value;
  }
  headers.accept = "application/json";
  headers.host = hostHeaderOf(grant);
  const agent = oneRequestAgent(grant);
  try {
    const response = await sendPinnedRequest({
      url,
      grant,
      method: "GET",
      headers,
      body: undefined,
      agent,
      signal
    });
    response.once("close", () => agent.destroy());
    return response;
  } catch {
    agent.destroy();
    throw connectionCallError(signal.aborted ? "upstream_timeout" : "connection_unavailable");
  }
}

/** The body of an answer, read to its end and no further than `maxBytes`. */
async function bodyOf(
  response: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let read = 0;
  try {
    for await (const chunk of response) {
      if (!(chunk instanceof Uint8Array)) throw connectionCallError("upstream_error");
      read += chunk.byteLength;
      if (read > maxBytes) {
        throw connectionCallError(
          "output_invalid",
          "the answer is larger than HTTP_API_RESULT_MAX_BYTES"
        );
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    response.destroy();
    if (connectionCallReasonOf(error) !== undefined) throw error;
    throw connectionCallError(signal.aborted ? "upstream_timeout" : "connection_unavailable");
  }
  return Buffer.concat(chunks);
}

/** The answer as a result: a JSON object as it is, a JSON list as `{ items }`. */
function resultOf(body: Buffer): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw connectionCallError("output_invalid", "the answer is not JSON");
  }
  const value = unknownToJsonValue(parsed);
  if (Array.isArray(value)) return { items: value };
  if (isJsonObject(value)) return value;
  throw connectionCallError("output_invalid", "the answer is neither a JSON object nor a list");
}

/**
 * A path parameter's value as one encoded path segment. An empty value and a `/` are refused
 * here, a value `.` or `..` by `addressOf`: each would change which path the request reaches.
 */
function pathSegmentOf(value: JsonValue | undefined): string {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string" || text === "" || text.includes("/")) {
    throw connectionCallError("input_invalid");
  }
  return encodeURIComponent(text);
}

/**
 * The address of one call: the declared path with each placeholder filled, and the declared
 * query parameters the input names. An input that names anything else is refused. The input
 * schema refused it already; this is the second net, where the request is built.
 */
function callAddress(baseUrl: string, operation: ConnectionOperationConfig, input: JsonValue): URL {
  // An operation without parameters may be called without an input.
  const values = input === null ? {} : input;
  if (!isJsonObject(values) || operation.path === undefined) {
    throw connectionCallError("input_invalid");
  }
  const pathParams = operation.pathParams ?? {};
  const queryParams = operation.query ?? {};
  for (const name of Object.keys(values)) {
    if (!Object.hasOwn(pathParams, name) && !Object.hasOwn(queryParams, name)) {
      throw connectionCallError("input_invalid");
    }
  }
  let path = operation.path;
  for (const name of pathPlaceholders(operation.path)) {
    const segment = pathSegmentOf(values[name]);
    path = path.replace(`{${name}}`, () => segment);
  }
  const query = new URLSearchParams();
  for (const name of Object.keys(queryParams)) {
    const value = values[name];
    if (value === undefined || value === null) continue;
    if (queryParams[name]?.schema.type === "array") {
      if (!Array.isArray(value)) throw connectionCallError("input_invalid");
      for (const item of value) {
        if (
          typeof item !== "string" &&
          typeof item !== "boolean" &&
          !(typeof item === "number" && Number.isFinite(item))
        ) {
          throw connectionCallError("input_invalid");
        }
        query.append(name, String(item));
      }
      continue;
    }
    if (typeof value === "object") throw connectionCallError("input_invalid");
    query.append(name, String(value));
  }
  return addressOf(baseUrl, path, query);
}

/** A continuation never changes the origin, escapes the base path or carries credentials. */
function nextPageAddress(baseUrl: string, address: string, previous: URL): URL {
  try {
    const base = new URL(baseUrl);
    const url = new URL(address, previous);
    const prefix = base.pathname.replace(/\/+$/u, "");
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.hash ||
      (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
    )
      throw connectionCallError("egress_denied");
    // Encoded separators can be decoded again by a proxy behind the checked origin.
    if (/%(?:2e|2f|5c|25)/iu.test(url.pathname) || url.pathname.includes("\\"))
      throw connectionCallError("egress_denied");
    return url;
  } catch {
    throw connectionCallError("egress_denied");
  }
}

function testStatusOf(error: unknown): ConnectorTestStatus {
  const reason = connectionCallReasonOf(error);
  if (reason === "upstream_unauthorized") return "unauthorized";
  if (reason === "egress_denied") return "network_denied";
  return "unavailable";
}

/**
 * The Connector type `http_api` of one process. Building it opens no connection: the first
 * request leaves with the first test or call.
 */
export function createHttpApiConnectorType(): ConnectorTypeDefinition {
  return {
    type: HTTP_API_CONNECTOR_TYPE,
    description: "A REST interface over HTTPS, read by declared GET requests.",
    settingsSchema,
    authSchemes: ["none", "bearer", "header"],
    secretFields: ["key"],
    target: (settings) => egressTargetOfUrl(settingsOf(settings).baseUrl),
    credentialHeaderName: (settings) => settingsOf(settings).headerName,
    personContextHeaderName: (settings) => settingsOf(settings).personContextHeader?.toLowerCase(),
    limits: {
      callTimeoutMs: HTTP_API_CALL_TIMEOUT_MS,
      resultMaxBytes: HTTP_API_RESULT_MAX_BYTES,
      maxParallelCalls: HTTP_API_MAX_PARALLEL_CALLS
    },
    declared: httpApiDeclaredOperations,

    // A test asks the test path, else the base address, and keeps nothing of the answer. On
    // the base address any answer but a refusal says the system is there: a base address
    // often answers 404 to a GET. A test path is a health address and must answer 2xx.
    async test(context) {
      const settings = settingsOf(context.connection.settings);
      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(HTTP_API_TEST_TIMEOUT_MS)
      ]);
      try {
        const url = addressOf(settings.baseUrl, settings.testPath ?? "");
        const response = await get(context, settings, url, signal);
        response.destroy();
        const status = response.statusCode ?? 0;
        if (status === 401 || status === 403) return { status: "unauthorized" };
        if (settings.testPath === undefined) return { status: "ready" };
        return { status: status >= 200 && status <= 299 ? "ready" : "unavailable" };
      } catch (error) {
        return { status: testStatusOf(error) };
      }
    },

    async execute(name, input, context) {
      const settings = settingsOf(context.connection.settings);
      const operation = context.connection.operations.find((entry) => entry.name === name);
      if (!operation) throw connectionCallError("operation_unknown");
      const initial = callAddress(settings.baseUrl, operation, input);
      const previous = context.previousPageAddress
        ? nextPageAddress(settings.baseUrl, context.previousPageAddress, initial)
        : initial;
      const url = context.pageAddress
        ? nextPageAddress(settings.baseUrl, context.pageAddress, previous)
        : initial;
      context.notePageAddress?.(url.href);
      const response = await get(context, settings, url, context.signal);
      const status = response.statusCode ?? 0;
      if (status < 200 || status > 299) {
        // The body of a refusal is not read: its status is all that is taken from it. A
        // redirect is a refusal too, since nothing follows it.
        response.destroy();
        throw connectionCallError(
          reasonOfStatus(status),
          undefined,
          retryAfterSeconds(response.headers["retry-after"])
        );
      }
      const result = resultOf(await bodyOf(response, HTTP_API_RESULT_MAX_BYTES, context.signal));
      if (holdsCredential(result, context.credentialFor(context.target))) {
        throw connectionCallError("output_rejected");
      }
      return result;
    }
  };
}
