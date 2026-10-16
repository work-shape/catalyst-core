import type { AgentConfig } from "./schemas";

/**
 * Tool names that were renamed, each with the name that replaced it. A release config or an
 * agent that names a former name still starts, with a warning that names the new one. The
 * tools are offered under their new names only, so a former name stands for nothing. A later
 * release refuses them (OPEN-2).
 */
const FORMER_TOOL_NAMES: ReadonlyMap<string, string> = new Map([
  ["page.save", "workspace.open"],
  ["page.save_as_app", "app.save"]
]);

/** Whether `name` is a former tool name, which validation accepts and a run ignores. */
export function isFormerToolName(name: string): boolean {
  return FORMER_TOOL_NAMES.has(name);
}

/** One warning for each tool entry of the release config that is a former tool name. */
export function formerReleaseToolWarnings(releaseToolNames: readonly string[]): string[] {
  return releaseToolNames.flatMap((name) => {
    const current = FORMER_TOOL_NAMES.get(name);
    return current === undefined ? [] : [formerToolWarning("The release config", name, current)];
  });
}

/**
 * One warning for each former tool name an agent names, in its tool list or its instructions,
 * with the name that replaced it.
 */
export function formerAgentToolWarnings(
  agent: Pick<AgentConfig, "name" | "toolNames" | "instructions">
): string[] {
  return [...FORMER_TOOL_NAMES].flatMap(([former, current]) =>
    agent.toolNames.includes(former) || namesInText(agent.instructions, former)
      ? [formerToolWarning(`Agent '${agent.name}'`, former, current)]
      : []
  );
}

function formerToolWarning(where: string, former: string, current: string): string {
  return `${where} names the tool '${former}', which is now '${current}'. Rename it: a later release refuses '${former}'.`;
}

/** Whether `text` names the tool `name` as a word of its own. */
function namesInText(text: string, name: string): boolean {
  const escaped = name.replaceAll(".", "\\.");
  return new RegExp(`(?<![\\w.])${escaped}(?![\\w])`, "u").test(text);
}
