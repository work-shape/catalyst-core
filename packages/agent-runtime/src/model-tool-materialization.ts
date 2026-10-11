import type {
  AgentConfig,
  OperationEffect,
  OperationListScope,
  ToolDescriptor,
  WebAccessConfig
} from "@vivd-catalyst/core";
import {
  WEB_SEARCH_MODEL_TOOL_NAME,
  type ModelCapabilities,
  type ModelTool
} from "@vivd-catalyst/model-provider";

export interface ModelToolRegistryView {
  listDescriptorsForAgent(toolNames: readonly string[]): ToolDescriptor[];
}

/**
 * A tool an agent carries that exists as data, and where such tools are described.
 *
 * The three declarations below are local until `core/src/data-tools.ts` exists (C1 slice K).
 * Then `DATA_TOOL_PREFIXES`, `isDataToolName`, `DataToolDescriptor` and `DataToolSource` come
 * from core.
 */
const DATA_TOOL_PREFIXES = ["connection."] as const;

function isDataToolName(name: string): boolean {
  return DATA_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export interface DataToolDescriptor extends ToolDescriptor {
  effect: OperationEffect;
}

export interface DataToolSource {
  /** Of the named tools, those that exist now and that an agent may carry. One read, never one per name. */
  describe(toolNames: readonly string[], scope: OperationListScope): Promise<DataToolDescriptor[]>;
}

/** The data tools an agent lists, as their source describes them when a run starts. */
export interface AgentDataTools {
  described: DataToolDescriptor[];
  /** Listed and not described now: the Connection or the operation is gone, off or not ready. */
  missing: string[];
}

/**
 * Reads the data tools an agent lists, with one read of the source for all of them. An agent
 * that lists none costs no read. A tool the source does not describe is missing: the run goes
 * on without it. Without a source every data tool the agent lists is missing.
 */
export async function describeAgentDataTools(
  agent: Pick<AgentConfig, "toolNames">,
  source: DataToolSource | undefined
): Promise<AgentDataTools> {
  const listed = [...new Set(agent.toolNames.filter(isDataToolName))];
  if (listed.length === 0 || !source) {
    return { described: [], missing: listed };
  }
  const byName = new Map<string, DataToolDescriptor>();
  for (const descriptor of await source.describe(listed, {})) {
    // The agent's own list decides: a source is never trusted to add a tool to it.
    if (listed.includes(descriptor.name) && !byName.has(descriptor.name)) {
      byName.set(descriptor.name, descriptor);
    }
  }
  return {
    described: listed.flatMap((name) => byName.get(name) ?? []),
    missing: listed.filter((name) => !byName.has(name))
  };
}

export interface ModelToolMaterializationInput {
  agent: AgentConfig;
  /** What the agent's model can do, as the gateway reports it. */
  capabilities: Pick<ModelCapabilities, "nativeTools">;
  toolRegistry: ModelToolRegistryView;
  /** The agent's data tools as `describeAgentDataTools` read them. Without them there are none. */
  dataTools?: readonly ToolDescriptor[];
  webAccess?: WebAccessConfig;
}

/**
 * The tools a model call offers for an agent: the agent's function tools of the release, then
 * its data tools, and web search as the provider's own tool when the instance allows it and the
 * model has it. Web search that cannot be offered is left out;
 * `findModelToolMaterializationIssues` says why.
 */
export function materializeModelTools(input: ModelToolMaterializationInput): ModelTool[] {
  const functionToolNames = input.agent.toolNames.filter(
    (toolName) => toolName !== WEB_SEARCH_MODEL_TOOL_NAME
  );
  const releaseTools = input.toolRegistry.listDescriptorsForAgent(functionToolNames);
  const releaseNames = new Set(releaseTools.map((tool) => tool.name));
  const dataTools = (input.dataTools ?? []).filter(
    (tool) =>
      isDataToolName(tool.name) &&
      functionToolNames.includes(tool.name) &&
      !releaseNames.has(tool.name)
  );
  const functionTools = [...releaseTools, ...dataTools].map((tool): ModelTool => ({
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
  input: Omit<ModelToolMaterializationInput, "toolRegistry" | "dataTools">
): string[] {
  if (!input.agent.toolNames.includes(WEB_SEARCH_MODEL_TOOL_NAME)) {
    return [];
  }
  const issue = findWebSearchIssue(input);
  return issue === undefined ? [] : [issue];
}

function findWebSearchIssue(
  input: Omit<ModelToolMaterializationInput, "toolRegistry" | "dataTools">
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
