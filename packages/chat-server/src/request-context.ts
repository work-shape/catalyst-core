import type { FastifyRequest } from "fastify";
import {
  AppError,
  type ConversationId,
  type LocaleCode,
  type RuntimeCallContext,
  asConversationId,
  authContextFromUser
} from "@vivd-catalyst/core";
import { resolveConfigLocale } from "@vivd-catalyst/config-schema";
import type { ChatServerOptions } from "./types";

/** An empty path segment still matches a route, so a handler names what is missing. */
export function requirePathParam(value: string, missingMessage: string): string {
  if (!value) {
    throw new AppError("BAD_REQUEST", missingMessage);
  }
  return value;
}

export function conversationIdParam(params: { conversationId: string }): ConversationId {
  return asConversationId(requirePathParam(params.conversationId, "Missing conversation id"));
}

export function resolveRequestLocale(
  options: ChatServerOptions,
  request: FastifyRequest,
  requestedLocale?: string
): LocaleCode {
  return resolveConfigLocale(options.config.localization, {
    requestedLocale: requestedLocale ?? queryLocale(request.query),
    acceptLanguageHeader: request.headers["accept-language"]
  });
}

export function withRequestLocale(
  context: RuntimeCallContext,
  options: ChatServerOptions,
  request: FastifyRequest,
  requestedLocale?: string
): RuntimeCallContext {
  return {
    ...context,
    ...authContextFromUser(context.user),
    locale: resolveRequestLocale(options, request, requestedLocale)
  };
}

// Read from the raw query because run and conversation routes honour `locale` without
// declaring it.
function queryLocale(query: unknown): string | undefined {
  if (typeof query !== "object" || query === null || !("locale" in query)) {
    return undefined;
  }
  return typeof query.locale === "string" ? query.locale : undefined;
}
