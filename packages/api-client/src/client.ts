import type { z } from "zod";
import {
  apiOperations,
  runObservationSchema,
  type ConfigAssetKind,
  type LocaleCode,
  type RunObservation
} from "@vivd-catalyst/api-contract";
import { ApiError } from "./errors";
import { createClient as createGeneratedClient } from "./generated/client";
import * as generatedSdk from "./generated/sdk.gen";

export interface ApiClientOptions {
  baseUrl: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  browserManagedDownloads?: boolean;
}

export interface ObserveRunEventsOptions {
  afterSequence?: number;
  signal?: AbortSignal;
  onCaughtUp?: () => void;
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
  const browserManagedDownloads = options.browserManagedDownloads ?? !options.getToken;
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

  function buildUrl(path: string): string {
    return `${baseUrl}${path}`;
  }

  function conversationArtifactContentPath(conversationId: string, artifactId: string): string {
    return apiOperations.getConversationArtifactContent.buildPath({
      params: { conversationId, artifactId }
    });
  }

  async function* observeRunEvents(
    conversationId: string,
    runId: string,
    observeOptions: ObserveRunEventsOptions = {}
  ): AsyncIterable<RunObservation> {
    const result = await generatedClient.get<ReadableStream<Uint8Array>, unknown>({
      url: "/api/conversations/{conversationId}/runs/{runId}/events",
      path: { conversationId, runId },
      query:
        observeOptions.afterSequence === undefined
          ? undefined
          : { after: String(observeOptions.afterSequence) },
      headers: {
        accept: "text/event-stream"
      },
      parseAs: "stream",
      signal: observeOptions.signal
    });
    const response = result.response;
    if (!response) {
      if (result.error instanceof Error && result.error.name === "AbortError") {
        throw result.error;
      }
      throw apiErrorFromGeneratedResult(result);
    }
    if (response.status === 204) {
      observeOptions.onCaughtUp?.();
      return;
    }
    if (result.error !== undefined) {
      throw apiErrorFromGeneratedResult(result);
    }
    const body = result.data;
    if (!body) {
      return;
    }

    const reader = body.getReader();
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
    unwrapJson(
      generatedSdk.getConversationThread({
        client: generatedClient,
        path: { conversationId }
      }),
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

  const conversationResources = (conversationId: string) =>
    unwrapJson(
      generatedSdk.listConversationResources({
        client: generatedClient,
        path: { conversationId }
      }),
      apiOperations.listConversationResources.responseSchema
    );

  const structuredDataResource = (
    conversationId: string,
    structuredDataResourceId: string
  ) =>
    unwrapJson(
      generatedSdk.getStructuredDataResource({
        client: generatedClient,
        path: { conversationId, structuredDataResourceId }
      }),
      apiOperations.getStructuredDataResource.responseSchema
    );

  const startConversationRun = (
    conversationId: string,
    input: OperationRequestInput<typeof apiOperations.startConversationRun>
  ) =>
    unwrapJson(
      generatedSdk.startConversationRun({
        client: generatedClient,
        path: { conversationId },
        body: apiOperations.startConversationRun.requestSchema.parse(input)
      }),
      apiOperations.startConversationRun.responseSchema
    );

  const createConversationRun = (
    input: OperationRequestInput<typeof apiOperations.createConversationRun>
  ) =>
    unwrapJson(
      generatedSdk.createConversationRun({
        client: generatedClient,
        body: apiOperations.createConversationRun.requestSchema.parse(input)
      }),
      apiOperations.createConversationRun.responseSchema
    );

  const cancelRun = (
    conversationId: string,
    runId: string,
    input: OperationRequestInput<typeof apiOperations.cancelConversationRun> = {}
  ) =>
    unwrapJson(
      generatedSdk.cancelConversationRun({
        client: generatedClient,
        path: { conversationId, runId },
        body: apiOperations.cancelConversationRun.requestSchema.parse(input)
      }),
      apiOperations.cancelConversationRun.responseSchema
    );

  const commandRun = (
    conversationId: string,
    runId: string,
    input: OperationRequestInput<typeof apiOperations.commandConversationRun>
  ) =>
    unwrapJson(
      generatedSdk.commandConversationRun({
        client: generatedClient,
        path: { conversationId, runId },
        body: apiOperations.commandConversationRun.requestSchema.parse(input)
      }),
      apiOperations.commandConversationRun.responseSchema
    );

  const conversations = {
    list: listConversations,
    create: createConversation,
    getThread: getConversationThread,
    messages: listConversationMessages,
    startRun: startConversationRun,
    createRun: createConversationRun
  };

  const runs = {
    observe: observeRunEvents,
    cancel: cancelRun,
    command: commandRun
  };

  return {
    browserManagedDownloads,
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
    deleteMe: () =>
      unwrapJson(
        generatedSdk.deleteCurrentUser({
          client: generatedClient
        }),
        apiOperations.deleteCurrentUser.responseSchema
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
    generateConversationTitle: (conversationId: string) =>
      unwrapJson(
        generatedSdk.generateConversationTitle({
          client: generatedClient,
          path: { conversationId }
        }),
        apiOperations.generateConversationTitle.responseSchema
      ),
    renameConversation: (conversationId: string, title: string) =>
      unwrapJson(
        generatedSdk.renameConversation({
          client: generatedClient,
          path: { conversationId },
          body: apiOperations.renameConversation.requestSchema.parse({ title })
        }),
        apiOperations.renameConversation.responseSchema
      ),
    conversationResources,
    structuredDataResource,
    runs,
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
    conversationFileContent: (conversationId: string, fileId: string, download = false) =>
      unwrapBlob(
        generatedSdk.getConversationFileContent({
          client: generatedClient,
          path: { conversationId, fileId },
          query: download ? { download: "true" } : {},
          parseAs: "blob"
        })
      ),
    conversationFileContentUrl: (conversationId: string, fileId: string) =>
      buildUrl(
        apiOperations.getConversationFileContent.buildPath({
          params: { conversationId, fileId }
        })
      ),
    conversationArtifactContentUrl: (
      conversationId: string,
      artifactId: string,
      inline = false
    ) => buildUrl(`${conversationArtifactContentPath(conversationId, artifactId)}${inline ? "?inline=true" : ""}`),
    conversationArtifactContent: (conversationId: string, artifactId: string) =>
      unwrapBlob(
        generatedSdk.getConversationArtifactContent({
          client: generatedClient,
          path: { conversationId, artifactId },
          parseAs: "blob"
        })
      ),
    conversationArtifactPreview: (conversationId: string, artifactId: string) =>
      unwrapJson(
        generatedSdk.getConversationArtifactPreview({
          client: generatedClient,
          path: { conversationId, artifactId }
        }),
        apiOperations.getConversationArtifactPreview.responseSchema
      ),
    conversationAttachmentPreview: (conversationId: string, attachmentId: string) =>
      unwrapJson(
        generatedSdk.getConversationAttachmentPreview({
          client: generatedClient,
          path: { conversationId, attachmentId }
        }),
        apiOperations.getConversationAttachmentPreview.responseSchema
      ),
    retryConversationArtifactPreview: (conversationId: string, artifactId: string) =>
      unwrapJson(
        generatedSdk.retryConversationArtifactPreview({
          client: generatedClient,
          path: { conversationId, artifactId }
        }),
        apiOperations.retryConversationArtifactPreview.responseSchema
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
    auditActivities: () =>
      unwrapJson(
        generatedSdk.listAuditActivities({ client: generatedClient }),
        apiOperations.listAuditActivities.responseSchema
      ),
    usageSummary: () =>
      unwrapJson(
        generatedSdk.getUsageSummary({ client: generatedClient }),
        apiOperations.getUsageSummary.responseSchema
      ),
    configAssetsOverview: () =>
      unwrapJson(
        generatedSdk.getConfigAssetsOverview({ client: generatedClient }),
        apiOperations.getConfigAssetsOverview.responseSchema
      ),
    configAsset: (kind: ConfigAssetKind, name: string) =>
      unwrapJson(
        generatedSdk.getConfigAsset({
          client: generatedClient,
          path: { kind, name }
        }),
        apiOperations.getConfigAsset.responseSchema
      ),
    putConfigAsset: (
      kind: ConfigAssetKind,
      name: string,
      input: OperationRequestInput<typeof apiOperations.putConfigAsset>
    ) =>
      unwrapJson(
        generatedSdk.putConfigAsset({
          client: generatedClient,
          path: { kind, name },
          body: apiOperations.putConfigAsset.requestSchema.parse(input)
        }),
        apiOperations.putConfigAsset.responseSchema
      ),
    deleteConfigAsset: (
      kind: ConfigAssetKind,
      name: string,
      input: OperationRequestInput<typeof apiOperations.deleteConfigAsset> = {}
    ) =>
      unwrapJson(
        generatedSdk.deleteConfigAsset({
          client: generatedClient,
          path: { kind, name },
          body: apiOperations.deleteConfigAsset.requestSchema.parse(input)
        }),
        apiOperations.deleteConfigAsset.responseSchema
      ),
    setDefaultConfigAgent: (
      input: OperationRequestInput<typeof apiOperations.setDefaultConfigAgent>
    ) =>
      unwrapJson(
        generatedSdk.setDefaultConfigAgent({
          client: generatedClient,
          body: apiOperations.setDefaultConfigAgent.requestSchema.parse(input)
        }),
        apiOperations.setDefaultConfigAgent.responseSchema
      ),
    configAssetRevisions: (kind: ConfigAssetKind, name: string) =>
      unwrapJson(
        generatedSdk.listConfigAssetRevisions({
          client: generatedClient,
          path: { kind, name }
        }),
        apiOperations.listConfigAssetRevisions.responseSchema
      ),
    revertConfigAsset: (
      kind: ConfigAssetKind,
      name: string,
      input: OperationRequestInput<typeof apiOperations.revertConfigAsset>
    ) =>
      unwrapJson(
        generatedSdk.revertConfigAsset({
          client: generatedClient,
          path: { kind, name },
          body: apiOperations.revertConfigAsset.requestSchema.parse(input)
        }),
        apiOperations.revertConfigAsset.responseSchema
      ),
    exportConfigAssets: () =>
      unwrapJson(
        generatedSdk.exportConfigAssets({ client: generatedClient }),
        apiOperations.exportConfigAssets.responseSchema
      ),
    replaceConfigAssets: (input: OperationRequestInput<typeof apiOperations.replaceConfigAssets>) =>
      unwrapJson(
        generatedSdk.replaceConfigAssets({
          client: generatedClient,
          body: apiOperations.replaceConfigAssets.requestSchema.parse(input)
        }),
        apiOperations.replaceConfigAssets.responseSchema
      ),
    validateConfigAssets: (
      input: OperationRequestInput<typeof apiOperations.validateConfigAssets>
    ) =>
      unwrapJson(
        generatedSdk.validateConfigAssets({
          client: generatedClient,
          body: apiOperations.validateConfigAssets.requestSchema.parse(input)
        }),
        apiOperations.validateConfigAssets.responseSchema
      ),
    servicePrincipals: () =>
      unwrapJson(
        generatedSdk.listServicePrincipals({ client: generatedClient }),
        apiOperations.listServicePrincipals.responseSchema
      ),
    createServicePrincipal: (
      input: OperationRequestInput<typeof apiOperations.createServicePrincipal>
    ) =>
      unwrapJson(
        generatedSdk.createServicePrincipal({
          client: generatedClient,
          body: apiOperations.createServicePrincipal.requestSchema.parse(input)
        }),
        apiOperations.createServicePrincipal.responseSchema
      ),
    updateServicePrincipal: (
      servicePrincipalId: string,
      input: OperationRequestInput<typeof apiOperations.updateServicePrincipal>
    ) =>
      unwrapJson(
        generatedSdk.updateServicePrincipal({
          client: generatedClient,
          path: { servicePrincipalId },
          body: apiOperations.updateServicePrincipal.requestSchema.parse(input)
        }),
        apiOperations.updateServicePrincipal.responseSchema
      ),
    createApiCredential: (
      servicePrincipalId: string,
      input: OperationRequestInput<typeof apiOperations.createApiCredential>
    ) =>
      unwrapJson(
        generatedSdk.createApiCredential({
          client: generatedClient,
          path: { servicePrincipalId },
          body: apiOperations.createApiCredential.requestSchema.parse(input)
        }),
        apiOperations.createApiCredential.responseSchema
      ),
    revokeApiCredential: (credentialId: string) =>
      unwrapJson(
        generatedSdk.revokeApiCredential({
          client: generatedClient,
          path: { credentialId }
        }),
        apiOperations.revokeApiCredential.responseSchema
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
    deleteUser: (userId: string) =>
      unwrapJson(
        generatedSdk.deleteAdministeredUser({
          client: generatedClient,
          path: { userId }
        }),
        apiOperations.deleteAdministeredUser.responseSchema
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
