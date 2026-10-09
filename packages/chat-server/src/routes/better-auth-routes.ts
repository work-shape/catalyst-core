import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { hasExplicitCredentials, STANDALONE_AUTH_CLIENT_ADDRESS_HEADER } from "@vivd-catalyst/auth";
import { AppError } from "@vivd-catalyst/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ChatServerOptions } from "../types";

export function registerBetterAuthRoutes(
  app: FastifyInstance,
  options: Pick<ChatServerOptions, "standaloneAuth">
): void {
  const standaloneAuth = options.standaloneAuth;
  if (!standaloneAuth) {
    return;
  }

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (request, reply) => {
      if (hasExplicitCredentials(request.headers)) {
        throw new AppError(
          "UNAUTHENTICATED",
          "Standalone auth endpoints do not accept explicit credential headers"
        );
      }
      const response = await standaloneAuth.handleRequest(
        new Request(toAuthRequestUrl(request.url, standaloneAuth.baseUrl), {
          method: request.method,
          headers: toRequestHeaders(request.headers, request.ip),
          body: request.method === "GET" ? undefined : toRequestBody(request.body)
        })
      );
      return sendWebResponse(reply, response);
    }
  });
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

function toAuthRequestUrl(requestUrl: string, baseUrl: string): string {
  const origin = new URL(baseUrl).origin;
  return new URL(requestUrl, origin).toString();
}

/**
 * The sign-in library limits its own routes per client address. It reads that address from
 * the one header set here, so a caller cannot choose the address it is counted under.
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
