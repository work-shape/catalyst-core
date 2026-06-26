import type { z } from "zod";
import { ApiError } from "./errors";
import { createClient as createGeneratedClient } from "./generated/client";
import * as generatedSdk from "./generated/sdk.gen";
import { apiOperations, runObservationSchema } from "./schemas";
import type { LocaleCode, RunObservation } from "./schemas";

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
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const generatedClient = createGeneratedClient({
    baseUrl,
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

  async function requestJson<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {}
  ): Promise<T> {
    const response = await request(path, init);
    const payload = await readJsonPayload(response);
    if (!response.ok) {
      throw new ApiError(response.status, apiErrorMessage(payload), payload);
    }
    return schema.parse(payload);
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const token = await options.getToken?.();
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return (options.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers
    });
  }

  async function* observeRunEvents(
    conversationId: string,
    runId: string,
    observeOptions: { afterSequence?: number; signal?: AbortSignal } = {}
  ): AsyncIterable<RunObservation> {
    const path = apiOperations.observeConversationRun.buildPath({
      params: { conversationId, runId },
      query: { after: observeOptions.afterSequence }
    });
    const response = await request(path, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        ...(observeOptions.afterSequence === undefined
          ? {}
          : { "last-event-id": String(observeOptions.afterSequence) })
      },
      signal: observeOptions.signal
    });
    if (response.status === 204) {
      return;
    }
    if (!response.ok) {
      const payload = await readJsonPayload(response);
      throw new ApiError(response.status, apiErrorMessage(payload), payload);
    }
    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const events = splitCompleteSseEvents(buffer);
        buffer = events.remaining;
        for (const event of events.blocks) {
          const observation = parseRunObservationSseBlock(event);
          if (observation) {
            yield observation;
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const observation = parseRunObservationSseBlock(buffer);
        if (observation) {
          yield observation;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  const listConversations = () =>
    unwrapJson(
      generatedSdk.listConversations({ client: generatedClient }),
      apiOperations.listConversations.responseSchema
    );

  const createConversation = (
    input: OperationRequestInput<typeof apiOperations.createConversation> = {}
  ) =>
    unwrapJson(
      generatedSdk.createConversation({
        client: generatedClient,
        body: apiOperations.createConversation.requestSchema.parse(input)
      }),
      apiOperations.createConversation.responseSchema
    );

  const getConversationThread = (conversationId: string) =>
    requestJson(
      apiOperations.getConversationThread.buildPath({ params: { conversationId } }),
      apiOperations.getConversationThread.responseSchema
    );

  const listConversationMessages = (conversationId: string) =>
    unwrapJson(
      generatedSdk.listConversationMessages({
        client: generatedClient,
        path: { conversationId }
      }),
      apiOperations.listConversationMessages.responseSchema
    );

  const startConversationRun = (
    conversationId: string,
    input: OperationRequestInput<typeof apiOperations.startConversationRun>
  ) =>
    requestJson(
      apiOperations.startConversationRun.buildPath({ params: { conversationId } }),
      apiOperations.startConversationRun.responseSchema,
      {
        method: "POST",
        body: JSON.stringify(apiOperations.startConversationRun.requestSchema.parse(input))
      }
    );

  const createConversationRun = (
    input: OperationRequestInput<typeof apiOperations.createConversationRun>
  ) =>
    requestJson(
      apiOperations.createConversationRun.buildPath(),
      apiOperations.createConversationRun.responseSchema,
      {
        method: "POST",
        body: JSON.stringify(apiOperations.createConversationRun.requestSchema.parse(input))
      }
    );

  const cancelRun = (
    conversationId: string,
    runId: string,
    input: OperationRequestInput<typeof apiOperations.cancelConversationRun> = {}
  ) =>
    requestJson(
      apiOperations.cancelConversationRun.buildPath({ params: { conversationId, runId } }),
      apiOperations.cancelConversationRun.responseSchema,
      {
        method: "POST",
        body: JSON.stringify(apiOperations.cancelConversationRun.requestSchema.parse(input))
      }
    );

  const commandRun = (
    conversationId: string,
    runId: string,
    input: OperationRequestInput<typeof apiOperations.commandConversationRun>
  ) =>
    requestJson(
      apiOperations.commandConversationRun.buildPath({ params: { conversationId, runId } }),
      apiOperations.commandConversationRun.responseSchema,
      {
        method: "POST",
        body: JSON.stringify(apiOperations.commandConversationRun.requestSchema.parse(input))
      }
    );

  const conversations = Object.assign(listConversations, {
    list: listConversations,
    create: createConversation,
    getThread: getConversationThread,
    messages: listConversationMessages,
    startRun: startConversationRun,
    createAndStartRun: createConversationRun
  });

  const runs = {
    observe: observeRunEvents,
    cancel: cancelRun,
    command: commandRun
  };

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
    conversations,
    createConversation,
    generateConversationTitle: (conversationId: string) =>
      unwrapJson(
        generatedSdk.generateConversationTitle({
          client: generatedClient,
          path: { conversationId }
        }),
        apiOperations.generateConversationTitle.responseSchema
      ),
    thread: getConversationThread,
    messages: listConversationMessages,
    runs,
    startConversationRun,
    createConversationRun,
    cancelRun,
    commandRun,
    observeRunEvents,
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

async function readJsonPayload(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function splitCompleteSseEvents(buffer: string): { blocks: string[]; remaining: string } {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const parts = normalized.split("\n\n");
  const remaining = parts.pop() ?? "";
  return {
    blocks: parts.filter((part) => part.trim().length > 0),
    remaining
  };
}

function parseRunObservationSseBlock(block: string): RunObservation | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) {
    return undefined;
  }
  return runObservationSchema.parse(JSON.parse(data));
}

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
