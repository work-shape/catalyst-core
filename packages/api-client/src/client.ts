import type { z } from "zod";
import { ApiError } from "./errors";
import { createClient as createGeneratedClient } from "./generated/client";
import * as generatedSdk from "./generated/sdk.gen";
import { apiOperations } from "./schemas";
import type { LocaleCode } from "./schemas";

export interface ApiClientOptions {
  baseUrl: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  fetchImpl?: typeof fetch;
}

type OperationRequestInput<Operation> = Operation extends {
  requestSchema: z.ZodType<infer Request>;
}
  ? Request
  : never;

type GeneratedResult<T> =
  | {
      data: T;
      error: undefined;
      request?: Request;
      response?: Response;
    }
  | {
      data: undefined;
      error: unknown;
      request?: Request;
      response?: Response;
    };

export function createApiClient(options: ApiClientOptions) {
  const generatedClient = createGeneratedClient({
    baseUrl: options.baseUrl.replace(/\/$/u, ""),
    credentials: "include",
    fetch: options.fetchImpl
  });

  generatedClient.interceptors.request.use(async (request) => {
    const token = await options.getToken?.();
    if (token) {
      request.headers.set("authorization", `Bearer ${token}`);
    }
    return request;
  });

  async function unwrapJson<T>(
    result: Promise<GeneratedResult<unknown>>,
    schema: z.ZodType<T>
  ): Promise<T> {
    const payload = await result;
    if (payload.error !== undefined) {
      throw apiErrorFromGeneratedResult(payload);
    }
    return schema.parse(payload.data);
  }

  async function unwrapBlob(result: Promise<GeneratedResult<Blob | File>>): Promise<Blob> {
    const payload = await result;
    if (payload.error !== undefined) {
      throw apiErrorFromGeneratedResult(payload);
    }
    if (!payload.data) {
      throw new ApiError(payload.response?.status ?? 0, "API request failed", payload.data);
    }
    return payload.data;
  }

  return {
    me: () =>
      unwrapJson(
        generatedSdk.getCurrentUser({ client: generatedClient }),
        apiOperations.getCurrentUser.responseSchema
      ),
    updateMe: (input: OperationRequestInput<typeof apiOperations.updateCurrentUser>) =>
      unwrapJson(
        generatedSdk.updateCurrentUser({
          client: generatedClient,
          body: apiOperations.updateCurrentUser.requestSchema.parse(input)
        }),
        apiOperations.updateCurrentUser.responseSchema
      ),
    changeMyPassword: (
      input: OperationRequestInput<typeof apiOperations.changeCurrentUserPassword>
    ) =>
      unwrapJson(
        generatedSdk.changeCurrentUserPassword({
          client: generatedClient,
          body: apiOperations.changeCurrentUserPassword.requestSchema.parse(input)
        }),
        apiOperations.changeCurrentUserPassword.responseSchema
      ),
    branding: (locale?: LocaleCode) =>
      unwrapJson(
        generatedSdk.getBranding({
          client: generatedClient,
          query: { locale }
        }),
        apiOperations.getBranding.responseSchema
      ),
    config: (locale?: LocaleCode) =>
      unwrapJson(
        generatedSdk.getConfig({
          client: generatedClient,
          query: { locale }
        }),
        apiOperations.getConfig.responseSchema
      ),
    conversations: () =>
      unwrapJson(
        generatedSdk.listConversations({ client: generatedClient }),
        apiOperations.listConversations.responseSchema
      ),
    createConversation: (
      input: OperationRequestInput<typeof apiOperations.createConversation> = {}
    ) =>
      unwrapJson(
        generatedSdk.createConversation({
          client: generatedClient,
          body: apiOperations.createConversation.requestSchema.parse(input)
        }),
        apiOperations.createConversation.responseSchema
      ),
    generateConversationTitle: (conversationId: string) =>
      unwrapJson(
        generatedSdk.generateConversationTitle({
          client: generatedClient,
          path: { conversationId }
        }),
        apiOperations.generateConversationTitle.responseSchema
      ),
    messages: (conversationId: string) =>
      unwrapJson(
        generatedSdk.listConversationMessages({
          client: generatedClient,
          path: { conversationId }
        }),
        apiOperations.listConversationMessages.responseSchema
      ),
    draftAttachments: (conversationId: string) =>
      unwrapJson(
        generatedSdk.listDraftAttachments({
          client: generatedClient,
          path: { conversationId }
        }),
        apiOperations.listDraftAttachments.responseSchema
      ),
    uploadDraftAttachment: (conversationId: string, file: File) =>
      unwrapJson(
        generatedSdk.uploadDraftAttachment({
          client: generatedClient,
          path: { conversationId },
          body: { file }
        }),
        apiOperations.uploadDraftAttachment.responseSchema
      ),
    retryDraftAttachment: (conversationId: string, attachmentId: string) =>
      unwrapJson(
        generatedSdk.retryDraftAttachment({
          client: generatedClient,
          path: { conversationId, attachmentId }
        }),
        apiOperations.retryDraftAttachment.responseSchema
      ),
    deleteDraftAttachment: (conversationId: string, attachmentId: string) =>
      unwrapJson(
        generatedSdk.deleteDraftAttachment({
          client: generatedClient,
          path: { conversationId, attachmentId }
        }),
        apiOperations.deleteDraftAttachment.responseSchema
      ),
    conversationFileContent: (conversationId: string, fileId: string) =>
      unwrapBlob(
        generatedSdk.getConversationFileContent({
          client: generatedClient,
          path: { conversationId, fileId }
        })
      ),
    deleteConversation: (conversationId: string) =>
      unwrapJson(
        generatedSdk.deleteConversation({
          client: generatedClient,
          path: { conversationId }
        }),
        apiOperations.deleteConversation.responseSchema
      ),
    auditEvents: () =>
      unwrapJson(
        generatedSdk.listAuditEvents({ client: generatedClient }),
        apiOperations.listAuditEvents.responseSchema
      ),
    usageSummary: () =>
      unwrapJson(
        generatedSdk.getUsageSummary({ client: generatedClient }),
        apiOperations.getUsageSummary.responseSchema
      ),
    users: () =>
      unwrapJson(
        generatedSdk.listAdministeredUsers({ client: generatedClient }),
        apiOperations.listAdministeredUsers.responseSchema
      ),
    createUser: (input: OperationRequestInput<typeof apiOperations.createAdministeredUser>) =>
      unwrapJson(
        generatedSdk.createAdministeredUser({
          client: generatedClient,
          body: apiOperations.createAdministeredUser.requestSchema.parse(input)
        }),
        apiOperations.createAdministeredUser.responseSchema
      ),
    updateUser: (
      userId: string,
      input: OperationRequestInput<typeof apiOperations.updateAdministeredUser>
    ) =>
      unwrapJson(
        generatedSdk.updateAdministeredUser({
          client: generatedClient,
          path: { userId },
          body: apiOperations.updateAdministeredUser.requestSchema.parse(input)
        }),
        apiOperations.updateAdministeredUser.responseSchema
      ),
    upsertUserIdentity: (
      userId: string,
      input: OperationRequestInput<typeof apiOperations.upsertAdministeredUserIdentity>
    ) =>
      unwrapJson(
        generatedSdk.upsertAdministeredUserIdentity({
          client: generatedClient,
          path: { userId },
          body: apiOperations.upsertAdministeredUserIdentity.requestSchema.parse(input)
        }),
        apiOperations.upsertAdministeredUserIdentity.responseSchema
      ),
    resetUserPassword: (
      userId: string,
      input: OperationRequestInput<typeof apiOperations.resetAdministeredUserPassword>
    ) =>
      unwrapJson(
        generatedSdk.resetAdministeredUserPassword({
          client: generatedClient,
          path: { userId },
          body: apiOperations.resetAdministeredUserPassword.requestSchema.parse(input)
        }),
        apiOperations.resetAdministeredUserPassword.responseSchema
      ),
    deleteUserIdentity: (userId: string, authSource: string, externalUserId: string) =>
      unwrapJson(
        generatedSdk.deleteAdministeredUserIdentity({
          client: generatedClient,
          path: { userId, authSource, externalUserId }
        }),
        apiOperations.deleteAdministeredUserIdentity.responseSchema
      )
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function apiErrorFromGeneratedResult(result: {
  error: unknown;
  response?: Response;
}): ApiError {
  const payload = result.error;
  const status = result.response?.status ?? 0;
  return new ApiError(status, apiErrorMessage(payload), payload);
}

function apiErrorMessage(payload: unknown): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return "API request failed";
}
