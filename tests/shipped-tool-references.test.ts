import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  agentConfigSchema,
  parseClientInstanceConfig,
  findShippedToolReferenceIssues
} from "@work-shape/catalyst-config-schema";
import { resolveInstanceModules, releaseToolNames } from "@work-shape/catalyst-client-assembly";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  connectionOperationName,
  DATA_STORE_ACTIONS,
  RUN_AGENT_TOOL_NAME
} from "@work-shape/catalyst-core";
import { agentListableToolNames } from "../packages/client-assembly/src/platform-orientation";
import { shippedAgentsOf } from "../packages/client-assembly/src/shipped-agents";
import { shippedSkillsOf, offeredSkillNames } from "../packages/client-assembly/src/shipped-skills";

// Runs in release:check as well as the PR suite, against the actual shipped definitions and
// reference client's assembly switches. No database or deployment credentials are needed.
describe("shipped tool references", () => {
  const config = parseClientInstanceConfig(
    parse(readFileSync(new URL("../clients/demo/config/app.yaml", import.meta.url), "utf8"))
  );
  const { snapshot: modules } = resolveInstanceModules(config, []);
  const enabledToolNames = [
    ...agentListableToolNames(releaseToolNames(config)).filter(
      (name) => !modules.offModuleOf("tool", name)
    ),
    ...Object.entries(config.connections).flatMap(([name, connection]) =>
      modules.isEnabled("connections")
        ? (connection.operations ?? [])
            .filter((operation) => operation.exposure.includes("agent"))
            .map((operation) => connectionOperationName(name, operation.name))
        : []
    )
  ];
  const registeredToolNames = [
    ...enabledToolNames,
    ...modules.modules.flatMap((module) => module.definition?.tools ?? [])
  ];
  function configPaths(value: unknown, path = ""): string[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    return Object.entries(value).flatMap(([key, child]) => {
      const name = path ? `${path}.${key}` : key;
      return [name, ...configPaths(child, name)];
    });
  }
  const nonToolNames = [
    ...Object.keys(apiOperations),
    ...Object.values(DATA_STORE_ACTIONS),
    ...configPaths(config)
  ];
  const skills = [
    ...shippedSkillsOf({
      modules,
      capabilities: [],
      hasTool: (name) => enabledToolNames.includes(name)
    }),
    ...readdirSync(new URL("../clients/demo/skills/", import.meta.url)).map((name) => ({
      name,
      title: name,
      description: name,
      icon: "skill",
      content: readFileSync(
        new URL(`../clients/demo/skills/${name}/SKILL.md`, import.meta.url),
        "utf8"
      )
    }))
  ];
  const agents = [
    ...readdirSync(new URL("../clients/demo/agents/", import.meta.url))
      .filter((name) => name.endsWith(".agent.yaml"))
      .map((name) =>
        agentConfigSchema.parse(
          parse(readFileSync(new URL(`../clients/demo/agents/${name}`, import.meta.url), "utf8"))
        )
      ),
    ...shippedAgentsOf({
      modules,
      listableToolNames: enabledToolNames,
      runsTool: (name) => enabledToolNames.includes(name),
      shippedSkills: skills,
      offeredSkillNames: offeredSkillNames(undefined, modules),
      runAgentToolName: RUN_AGENT_TOOL_NAME
    })
  ];
  it("ships agents and skills that name only tools the assembly offers", () => {
    expect(
      findShippedToolReferenceIssues({
        agents,
        skills,
        enabledToolNames,
        registeredToolNames,
        nonToolNames
      })
    ).toEqual([]);
  });
  it.each(["app.edit", "app.save"])("refuses a release whose assembly omits %s", (missing) => {
    expect(
      findShippedToolReferenceIssues({
        agents,
        skills,
        enabledToolNames: enabledToolNames.filter((name) => name !== missing),
        registeredToolNames
      }).join("\n")
    ).toContain(`unavailable tool '${missing}'`);
  });
  it("checks skill instructions and declared tools, and refuses retired names", () => {
    const broken = {
      name: "broken",
      title: "Broken",
      description: "Broken",
      icon: "skill",
      content: "Use app.edit and page.save_as_app.",
      tools: ["missing.tool"]
    };
    const issues = findShippedToolReferenceIssues({
      agents: [],
      skills: [broken],
      enabledToolNames: [],
      registeredToolNames
    });
    expect(issues.join("\n")).toContain("app.edit");
    expect(issues.join("\n")).toContain("page.save_as_app");
    expect(issues.join("\n")).toContain("missing.tool");
  });
});
