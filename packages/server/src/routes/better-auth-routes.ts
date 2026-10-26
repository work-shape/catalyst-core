import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  hasExplicitCredentials,
  STANDALONE_AUTH_CLIENT_ADDRESS_HEADER,
  STANDALONE_AUTH_SOURCE,
  type StandaloneTwoFactorEvent
} from "@work-shape/catalyst-auth";
import { AppError, createPlatformId, type AuditActor } from "@work-shape/catalyst-core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { accountTried, requireWithinLimit } from "../http/rate-limit";
import type { ResolvedChatServerOptions } from "../types";

// The library's routes are counted in two groups, not one counter for every route.
const SIGN_IN_ROUTES = { id: "auth.sign-in", rateClass: "auth" } as const;
const SESSION_ROUTES = { id: "auth.session", rateClass: "read" } as const;

export function registerBetterAuthRoutes(
  app: FastifyInstance,
  options: Pick<
    ResolvedChatServerOptions,
    | "standaloneAuth"
    | "rateLimiter"
    | "config"
    | "auditRecorder"
    | "stores"
    | "clientInstanceId"
    | "logger"
  >
): void {
  const standaloneAuth = options.standaloneAuth;
  if (!standaloneAuth) {
    return;
  }

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (request, reply) => {
      // Counted here, before the library sees the call, so that attempts sent side by side
      // are refused before any of them has a password checked. A path the library does not
      // serve is not counted at all.
      // The one URL that is classified here and handed to the library below, so both read the
      // same path however the caller spelled it.
      const url = toAuthRequestUrl(request.url, standaloneAuth.baseUrl);
      const kind = standaloneAuth.routeKind(url.pathname);
      if (kind === "credential") {
        await requireWithinLimit(options, SIGN_IN_ROUTES, { address: request.ip }, reply);
        const account = accountTried(request.body);
        if (account !== undefined) {
          await requireWithinLimit(
            options,
            SIGN_IN_ROUTES,
            { address: request.ip, account },
            reply
          );
        }
      } else if (kind === "other") {
        await requireWithinLimit(options, SESSION_ROUTES, { address: request.ip }, reply);
      }
      if (hasExplicitCredentials(request.headers)) {
        throw new AppError(
          "UNAUTHENTICATED",
          "Standalone auth endpoints do not accept explicit credential headers"
        );
      }
      const correlationId = createPlatformId("corr");
      const response = await standaloneAuth.handleRequest(
        new Request(url, {
          method: request.method,
          headers: toRequestHeaders(request.headers, request.ip),
          body: request.method === "GET" ? undefined : toRequestBody(request.body)
        }),
        { twoFactor: (event) => recordTwoFactorEvent(options, event, correlationId) }
      );
      return sendWebResponse(reply, response);
    }
  });
}

const TWO_FACTOR_AUDIT_TYPES = {
  enabled: "user.two_factor_enabled",
  disabled: "user.two_factor_disabled",
  backup_codes_regenerated: "user.two_factor_backup_codes_regenerated",
  backup_code_used: "user.two_factor_backup_code_used",
  locked: "user.two_factor_locked"
} as const satisfies Record<StandaloneTwoFactorEvent["type"], string>;

/**
 * TWO-FACTOR-1: the audit of a person's own two-factor changes. The row names the event, the
 * person and, for a used backup code, how many are left; never a secret, a code or a key URI.
 * A failed write is logged and does not undo what the library has done.
 */
async function recordTwoFactorEvent(
  options: Pick<
    ResolvedChatServerOptions,
    "auditRecorder" | "stores" | "clientInstanceId" | "logger"
  >,
  event: StandaloneTwoFactorEvent,
  correlationId: string
): Promise<void> {
  try {
    const user = await options.stores.users.findUserByIdentity({
      clientInstanceId: options.clientInstanceId,
      authSource: STANDALONE_AUTH_SOURCE,
      externalUserId: event.authUserId
    });
    const actor: AuditActor = user
      ? {
          userId: user.id,
          externalUserId: event.authUserId,
          displayLabel: user.displayLabel,
          roles: user.roles,
          principalKind: "user",
          principalId: user.id,
          principalDisplayLabel: user.displayLabel,
          subjectUserId: user.id
        }
      : { externalUserId: event.authUserId, displayLabel: event.authUserId, roles: [] };
    await options.auditRecorder.record({
      type: TWO_FACTOR_AUDIT_TYPES[event.type],
      status: event.type === "locked" ? "denied" : "success",
      actor,
      ...(user ? { subject: user.id } : {}),
      correlationId,
      metadata: {
        authSource: STANDALONE_AUTH_SOURCE,
        ...(event.backupCodesLeft === undefined ? {} : { backupCodesLeft: event.backupCodesLeft })
      }
    });
  } catch (error) {
    options.logger.error(
      { eventType: event.type, error: error instanceof Error ? error.message : String(error) },
      "Two-factor audit event could not be recorded"
    );
  }
}

export function sendWebResponse(reply: FastifyReply, response: Response): FastifyReply {
  reply.status(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") {
      reply.header(key, value);
    }
  });

  const setCookies = getSetCookieHeaders(response.headers);
  if (setCookies.length > 0) {
    reply.header("set-cookie", setCookies);
  }

  if (!response.body) {
    return reply.send();
  }

  return reply.send(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>));
}

/**
 * The call's URL in one spelling: dot segments resolved and repeated slashes joined. A path
 * that still holds an escaped character is not one of the library's, so it is not served.
 */
function toAuthRequestUrl(requestUrl: string, baseUrl: string): URL {
  // A leading "//" would be read as another host.
  const url = new URL(requestUrl.replace(/^\/+/u, "/"), new URL(baseUrl).origin);
  url.pathname = url.pathname.replaceAll(/\/{2,}/gu, "/");
  if (url.pathname.includes("%")) {
    throw new AppError("NOT_FOUND", "Operation is not available");
  }
  return url;
}

/**
 * The sign-in library reads the client address from the one header set here, so a caller
 * cannot choose the address a session is recorded under.
 */
function toRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
  clientAddress: string
): Headers {
  const requestHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        requestHeaders.append(key, item);
      }
      continue;
    }
    if (value !== undefined) {
      requestHeaders.set(key, value);
    }
  }
  requestHeaders.set(STANDALONE_AUTH_CLIENT_ADDRESS_HEADER, clientAddress);
  return requestHeaders;
}

function toRequestBody(body: unknown): BodyInit | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string" || body instanceof URLSearchParams || body instanceof FormData) {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return new Uint8Array(body);
  }
  return JSON.stringify(body);
}

function getSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers);
  }
  const header = headers.get("set-cookie");
  return header ? [header] : [];
}
