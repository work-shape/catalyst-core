import {
  isDataToolName,
  knowledgeOperationNamesOf,
  KNOWLEDGE_QUERY_TOOL_NAME,
  type AgentConfig,
  type DataToolDescriptor,
  type DataToolSource,
  type ToolDescriptor,
  type WebAccessConfig
} from "@work-shape/catalyst-core";
import {
  WEB_SEARCH_MODEL_TOOL_NAME,
  type ModelCapabilities,
  type ModelTool
} from "@work-shape/catalyst-model-provider";

export interface ModelToolRegistryView {
  listDescriptorsForAgent(toolNames: readonly string[]): ToolDescriptor[];
}

/**
 * How long the start of a run waits for the source to describe the agent's data tools. A
 * source answers from the instance's own store, so this is far above an ordinary answer. When
 * it is reached the run goes on without data tools. Release config `runtime
 * .dataToolDescribeTimeoutMs` moves it.
 */
export const DATA_TOOL_DESCRIBE_TIMEOUT_MS = 10_000;

/** The data tools an agent lists, as their source describes them when a run starts. */
export interface AgentDataTools {
  described: DataToolDescriptor[];
  /** Listed and not described now: the Connection or the operation is gone, off or not ready. */
  missing: string[];
  /** Set when the source failed or did not answer in time. Every listed tool is then missing. */
  sourceFailure?: "failed" | "timed_out";
}

/**
 * Reads the data tools an agent lists, with one read of the source for all of them. An agent
 * that lists none costs no read. A tool the source does not describe is missing: the run goes
 * on without it. Without a source every data tool the agent lists is missing, and so it is
 * when the source fails or does not answer within `timeoutMs`. It never throws.
 *
 * The Knowledge Bases an agent lists are read in the same call, as the query operation of
 * each. Where one of them is described, so is the one tool over them, `knowledge.query`,
 * which the agent is offered in their place.
 */
export async function describeAgentDataTools(
  agent: Pick<AgentConfig, "toolNames" | "knowledgeBases">,
  source: DataToolSource | undefined,
  timeoutMs: number = DATA_TOOL_DESCRIBE_TIMEOUT_MS
): Promise<AgentDataTools> {
  const knowledge = knowledgeOperationNamesOf(agent);
  const listed = [...new Set([...agent.toolNames.filter(isDataToolName), ...knowledge])];
  const accepted = (name: string) =>
    listed.includes(name) || (name === KNOWLEDGE_QUERY_TOOL_NAME && knowledge.length > 0);
  if (listed.length === 0 || !source) {
    return { described: [], missing: listed };
  }
  const answer = await describeWithin(source, listed, timeoutMs);
  if (typeof answer === "string") {
    return { described: [], missing: listed, sourceFailure: answer };
  }
  const byName = new Map<string, DataToolDescriptor>();
  for (const descriptor of answer) {
    // The agent's own list decides: a source is never trusted to add a tool to it.
    if (accepted(descriptor.name) && !byName.has(descriptor.name)) {
      byName.set(descriptor.name, descriptor);
    }
  }
  return {
    described: [...listed, KNOWLEDGE_QUERY_TOOL_NAME].flatMap((name) => byName.get(name) ?? []),
    missing: listed.filter((name) => !byName.has(name))
  };
}

/** The source's answer, or how it failed. The read itself cannot be stopped, only left. */
async function describeWithin(
  source: DataToolSource,
  toolNames: readonly string[],
  timeoutMs: number
): Promise<DataToolDescriptor[] | "failed" | "timed_out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // Called inside the `try`, so a source that throws before it returns a promise is a
      // failure like any other.
      Promise.resolve()
        .then(() => source.describe(toolNames, {}))
        .catch(() => "failed" as const),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a call names a data tool this run was not offered when it started. Such a call is
 * refused whatever the source says by now: what an agent may call in a run is fixed at its
 * start, and a tool that became ready meanwhile is there for the next run.
 */
export function isUnofferedDataToolCall(toolName: string, offered: ReadonlySet<string>): boolean {
  return (
    (isDataToolName(toolName) || toolName === KNOWLEDGE_QUERY_TOOL_NAME) && !offered.has(toolName)
  );
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
  // The operations of the agent's Knowledge Bases are no tools of their own: the one
  // knowledge tool stands for them.
  const dataTools = (input.dataTools ?? []).filter(
    (tool) =>
      ((isDataToolName(tool.name) && functionToolNames.includes(tool.name)) ||
        tool.name === KNOWLEDGE_QUERY_TOOL_NAME) &&
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
