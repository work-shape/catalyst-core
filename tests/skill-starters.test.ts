import { describe, expect, it } from "vitest";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import {
  agentConfigSchema,
  createSafeConfigView,
  parseClientInstanceConfig,
  skillConfigSchema
} from "@work-shape/catalyst-config-schema";

const starter = (title: string, extra: Record<string, unknown> = {}) => ({
  title: { en: title, de: `${title} (de)` },
  prompt: { en: `${title}.`, de: `${title}. (de)` },
  ...extra
});

const skill = (name: string, starters?: unknown[], extra: Record<string, unknown> = {}) =>
  skillConfigSchema.parse({
    name,
    title: name,
    description: "When to use it.",
    content: "# Text",
    ...(starters === undefined ? {} : { starters }),
    ...extra
  });

function startersOf(input: {
  skillNames: string[];
  toolNames?: string[];
  skills: ReturnType<typeof skill>[];
  locale?: string;
  initialPrompts?: { title: string; prompt: string }[];
}) {
  return agentOf(input)?.starters;
}

function agentOf(input: {
  skillNames: string[];
  toolNames?: string[];
  skills: ReturnType<typeof skill>[];
  locale?: string;
  initialPrompts?: { title: string; prompt: string }[];
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
        toolNames: input.toolNames ?? [],
        ...(input.initialPrompts === undefined ? {} : { initialPrompts: input.initialPrompts })
      })
    ],
    skills: input.skills
  };
  return createSafeConfigView(config, assets, resolveInstanceModules(config, []).snapshot, {
    requestedLocale: input.locale ?? "en"
  }).agents[0];
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

  it("shows four in all with the author's prompts, the author's prompts first", () => {
    const skills = [
      skill("a", [starter("A1"), starter("A2")]),
      skill("b", [starter("B1"), starter("B2")])
    ];
    const prompts = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        title: `P${index + 1}`,
        prompt: `Prompt ${index + 1}.`
      }));
    const shown = (count: number) => {
      const agent = agentOf({ skillNames: ["a", "b"], skills, initialPrompts: prompts(count) });
      return [
        ...(agent?.initialPrompts ?? []).map((entry) => entry.title),
        ...(agent?.starters ?? []).map((entry) => entry.title)
      ];
    };

    expect(shown(0)).toEqual(["A1", "A2", "B1", "B2"]);
    expect(shown(1)).toEqual(["P1", "A1", "A2", "B1"]);
    expect(shown(3)).toEqual(["P1", "P2", "P3", "A1"]);
    expect(shown(5)).toEqual(["P1", "P2", "P3", "P4"]);
  });

  it("carries the skill's icon for a platform skill only", () => {
    const skills = [
      skill("platform.spreadsheets", [starter("Build a sheet")], {
        origin: "release",
        icon: "spreadsheet"
      }),
      // A skill of the instance's own keeps the generic icon, whatever it declares.
      skill("pdf", [starter("Read a PDF")], { icon: "pdf" })
    ];

    expect(
      startersOf({ skillNames: ["platform.spreadsheets", "pdf"], skills })?.map((entry) => ({
        title: entry.title,
        icon: entry.icon
      }))
    ).toEqual([
      { title: "Build a sheet", icon: "spreadsheet" },
      { title: "Read a PDF", icon: undefined }
    ]);
    expect(startersOf({ skillNames: ["pdf"], skills })?.[0]).not.toHaveProperty("icon");
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
