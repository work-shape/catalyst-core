import type { AgentConfig } from "./schemas";
import { findMissingAgentToolReferences } from "./reference-validation";

/** An explicit tool reference, with the location an author needs to repair it. */
export interface AgentToolReferenceLocation {
  name: string;
  location: string;
}

// Inline code must hold a whole dotted identifier (optionally followed by an empty call).
const DOTTED_TOOL_NAME = /^[a-z][a-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+(?:\(\))?$/u;
// Common document/code filenames are ambiguous identifiers, so do not infer tools from them.
const FILE_EXTENSION =
  /\.(?:md|txt|json|ya?ml|csv|tsv|xlsx?|docx?|pptx?|pdf|html?|css|[cm]?[jt]sx?|py|sh|sql|png|jpe?g|svg|webp|zip)$/iu;

/**
 * Lists every toolNames entry and explicit inline-code tool identifier in instructions.
 * Bare prose, paths, URLs, wildcards, file names and fenced code are not tool declarations.
 * Lines are one-based within the instructions string, rather than the containing YAML file.
 */
export function agentToolReferenceLocations(
  agent: Pick<AgentConfig, "toolNames" | "instructions">
): AgentToolReferenceLocation[] {
  const references = agent.toolNames.map((name, index) => ({
    name,
    location: `toolNames[${index}]`
  }));
  let fence: { marker: string; length: number } | undefined;
  for (const [index, line] of agent.instructions.split(/\r?\n/u).entries()) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (delimiter !== undefined) {
      if (fence === undefined) {
        fence = { marker: delimiter[0] ?? "", length: delimiter.length };
      } else if (delimiter[0] === fence.marker && delimiter.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) continue;
    const seen = new Set<string>();
    for (const match of line.matchAll(/(?<![`\\])`([^`]+)`(?!`)/gu)) {
      const identifier = match[1];
      if (identifier === undefined || !DOTTED_TOOL_NAME.test(identifier)) continue;
      const name = identifier.replace(/\(\)$/u, "");
      if (FILE_EXTENSION.test(name) || seen.has(name)) continue;
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
  /** The synchronous schema pass defers data tools to the instance's live sources. */
  deferDataTools?: boolean;
}): string[] {
  const enabled = new Set(input.enabledToolNames);
  return input.agents.flatMap((agent) => {
    const references = agentToolReferenceLocations(agent);
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
