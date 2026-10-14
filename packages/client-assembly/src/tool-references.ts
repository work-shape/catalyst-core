import type { AgentToolReference } from "@vivd-catalyst/chat-server";
import { WEB_SEARCH_MODEL_TOOL_NAME } from "@vivd-catalyst/model-provider";
import type { AnyToolDefinition } from "@vivd-catalyst/tool-sdk";

/** Tools the model provider carries out itself: no code registers them, so they are told here. */
const MODEL_TOOL_REFERENCES: readonly AgentToolReference[] = [
  {
    name: WEB_SEARCH_MODEL_TOOL_NAME,
    title: { en: "Search the web", de: "Im Web suchen" },
    summary: {
      en: "Searches the web and answers with the sources it found.",
      de: "Sucht im Web und antwortet mit den Quellen, die es gefunden hat."
    },
    group: "web",
    icon: "web",
    effect: "reading"
  }
];

/**
 * The named tools with what each tells people, from their registered definitions. A name no
 * definition registers is listed by its name alone.
 */
export function agentToolReferences(
  names: readonly string[],
  tools: readonly AnyToolDefinition[]
): AgentToolReference[] {
  const byName = new Map<string, AgentToolReference>(
    MODEL_TOOL_REFERENCES.map((tool) => [tool.name, tool])
  );
  for (const tool of tools) {
    byName.set(tool.name, {
      name: tool.name,
      effect: tool.effect,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.summary ? { summary: tool.summary } : {}),
      ...(tool.group ? { group: tool.group } : {}),
      ...(tool.icon ? { icon: tool.icon } : {})
    });
  }
  return names.map((name) => byName.get(name) ?? { name });
}
