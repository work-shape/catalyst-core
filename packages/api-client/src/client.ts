import { z } from "zod";
import { ApiError } from "./errors";
import {
  apiUserSchema,
  administeredUserSchema,
  auditEventSchema,
  changeCurrentUserPasswordRequestSchema,
  changeCurrentUserPasswordResponseSchema,
  clientBrandingSchema,
  createAdministeredUserRequestSchema,
  conversationSchema,
  createConversationRequestSchema,
  messageSchema,
  resetAdministeredUserPasswordRequestSchema,
  resetAdministeredUserPasswordResponseSchema,
  safeConfigSchema,
  updateAdministeredUserRequestSchema,
  updateCurrentUserRequestSchema,
  upsertAdministeredUserIdentityRequestSchema,
  usageSummarySchema
} from "./schemas";
import type { LocaleCode } from "./schemas";

export interface ApiClientOptions {
  baseUrl: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  fetchImpl?: typeof fetch;
}

export function createApiClient(options: ApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");

  async function request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown
  ): Promise<T> {
    const token = await options.getToken?.();
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      credentials: "include",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new ApiError(response.status, payload?.error?.message ?? "API request failed", payload);
    }
    return schema.parse(payload);
  }

  return {
    me: () => request("GET", "/api/me", apiUserSchema),
    updateMe: (input: z.infer<typeof updateCurrentUserRequestSchema>) =>
      request("PATCH", "/api/me", apiUserSchema, updateCurrentUserRequestSchema.parse(input)),
    changeMyPassword: (input: z.infer<typeof changeCurrentUserPasswordRequestSchema>) =>
      request(
        "POST",
        "/api/me/password",
        changeCurrentUserPasswordResponseSchema,
        changeCurrentUserPasswordRequestSchema.parse(input)
      ),
    branding: (locale?: LocaleCode) => request("GET", withLocale("/api/branding", locale), clientBrandingSchema),
    config: (locale?: LocaleCode) => request("GET", withLocale("/api/config", locale), safeConfigSchema),
    conversations: () => request("GET", "/api/conversations", z.array(conversationSchema)),
    createConversation: (input: z.infer<typeof createConversationRequestSchema> = {}) =>
      request("POST", "/api/conversations", conversationSchema, createConversationRequestSchema.parse(input)),
    messages: (conversationId: string) =>
      request("GET", `/api/conversations/${encodeURIComponent(conversationId)}/messages`, z.array(messageSchema)),
    deleteConversation: (conversationId: string) =>
      request("DELETE", `/api/conversations/${encodeURIComponent(conversationId)}`, conversationSchema),
    auditEvents: () => request("GET", "/api/audit-events", z.array(auditEventSchema)),
    usageSummary: () => request("GET", "/api/superadmin/usage", usageSummarySchema),
    users: () => request("GET", "/api/superadmin/users", z.array(administeredUserSchema)),
    createUser: (input: z.infer<typeof createAdministeredUserRequestSchema>) =>
      request("POST", "/api/superadmin/users", administeredUserSchema, createAdministeredUserRequestSchema.parse(input)),
    updateUser: (userId: string, input: z.infer<typeof updateAdministeredUserRequestSchema>) =>
      request(
        "PATCH",
        `/api/superadmin/users/${encodeURIComponent(userId)}`,
        administeredUserSchema,
        updateAdministeredUserRequestSchema.parse(input)
      ),
    upsertUserIdentity: (
      userId: string,
      input: z.infer<typeof upsertAdministeredUserIdentityRequestSchema>
    ) =>
      request(
        "PUT",
        `/api/superadmin/users/${encodeURIComponent(userId)}/identities`,
        administeredUserSchema,
        upsertAdministeredUserIdentityRequestSchema.parse(input)
      ),
    resetUserPassword: (userId: string, input: z.infer<typeof resetAdministeredUserPasswordRequestSchema>) =>
      request(
        "POST",
        `/api/superadmin/users/${encodeURIComponent(userId)}/password`,
        resetAdministeredUserPasswordResponseSchema,
        resetAdministeredUserPasswordRequestSchema.parse(input)
      ),
    deleteUserIdentity: (userId: string, authSource: string, externalUserId: string) =>
      request(
        "DELETE",
        `/api/superadmin/users/${encodeURIComponent(userId)}/identities/${encodeURIComponent(authSource)}/${encodeURIComponent(externalUserId)}`,
        administeredUserSchema
      )
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function withLocale(path: string, locale: LocaleCode | undefined): string {
  return locale ? `${path}?locale=${encodeURIComponent(locale)}` : path;
}
