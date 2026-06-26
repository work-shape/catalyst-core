import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AppError,
  type AuthenticatedUser,
  type ConversationId,
  type LocaleCode,
  type RuntimeCallContext,
  asConversationId,
  authContextFromUser,
  createPlatformId,
  normalizeAuthenticatedUser
} from "@vivd-catalyst/core";
import { resolveConfigLocale } from "@vivd-catalyst/config-schema";
import type { ChatServerOptions } from "./types";

export async function authenticateRequest(
  options: ChatServerOptions,
  request: FastifyRequest
): Promise<{ user: AuthenticatedUser; context: RuntimeCallContext }> {
  const correlationId = createCorrelationId(request);
  const user = normalizeAuthenticatedUser(await options.authAdapter.authenticate({
    headers: request.headers,
    clientInstanceId: options.clientInstanceId,
    correlationId
  }));

  return {
    user,
    context: {
      user,
      clientInstanceId: options.clientInstanceId,
      correlationId,
      ...authContextFromUser(user)
    }
  };
}

export function getConversationId(request: FastifyRequest): ConversationId {
  const params = request.params as { conversationId?: string };
  if (!params.conversationId) {
    throw new AppError("BAD_REQUEST", "Missing conversation id");
  }
  return asConversationId(params.conversationId);
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Request body is invalid", {
      issues: parsed.error.issues
    });
  }
  return parsed.data;
}

export function resolveRequestLocale(
  options: ChatServerOptions,
  request: FastifyRequest,
  requestedLocale?: string
): LocaleCode {
  const query = request.query as { locale?: string } | undefined;
  return resolveConfigLocale(options.config.localization, {
    requestedLocale: requestedLocale ?? query?.locale,
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

export function createCorrelationId(request: FastifyRequest): string {
  const existing = request.headers["x-correlation-id"];
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }
  return createPlatformId("corr");
}
