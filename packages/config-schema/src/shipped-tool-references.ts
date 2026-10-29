import type { ShippedAgent, ShippedSkill } from "@work-shape/catalyst-core";
import { agentToolReferenceLocations } from "./agent-tool-references";
import { findMissingAgentToolReferences } from "./reference-validation";
import { formerAgentToolWarnings } from "./former-tool-names";

/** Release authors must fix references, including retired names, before shipping them. */
export function findShippedToolReferenceIssues(input: {
  agents: readonly ShippedAgent[];
  skills: readonly ShippedSkill[];
  enabledToolNames: readonly string[];
  registeredToolNames: readonly string[];
  /** Exact registered operations, rights and config paths mentioned as reference material. */
  nonToolNames?: readonly string[];
}): string[] {
  const definitions = [
    ...input.agents.map((agent) => ({
      kind: "Agent",
      name: agent.name,
      instructions: agent.instructions,
      toolNames: agent.toolNames
    })),
    // Resource files are reference material (including examples for other module choices),
    // not instructions to call those tools on this instance.
    ...input.skills.map((skill) => ({
      kind: "Skill",
      name: skill.name,
      instructions: skill.content,
      toolNames: skill.tools ?? []
    }))
  ];
  return definitions.flatMap((definition) => {
    const agent = { ...definition, toolNames: [...definition.toolNames] };
    const references = agentToolReferenceLocations(agent, input.registeredToolNames).filter(
      ({ name, location }) =>
        definition.kind !== "Skill" ||
        !location.startsWith("instructions ") ||
        input.registeredToolNames.includes(name) ||
        (!input.nonToolNames?.includes(name) &&
          !/^(?:connection|data_store)\.[a-z][a-z0-9_-]*$/u.test(name))
    );
    const missing = new Set([
      ...agent.toolNames.filter((name) => !input.enabledToolNames.includes(name)),
      ...findMissingAgentToolReferences(
        [{ ...agent, toolNames: references.map(({ name }) => name) }],
        input.enabledToolNames
      ).map(({ referenceName }) => referenceName)
    ]);
    return [
      ...formerAgentToolWarnings(agent),
      ...references
        .filter(({ name }) => missing.has(name))
        .map(
          ({ name, location }) =>
            `${definition.kind} '${definition.name}' references unavailable tool '${name}' in ${location}`
        )
    ];
  });
}
