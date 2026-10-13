import { describe, expect, it } from "vitest";
import { resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import {
  agentConfigSchema,
  createSafeConfigView,
  parseClientInstanceConfig,
  skillConfigSchema
} from "@vivd-catalyst/config-schema";

const starter = (title: string, extra: Record<string, unknown> = {}) => ({
  title: { en: title, de: `${title} (de)` },
  prompt: { en: `${title}.`, de: `${title}. (de)` },
  ...extra
});

const skill = (name: string, starters?: unknown[]) =>
  skillConfigSchema.parse({
    name,
    title: name,
    description: "When to use it.",
    content: "# Text",
    ...(starters === undefined ? {} : { starters })
  });

function startersOf(input: {
  skillNames: string[];
  toolNames?: string[];
  skills: ReturnType<typeof skill>[];
  locale?: string;
}) {
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: { id: "starters-test", displayName: "Starters", environment: "development" },
    auth: { development: { enabled: true, user: { permissionRefs: [] } } },
    localization: { defaultLocale: "en", supportedLocales: ["en", "de"] },
    infrastructure: { models: { local: { provider: "deterministic", model: "local" } } }
  });
  const assets = {
    version: 1,
    defaultAgentName: "agent",
    agents: [
      agentConfigSchema.parse({
        name: "agent",
        displayName: "Agent",
        instructions: "Help.",
        skillNames: input.skillNames,
        toolNames: input.toolNames ?? []
      })
    ],
    skills: input.skills
  };
  return createSafeConfigView(config, assets, resolveInstanceModules(config, []).snapshot, {
    requestedLocale: input.locale ?? "en"
  }).agents[0]?.starters;
}

describe("skill starters", () => {
  it("offers an agent the starters of its skills, in the language asked for", () => {
    const skills = [skill("sheets", [starter("Build a sheet", { hint: "With formulas" })])];

    expect(startersOf({ skillNames: ["sheets"], skills })).toEqual([
      {
        skillName: "sheets",
        title: "Build a sheet",
        hint: "With formulas",
        prompt: "Build a sheet."
      }
    ]);
    expect(startersOf({ skillNames: ["sheets"], skills, locale: "de" })).toEqual([
      {
        skillName: "sheets",
        title: "Build a sheet (de)",
        hint: "With formulas",
        prompt: "Build a sheet. (de)"
      }
    ]);
  });

  it("shows a starter only when the agent holds every tool it names", () => {
    const skills = [
      skill("sheets", [
        starter("Build a sheet", { tools: ["workspace.write_file", "workspace.exec"] }),
        starter("Explain a formula")
      ])
    ];
    const titles = (toolNames: string[]) =>
      startersOf({ skillNames: ["sheets"], toolNames, skills })?.map((entry) => entry.title);

    expect(titles(["workspace.write_file", "workspace.exec"])).toEqual([
      "Build a sheet",
      "Explain a formula"
    ]);
    // Removing one named tool hides the starter that needs it.
    expect(titles(["workspace.write_file"])).toEqual(["Explain a formula"]);
  });

  it("shows at most four, the skills in the order the agent names them", () => {
    const skills = [
      skill("c", [starter("C1"), starter("C2")]),
      skill("a", [starter("A1"), starter("A2")]),
      skill("b", [starter("B1"), starter("B2")])
    ];

    expect(
      startersOf({ skillNames: ["a", "b", "c"], skills })?.map((entry) => entry.title)
    ).toEqual(["A1", "A2", "B1", "B2"]);
  });

  it("offers none for an agent without the skill, and for skills that carry none", () => {
    const skills = [skill("sheets", [starter("Build a sheet")]), skill("plain")];

    expect(startersOf({ skillNames: [], skills })).toEqual([]);
    expect(startersOf({ skillNames: ["plain", "gone"], skills })).toEqual([]);
  });

  it("refuses a third starter, a long title, a title of two lines and an unknown field", () => {
    const issues = (starters: unknown[]) =>
      skillConfigSchema.safeParse({
        name: "sheets",
        title: "Sheets",
        description: "When.",
        content: "# Text",
        starters
      }).error?.issues;

    expect(issues([starter("One"), starter("Two")])).toBeUndefined();
    expect(issues([starter("One"), starter("Two"), starter("Three")])).toHaveLength(1);
    expect(issues([{ title: "x".repeat(61), prompt: "Go" }])?.[0]?.path).toEqual([
      "starters",
      0,
      "title"
    ]);
    expect(issues([{ title: "Two\nlines", prompt: "Go" }])).toHaveLength(1);
    expect(issues([{ title: "One", prompt: "Go", send: true }])).toHaveLength(1);
  });
});
