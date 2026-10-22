import type { AgentConfig } from "./schemas";

/**
 * Tool names that were renamed or retired, each with the name to use instead. A release config
 * or agent that names a former name still starts, with a warning. A former name stands for
 * nothing; this is not an alias. The renamed page tools are refused in a later release (OPEN-2).
 */
const FORMER_TOOL_NAMES: ReadonlyMap<string, string> = new Map([
  ["page.save", "workspace.open"],
  ["page.save_as_app", "app.save"],
  ["workspace.apply_patch", "workspace.edit_file"]
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
  if (former === "workspace.apply_patch") {
    return `${where} names the retired tool '${former}'. Use '${current}' with exact text edits instead; the old patch input is unsupported and has no alias.`;
  }
  return `${where} names the tool '${former}', which is now '${current}'. Rename it: a later release refuses '${former}'.`;
}

/** Whether `text` names the tool `name` as a word of its own. */
function namesInText(text: string, name: string): boolean {
  const escaped = name.replaceAll(".", "\\.");
  return new RegExp(`(?<![\\w.])${escaped}(?![\\w])`, "u").test(text);
}
