import type { AgentConfig, ToolDescriptor, WebAccessConfig } from "@vivd-catalyst/core";
import {
  WEB_SEARCH_MODEL_TOOL_NAME,
  type ModelCapabilities,
  type ModelTool
} from "@vivd-catalyst/model-provider";

export interface ModelToolRegistryView {
  listDescriptorsForAgent(toolNames: readonly string[]): ToolDescriptor[];
}

export interface ModelToolMaterializationInput {
  agent: AgentConfig;
  /** What the agent's model can do, as the gateway reports it. */
  capabilities: Pick<ModelCapabilities, "nativeTools">;
  toolRegistry: ModelToolRegistryView;
  webAccess?: WebAccessConfig;
}

/**
 * The tools a model call offers for an agent: the agent's function tools, and web search as the
 * provider's own tool when the instance allows it and the model has it. Web search that cannot
 * be offered is left out; `findModelToolMaterializationIssues` says why.
 */
export function materializeModelTools(input: ModelToolMaterializationInput): ModelTool[] {
  const functionToolNames = input.agent.toolNames.filter(
    (toolName) => toolName !== WEB_SEARCH_MODEL_TOOL_NAME
  );
  const functionTools = input.toolRegistry
    .listDescriptorsForAgent(functionToolNames)
    .map((tool): ModelTool => ({
      kind: "function",
      name: tool.name,
      description: tool.description,
      inputJsonSchema: tool.inputJsonSchema
    }));
  return input.agent.toolNames.includes(WEB_SEARCH_MODEL_TOOL_NAME) &&
    findWebSearchIssue(input) === undefined
    ? [...functionTools, { kind: "provider", name: WEB_SEARCH_MODEL_TOOL_NAME }]
    : functionTools;
}

/** Why a tool the agent lists cannot be offered to its model. Empty when every tool can. */
export function findModelToolMaterializationIssues(
  input: Omit<ModelToolMaterializationInput, "toolRegistry">
): string[] {
  if (!input.agent.toolNames.includes(WEB_SEARCH_MODEL_TOOL_NAME)) {
    return [];
  }
  const issue = findWebSearchIssue(input);
  return issue === undefined ? [] : [issue];
}

function findWebSearchIssue(
  input: Omit<ModelToolMaterializationInput, "toolRegistry">
): string | undefined {
  const reference = `Agent '${input.agent.name}' references ${WEB_SEARCH_MODEL_TOOL_NAME}`;
  if (!input.webAccess?.enabled) {
    return `${reference} but web access is disabled`;
  }
  if (!input.webAccess.search.enabled) {
    return `${reference} but webAccess.search is disabled`;
  }
  if (!input.capabilities.nativeTools.includes(WEB_SEARCH_MODEL_TOOL_NAME)) {
    return `${reference} but the model of this agent cannot search the web`;
  }
  return undefined;
}
