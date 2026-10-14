import { createElement, createRef } from "react";
import { describe, expect, it } from "vitest";
import type { ConfigAssetReferences, LocaleCode } from "@vivd-catalyst/api-client";
import {
  AgentEditor,
  agentConfigToForm,
  agentFormToConfig,
  instanceToolGroups,
  switchToolGroup,
  withImpliedTools,
  type BuildAssetEditorProps
} from "@vivd-catalyst/chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The instance's tools on an agent's page, by package (TOOLS-1): which group a tool stands in,
// what its title is when it has none, the group's switch, and `read_skill` held because the
// agent has skills. Without the grouping the page showed one flat list of ids.

const noop = () => undefined;

function references(overrides: Partial<ConfigAssetReferences> = {}): ConfigAssetReferences {
  return {
    modelProviderIds: ["azure-eu"],
    modelBindingIds: [],
    modelBindings: [],
    fastModeModelBindingIds: [],
    reasoningEfforts: [],
    enabledToolNames: [],
    ...overrides
  };
}

const described = references({
  enabledToolNames: [
    "read_document",
    "web_fetch",
    "workspace.exec",
    "read_skill",
    "propose_skill_change",
    "crm.lookup"
  ],
  tools: [
    {
      name: "read_document",
      title: { en: "Read document text", de: "Dokumenttext lesen" },
      summary: {
        en: "Reads the text of a document attached to the conversation.",
        de: "Liest den Text eines Dokuments, das der Unterhaltung angehängt ist."
      },
      group: "documents",
      effect: "reading",
      module: "documents"
    },
    {
      name: "web_fetch",
      title: { en: "Fetch web page", de: "Webseite abrufen" },
      group: "web",
      effect: "reading"
    },
    { name: "workspace.exec", group: "files", effect: "changing" },
    {
      name: "read_skill",
      title: { en: "Read assigned skill", de: "Zugewiesenen Skill lesen" },
      group: "skills",
      effect: "reading"
    },
    {
      name: "propose_skill_change",
      title: { en: "Propose skill change", de: "Änderung an einem Skill vorschlagen" },
      group: "skills",
      effect: "changing"
    },
    // A deployment's tool registered without wording.
    { name: "crm.lookup", effect: "reading" }
  ]
});

function groups(input: {
  selected?: string[];
  skillNames?: string[];
  locale?: LocaleCode;
  references?: ConfigAssetReferences;
}) {
  return instanceToolGroups({
    references: input.references ?? described,
    selected: input.selected ?? [],
    skillNames: input.skillNames ?? [],
    locale: input.locale ?? "en",
    isOtherSource: (name) => name.startsWith("connection.") || name.startsWith("app.")
  });
}

describe("instance tools by package", () => {
  it("groups the tools by their package in the page's order, the instance's own last", () => {
    const view = groups({});

    expect(view.map((group) => group.group)).toEqual([
      "documents",
      "web",
      "files",
      "skills",
      "instance"
    ]);
    expect(view.find((group) => group.group === "skills")?.tools.map((tool) => tool.name)).toEqual([
      "read_skill",
      "propose_skill_change"
    ]);
    // A tool without a group stands among the instance's own.
    expect(view.at(-1)?.tools.map((tool) => tool.name)).toEqual(["crm.lookup"]);
  });

  it("shows the title and summary in the reader's language, and the id where the title is missing", () => {
    const en = groups({});
    const de = groups({ locale: "de" });

    expect(en[0]?.tools[0]).toMatchObject({
      title: "Read document text",
      summary: "Reads the text of a document attached to the conversation.",
      module: "documents",
      effect: "reading"
    });
    expect(de[0]?.tools[0]).toMatchObject({ title: "Dokumenttext lesen" });
    // Registered without a title: the id stands, and there is no summary.
    const exec = en.find((group) => group.group === "files")?.tools[0];
    expect(exec?.title).toBe("workspace.exec");
    expect(exec).not.toHaveProperty("summary");
    expect(en.at(-1)?.tools[0]?.title).toBe("crm.lookup");
  });

  it("lists every offered tool by its name where the server describes none", () => {
    const view = groups({
      references: references({ enabledToolNames: ["read_skill", "show_view"] })
    });

    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ group: "instance" });
    expect(view[0]?.tools.map((tool) => tool.title)).toEqual(["read_skill", "show_view"]);
  });

  it("keeps a tool the agent holds that nothing offers, and leaves Connection and App tools to their groups", () => {
    const view = groups({
      selected: ["legacy.tool", "connection.crm.lookup", "app.offer.save"]
    });
    const own = view.find((group) => group.group === "instance");

    expect(own?.tools.map((tool) => tool.name)).toEqual(["crm.lookup", "legacy.tool"]);
    expect(view.flatMap((group) => group.tools.map((tool) => tool.name))).not.toContain(
      "connection.crm.lookup"
    );
  });

  it("sets the group's switch on, off or mixed and turns all its tools on or off", () => {
    const skills = (selected: string[]) =>
      groups({ selected }).find((group) => group.group === "skills");

    expect(skills([])?.state).toBe("off");
    expect(skills(["read_skill"])?.state).toBe("mixed");
    expect(skills(["read_skill", "propose_skill_change"])?.state).toBe("on");

    const group = skills(["web_fetch", "read_skill"]);
    if (!group) throw new Error("no skills group");
    // On adds what is missing and keeps the order of the rest; off removes only the group's.
    expect(switchToolGroup(["web_fetch", "read_skill"], group, true)).toEqual([
      "web_fetch",
      "read_skill",
      "propose_skill_change"
    ]);
    expect(switchToolGroup(["web_fetch", "read_skill"], group, false)).toEqual(["web_fetch"]);
  });
});

