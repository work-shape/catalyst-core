import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "@work-shape/catalyst-asset-schemas";
import {
  skillConfigToForm,
  skillFacts,
  skillFormToConfig
} from "@work-shape/catalyst-chat-ui/build-area";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import {
  agentConfigSchema,
  createSafeConfigView,
  parseClientInstanceConfig,
  skillConfigSchema
} from "@work-shape/catalyst-config-schema";
import { createSkillSourceVersion } from "@work-shape/catalyst-tool-execution";

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
  initialPrompts?: { title: string; prompt: string; icon?: string }[];
}) {
  return agentOf(input)?.starters;
}

function agentOf(input: {
  skillNames: string[];
  toolNames?: string[];
  skills: ReturnType<typeof skill>[];
  locale?: string;
  initialPrompts?: { title: string; prompt: string; icon?: string }[];
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

  it("shows at most nine, the skills in the order the agent names them", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    const skills = [...names]
      .reverse()
      .map((name) => skill(name, [starter(`${name}1`), starter(`${name}2`)]));

    expect(startersOf({ skillNames: names, skills })?.map((entry) => entry.title)).toEqual(
      names
        .slice(0, 5)
        .flatMap((name) => [`${name}1`, `${name}2`])
        .slice(0, 9)
    );
  });

  it("shows the skills' starters only for an agent without prompts of its own", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const skills = names.map((name) => skill(name, [starter(`${name}1`), starter(`${name}2`)]));
    const prompts = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        title: `P${index + 1}`,
        prompt: `Prompt ${index + 1}.`
      }));
    const shown = (count: number) => {
      const agent = agentOf({ skillNames: names, skills, initialPrompts: prompts(count) });
      return [
        ...(agent?.initialPrompts ?? []).map((entry) => entry.title),
        ...(agent?.starters ?? []).map((entry) => entry.title)
      ];
    };
    const own = (count: number) => prompts(count).map((entry) => entry.title);

    expect(shown(0)).toEqual(["a1", "a2", "b1", "b2", "c1", "c2", "d1", "d2", "e1"]);
    expect(shown(1)).toEqual(own(1));
    expect(shown(6)).toEqual(own(6));
    expect(shown(11)).toEqual(own(11));
    expect(shown(13)).toEqual(own(12));
  });

  it("refuses an agent whose prompt names an icon outside the starter icons", () => {
    const parsed = agentConfigSchema.safeParse({
      name: "agent",
      displayName: "Agent",
      instructions: "Help.",
      initialPrompts: [{ title: "Plan", prompt: "Plan the week.", icon: "rocket" }]
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["initialPrompts", 0, "icon"]);
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

// A skill's `summary`: the sentence for people, from the skill file to the row that shows it.
describe("the summary of a skill", () => {
  const plain = {
    name: "plain-language",
    title: "Plain language",
    description: "Use when a text should be short and easy to read.",
    content: "One thought per sentence."
  };
  const summary = "Knows how to write short, easy sentences in German and English.";

  it("is read from the front matter, optional, and one line of at most 120 characters", () => {
    const file = `---\ntitle: Plain language\ndescription: Use for short texts.\nsummary: ${summary}\n---\nWrite.`;
    expect(parseSkillMarkdown(file, "SKILL.md", "skills/plain/SKILL.md")).toMatchObject({
      summary,
      description: "Use for short texts."
    });
    expect(skillConfigSchema.parse(plain)).not.toHaveProperty("summary");
    const valid = (value: string) =>
      skillConfigSchema.safeParse({ ...plain, summary: value }).success;
    expect(valid("a".repeat(120))).toBe(true);
    expect(valid("a".repeat(121))).toBe(false);
    expect(valid("Knows how to write.\nAnd more.")).toBe(false);
    expect(valid("")).toBe(false);
  });

  it("changes the version a proposed change is checked against, and only where it is set", () => {
    const before = createSkillSourceVersion(plain);

    expect(createSkillSourceVersion({ ...plain, summary })).not.toBe(before);
    expect(createSkillSourceVersion({ ...plain, summary: undefined })).toBe(before);
  });

  it("is kept by a save of the form and left out where the field is empty", () => {
    expect(skillFormToConfig(skillConfigToForm({ ...plain, summary }))).toEqual({
      ...plain,
      summary
    });
    expect(skillFormToConfig({ ...skillConfigToForm(plain), summary: "  " })).toEqual(plain);
    expect(skillFacts({ attributes: { summary } })).toEqual({ summary });
    expect(skillFacts({ attributes: { summary: " " } })).toEqual({});
  });

  it("takes the icon a list shows from a skill a release ships and from no other", () => {
    expect(skillFacts({ attributes: { origin: "release", icon: "pdf" } })).toEqual({
      icon: "pdf"
    });
    // A custom skill named like a shipped one, or one that claims an icon, stays generic.
    expect(skillFacts({ attributes: { icon: "pdf" } })).toEqual({});
    expect(skillFacts({ attributes: { origin: "custom", icon: "pdf" } })).toEqual({});
  });
});
