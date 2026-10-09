import type { createClientInstanceApp as createUnseededClientInstanceApp } from "@vivd-catalyst/client-assembly";
import {
  asClientInstanceId,
  asConversationId,
  isJsonObject,
  unknownToJsonValue,
  type AuthenticatedUser,
  type ConversationStore,
  type JsonObject,
  type Logger
} from "@vivd-catalyst/core";
import {
  parseClientInstanceConfig,
  type UsageSafeguardsConfig
} from "@vivd-catalyst/config-schema";

type LocalizedTestString =
  | string
  | {
      en?: string;
      de?: string;
    };

/** A job under test must not log an error; the logged error fails the test. */
export function createFailingTestLogger(message: string): Logger {
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error(input) {
      throw input instanceof Error ? input : new Error(message);
    },
    child: () => logger
  };
  return logger;
}

export function createTestUser(
  id: string,
  clientInstanceId: ReturnType<typeof asClientInstanceId>
): AuthenticatedUser {
  return {
    id,
    externalUserId: id,
    displayLabel: id === "user-1" ? "User" : "Other user",
    roles: ["user", "admin", "superadmin"],
    permissionRefs: ["demo-tools"],
    clientInstanceId,
    authSource: "test",
    scopes: ["*"]
  };
}

export function createTestConfig(
  input: {
    toolNames?: string[];
    tools?: Array<{ name: string; enabled?: boolean }>;
    displayName?: LocalizedTestString;
    welcomeMessage?: LocalizedTestString;
    initialPrompts?: Array<{ title: LocalizedTestString; prompt: LocalizedTestString }>;
    modelProviders?: Array<
      | { id: string; type: "deterministic"; model: string }
      | {
          id: string;
          type: "openai-compatible";
          model: string;
          baseUrl: string;
          apiKeyEnvName: string;
        }
    >;
    modelBindings?: Array<{
      id: string;
      providerId: string;
      model?: string;
      reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
      agentSelectable?: boolean;
      userSelectable?: boolean;
      userSelectableReasoningEfforts?: Array<"none" | "low" | "medium" | "high" | "xhigh">;
    }>;
    agentModelBindingId?: string;
    agentUserSelectableModelBindingIds?: string[];
    usageBudget?: {
      monthlySpendLimit?: number;
    };
    usageSafeguards?: UsageSafeguardsConfig;
    executionWorkspaces?: unknown;
    usagePricing?: {
      currency: string;
      models: Array<{
        providerId: string;
        model: string;
        inputPricePerMillionTokens: number;
        outputPricePerMillionTokens: number;
      }>;
      webSearch?: Array<{
        providerId: string;
        model?: string;
        pricePerCall: number;
      }>;
    };
    webAccess?: unknown;
    developmentAuth?: unknown;
    sessionToken?: unknown;
  } = {}
) {
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: "demo-local",
      displayName: "Demo",
      environment: "development"
    },
    auth: {
      development: input.developmentAuth ?? {
        enabled: true,
        user: {
          id: "user-1",
          externalUserId: "user-1",
          displayLabel: "User",
          roles: ["user", "admin", "superadmin"],
          permissionRefs: ["demo-tools"]
        }
      },
      ...(input.sessionToken ? { sessionToken: input.sessionToken } : {})
    },
    modelProviders: input.modelProviders ?? [
      { id: "local", type: "deterministic", model: "local" }
    ],
    modelBindings: input.modelBindings,
    usage: {
      budget: input.usageBudget ?? {},
      safeguards: input.usageSafeguards ?? {},
      costs: input.usagePricing
        ? {
            customer: {
              id: "test-customer",
              version: "1",
              currency: input.usagePricing.currency,
              models: input.usagePricing.models.map((price) => ({
                providerId: price.providerId,
                model: price.model,
                uncachedInputPricePerMillionTokens: price.inputPricePerMillionTokens,
                cachedInputPricePerMillionTokens: price.inputPricePerMillionTokens,
                outputPricePerMillionTokens: price.outputPricePerMillionTokens
              })),
              webSearch: input.usagePricing.webSearch ?? []
            }
          }
        : {}
    },
    ...(input.webAccess ? { webAccess: input.webAccess } : {}),
    ...(input.executionWorkspaces ? { executionWorkspaces: input.executionWorkspaces } : {}),
    tools: input.tools ?? []
  });
  testAssetsByConfig.set(config, {
    defaultAgentName: "test_agent",
    agent: toJsonObject({
      name: "test_agent",
      displayName: input.displayName ?? "Test Agent",
      ...(input.welcomeMessage ? { welcomeMessage: input.welcomeMessage } : {}),
      instructions: "Use configured tools only.",
      ...(input.agentModelBindingId
        ? { modelBindingId: input.agentModelBindingId }
        : { modelProviderId: input.modelProviders?.[0]?.id ?? "local" }),
      ...(input.agentUserSelectableModelBindingIds
        ? { userSelectableModelBindingIds: input.agentUserSelectableModelBindingIds }
        : {}),
      toolNames: input.toolNames ?? [],
      initialPrompts: input.initialPrompts ?? []
    })
  });
  return config;
}

const testAssetsByConfig = new WeakMap<object, { defaultAgentName: string; agent: JsonObject }>();

export async function seedTestAssets(
  app: Awaited<ReturnType<typeof createUnseededClientInstanceApp>>
): Promise<void> {
  const assets = testAssetsByConfig.get(app.config);
  if (!assets) return;
  await app.store.configAssets.applyConfigAssetMutations({
    clientInstanceId: asClientInstanceId(app.config.clientInstance.id),
    mutations: [
      { type: "upsert", kind: "agent", name: assets.defaultAgentName, config: assets.agent },
      { type: "setDefaultAgent", agentName: assets.defaultAgentName }
    ]
  });
}

function toJsonObject(input: object): JsonObject {
  const value = unknownToJsonValue(input);
  if (!isJsonObject(value)) {
    throw new Error("Expected JSON object fixture");
  }
  return value;
}

/**
 * Appends a first message, because viewer listings leave out a Conversation without messages.
 */
export async function seedConversationMessage(
  store: Pick<ConversationStore, "appendMessage">,
  conversationId: string,
  clientInstanceId = "demo-local"
): Promise<void> {
  await store.appendMessage({
    clientInstanceId: asClientInstanceId(clientInstanceId),
    conversationId: asConversationId(conversationId),
    role: "user",
    text: "First message"
  });
}

type TestServer = {
  call(
    operation: "workspaces.list" | "workspaces.ensure_personal",
    input: { headers: Record<string, string> }
  ): Promise<{ statusCode: number; json<T>(): T }>;
};

export async function personalConversationListInput(
  server: TestServer,
  headers: Record<string, string> = {}
): Promise<import("./operations").TestCallInput> {
  const initialized = await server.call("workspaces.ensure_personal", { headers });
  if (initialized.statusCode !== 200)
    throw new Error(`Could not initialize Personal Workspace: ${initialized.statusCode}`);
  const response = await server.call("workspaces.list", { headers });
  if (response.statusCode !== 200) {
    throw new Error(`Could not resolve Personal Workspace: ${response.statusCode}`);
  }
  const personal = response
    .json<{ items: Array<{ id: string; kind: string }> }>()
    .items.find((workspace) => workspace.kind === "personal");
  if (!personal) throw new Error("Personal Workspace is not available");
  return { query: { collaborationWorkspaceId: personal.id }, headers };
}

export function setTestAgent(config: object, agent: JsonObject): void {
  testAssetsByConfig.set(config, { defaultAgentName: String(agent.name), agent });
}