describe("tools an agent holds because of something else", () => {
  it("shows read_skill as included, with no check box, while the agent has a skill", () => {
    const skills = groups({ skillNames: ["tax-review"] }).find((group) => group.group === "skills");

    expect(skills?.tools.find((tool) => tool.name === "read_skill")?.includedBecause).toBe(
      "skills"
    );
    // The switch reaches only what has a check box, and counts read_skill as held.
    expect(skills?.choosable).toEqual(["propose_skill_change"]);
    expect(skills?.state).toBe("off");
    expect(skills?.heldCount).toBe(1);
    // Without a skill it is a check box like any other.
    expect(
      groups({}).find((group) => group.group === "skills")?.tools[0]?.includedBecause
    ).toBeUndefined();
  });

  it("saves read_skill with an agent that has a skill, once", () => {
    expect(withImpliedTools(["web_fetch"], ["tax-review"])).toEqual(["web_fetch", "read_skill"]);
    expect(withImpliedTools(["read_skill"], ["tax-review"])).toEqual(["read_skill"]);
    expect(withImpliedTools(["web_fetch"], [])).toEqual(["web_fetch"]);

    const form = agentConfigToForm({
      name: "assistant",
      displayName: "Assistant",
      instructions: "Help.",
      toolNames: [],
      skillNames: ["tax-review"],
      initialPrompts: []
    });
    expect(agentFormToConfig(form).toolNames).toEqual(["read_skill"]);
  });
});

describe("the Tools section of the agent page", () => {
  function frame(): BuildAssetEditorProps {
    return {
      page: { ref: createRef<HTMLDivElement>(), above: null, shown: noop },
      asset: undefined,
      start: { name: "assistant", title: "" },
      canWrite: true,
      instanceWrite: true,
      back: null,
      actions: null,
      notice: null,
      onUnsavedChange: noop,
      save: async () => ({ ok: true })
    };
  }

  function page(toolNames: string[], locale: LocaleCode = "en"): string {
    return renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(AgentEditor, {
          frame: frame(),
          initialForm: agentConfigToForm({
            name: "assistant",
            displayName: "Assistant",
            instructions: "Help.",
            toolNames,
            skillNames: [],
            initialPrompts: []
          }),
          isDefault: false,
          references: described,
          editableAgentFields: ["toolNames"],
          canManageAgentModels: false,
          skillChoice: { options: [], onSearch: noop }
        })
      )
    );
  }

  it("shows one group per package with its sentence and switch, and no raw id outside the technical details", () => {
    const markup = page(["read_skill"]);

    for (const group of ["documents", "web", "files", "skills", "instance"]) {
      expect(markup).toContain(`data-instance-tool-group="${group}"`);
    }
    expect(markup).toContain("Reads and inspects the documents people attach.");
    expect(markup).toContain('aria-label="All tools of Skills"');
    // Only read_skill of the two Skills tools is on.
    expect(markup).toContain('aria-checked="mixed"');
    expect(markup).toContain("Technical details");
    // The tools are folded under their group, so no id shows on the page at rest.
    expect(markup).not.toContain("propose_skill_change");
    expect(markup).not.toContain("Skills require the read_skill tool");
  });

  it("speaks German", () => {
    const markup = page([], "de");

    expect(markup).toContain("Dokumente");
    expect(markup).toContain("Technische Details");
    expect(markup).toContain('aria-label="Alle Werkzeuge von Skills"');
  });
});
