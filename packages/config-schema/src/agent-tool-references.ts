import type { AgentConfig } from "./schemas";
import { isFormerToolName } from "./former-tool-names";
import { findMissingAgentToolReferences } from "./reference-validation";

/** An explicit tool reference, with the location an author needs to repair it. */
export interface AgentToolReferenceLocation {
  name: string;
  location: string;
}

// These suffixes name files or hosts rather than tools, even in a tool group.
const NON_TOOL_SUFFIX =
  /\.(?:md|txt|json|ya?ml|csv|tsv|xlsx?|docx?|pptx?|pdf|html?|css|[cm]?[jt]sx?|py|sh|sql|xml|log|toml|ini|env|gz|tar|png|jpe?g|svg|webp|zip|com|org|net|io|de|co|uk|eu|dev|app|ai|info|biz|edu|gov|me|us|at|ch|fr|nl|it|es|ca|au|cloud|online|site|test|localhost)$/iu;

/**
 * Lists toolNames and dotted instruction tokens in the full tool registry’s tool groups.
 * Lines are one-based within instructions. Skills are never scanned.
 */
export function agentToolReferenceLocations(
  agent: Pick<AgentConfig, "toolNames" | "instructions">,
  registeredToolNames: readonly string[]
): AgentToolReferenceLocation[] {
  const toolPrefixes = new Set([
    ...registeredToolNames.map((name) => name.split(".")[0]),
    "connection",
    "app",
    "data_store"
  ]);
  // A former tool name is no reference: it is accepted, and startup warns about it with the
  // name that replaced it.
  const references = agent.toolNames.flatMap((name, index) =>
    isFormerToolName(name) ? [] : [{ name, location: `toolNames[${index}]` }]
  );
  for (const [index, line] of agent.instructions.split(/\r?\n/u).entries()) {
    // Remove whole addresses and paths before matching, so their dotted parts never leak in.
    const prose = line.replace(
      /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>`]+|[\w.+-]+@[\w.-]+|(?:[\w.-]*[\/\\])+[^\s<>`]+/giu,
      " "
    );
    const seen = new Set<string>();
    for (const match of prose.matchAll(
      /(?<![\w.@-])([a-z][a-z0-9_-]*(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)+)(?![\w@-]|\.\*)/gu
    )) {
      const name = match[1];
      if (
        name === undefined ||
        isFormerToolName(name) ||
        !toolPrefixes.has(name.split(".")[0]) ||
        NON_TOOL_SUFFIX.test(name) ||
        seen.has(name)
      )
        continue;
      seen.add(name);
      references.push({ name, location: `instructions line ${index + 1}` });
    }
  }
  return references;
}

/** Shared diagnostics for config validate, release checks and writes. */
export function findAgentToolReferenceIssues(input: {
  agents: readonly AgentConfig[];
  enabledToolNames: readonly string[];
  /** All registered tools, including tools disabled by release config or module switches. */
  registeredToolNames?: readonly string[];
  /** The synchronous schema pass defers dynamic tools to the instance's asset set. */
  deferDataTools?: boolean;
}): string[] {
  const enabled = new Set(input.enabledToolNames);
  return input.agents.flatMap((agent) => {
    const references = agentToolReferenceLocations(
      agent,
      input.registeredToolNames ?? input.enabledToolNames
    );
    const missing = input.deferDataTools
      ? new Set(
          findMissingAgentToolReferences(
            [{ ...agent, toolNames: references.map(({ name }) => name) }],
            input.enabledToolNames
          ).map(({ referenceName }) => referenceName)
        )
      : new Set(references.filter(({ name }) => !enabled.has(name)).map(({ name }) => name));
    return references
      .filter(({ name }) => missing.has(name))
      .map(
        ({ name, location }) =>
          `Agent '${agent.name}' references unavailable tool '${name}' in ${location}`
      );
  });
}
