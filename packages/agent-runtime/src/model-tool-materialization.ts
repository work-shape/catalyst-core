import type {
  AgentConfig,
  ModelProviderConfig,
  ToolDescriptor,
  WebAccessConfig
} from "@vivd-catalyst/core";
import {
  OPENAI_WEB_SEARCH_PROVIDER_TOOL_ID,
  WEB_SEARCH_MODEL_TOOL_NAME,
  type ModelProviderNativeTool,
  type ModelTool
} from "@vivd-catalyst/model-provider";

export interface ModelToolRegistryView {
  listDescriptorsForAgent(toolNames: readonly string[]): ToolDescriptor[];
}

export interface ModelToolMaterializationInput {
  agent: AgentConfig;
  modelProvider: ModelProviderConfig;
  toolRegistry: ModelToolRegistryView;
  webAccess?: WebAccessConfig;
}

export function materializeModelTools(input: ModelToolMaterializationInput): ModelTool[] {
  const functionToolNames = input.agent.toolNames.filter(
    (toolName) => toolName !== WEB_SEARCH_MODEL_TOOL_NAME
  );
  const functionTools = input.toolRegistry.listDescriptorsForAgent(functionToolNames).map(
    (tool): ModelTool => ({
      kind: "function",
      name: tool.name,
      description: tool.description,
      inputJsonSchema: tool.inputJsonSchema
    })
  );
  const webSearch = resolveWebSearchModelTool(input);
  return webSearch.kind === "provider" ? [...functionTools, webSearch.tool] : functionTools;
}

export function findModelToolMaterializationIssues(
  input: Omit<ModelToolMaterializationInput, "toolRegistry">
): string[] {
  const webSearch = resolveWebSearchModelTool(input);
  return webSearch.kind === "issue" ? [webSearch.message] : [];
}

export function supportsProviderNativeWebSearch(provider: ModelProviderConfig): boolean {
  return provider.type === "openai-compatible" && provider.api === "responses";
}

type WebSearchResolution =
  | {
      kind: "none";
    }
  | {
      kind: "provider";
      tool: ModelProviderNativeTool;
    }
  | {
      kind: "issue";
      message: string;
    };

function resolveWebSearchModelTool(input: {
  agent: AgentConfig;
  modelProvider: ModelProviderConfig;
  webAccess?: WebAccessConfig;
}): WebSearchResolution {
  if (!input.agent.toolNames.includes(WEB_SEARCH_MODEL_TOOL_NAME)) {
    return { kind: "none" };
  }

  if (!input.webAccess?.enabled) {
    return {
      kind: "issue",
      message: `Agent '${input.agent.name}' references ${WEB_SEARCH_MODEL_TOOL_NAME} but web access is disabled`
    };
  }

  if (!input.webAccess.search.enabled) {
    return {
      kind: "issue",
      message: `Agent '${input.agent.name}' references ${WEB_SEARCH_MODEL_TOOL_NAME} but webAccess.search is disabled`
    };
  }

  const search = input.webAccess.search;
  if (search.mode === "managed_only") {
    return {
      kind: "issue",
      message: createManagedUnsupportedMessage(input.agent.name, search.managedProvider)
    };
  }

  const nativeSupported = supportsProviderNativeWebSearch(input.modelProvider);
  if (search.mode === "native_only") {
    return nativeSupported
      ? createOpenAiWebSearchTool()
      : {
          kind: "issue",
          message: `Agent '${input.agent.name}' references ${WEB_SEARCH_MODEL_TOOL_NAME} but model provider '${input.modelProvider.id}' does not support provider-native web search`
        };
  }

  if (!search.managedProvider && nativeSupported) {
    return createOpenAiWebSearchTool();
  }

  if (search.managedProvider) {
    return {
      kind: "issue",
      message: createManagedUnsupportedMessage(input.agent.name, search.managedProvider)
    };
  }

  return {
    kind: "issue",
    message: `Agent '${input.agent.name}' references ${WEB_SEARCH_MODEL_TOOL_NAME} but model provider '${input.modelProvider.id}' does not support native web search and managed web search providers are not implemented`
  };
}

function createOpenAiWebSearchTool(): WebSearchResolution {
  return {
    kind: "provider",
    tool: {
      kind: "provider",
      id: OPENAI_WEB_SEARCH_PROVIDER_TOOL_ID,
      name: WEB_SEARCH_MODEL_TOOL_NAME
    }
  };
}

function createManagedUnsupportedMessage(agentName: string, managedProvider: string | undefined): string {
  return managedProvider
    ? `Agent '${agentName}' references ${WEB_SEARCH_MODEL_TOOL_NAME} with managed provider '${managedProvider}', but managed web search providers are not implemented`
    : `Agent '${agentName}' references ${WEB_SEARCH_MODEL_TOOL_NAME} with managed web search mode, but managed web search providers are not implemented`;
}
