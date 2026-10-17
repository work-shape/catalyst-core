import { createElement, createRef } from "react";
import { describe, expect, it } from "vitest";
import type { ConfigAssetReferences, LocaleCode } from "@work-shape/catalyst-api-client";
import type { ConnectionToolsRead } from "@work-shape/catalyst-chat-ui/build-area";
import {
  AgentEditor,
  agentConfigToForm,
  agentFormToConfig,
  editedAgentConfig,
  heldToolCount,
  packageSwitchState,
  setPackageTools,
  toolPackages,
  withImpliedTools,
  type BuildAssetEditorProps
} from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The tools on an agent's page as rows (TOOLS-1, variant A): a row per package, per own tool of
// this instance and per Connection, those the agent uses none of too, each with how many of its
// tools are on and a switch that is mixed while only some are, the id where a tool has no title,
// and `read_skill` held because the agent has skills. Without them the page showed one flat list
// of ids.

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

const crmConnection: ConnectionToolsRead = {
  status: "ready",
  connections: [
    {
      name: "crm",
      title: "CRM",
      connectorType: "mcp",
      tools: [
        {
          toolName: "connection.crm.find_customer",
          operation: "find_customer",
          description: "Finds a customer.",
          effect: "reading"
        },
        {
          toolName: "connection.crm.update_customer",
          operation: "update_customer",
          effect: "changing"
        }
      ]
    }
  ]
};

function packages(input: {
  selected?: string[];
  skillNames?: string[];
  locale?: LocaleCode;
  references?: ConfigAssetReferences;
  connections?: ConnectionToolsRead;
}) {
  return toolPackages({
    references: input.references ?? described,
    selected: input.selected ?? [],
    skillNames: input.skillNames ?? [],
    locale: input.locale ?? "en",
    ...(input.connections ? { connections: input.connections } : {}),
    isOtherSource: (name) => name.startsWith("app.")
  });
}

const byKey = (view: ReturnType<typeof packages>, key: string) =>
  view.find((item) => item.key === key);

describe("the rows of the Tools section", () => {
  it("has a row per package in the page's order, then one per own tool, then one per Connection", () => {
    const view = packages({ connections: crmConnection });

    expect(view.map((item) => item.key)).toEqual([
      "package:documents",
      "package:web",
      "package:files",
      "package:skills",
      "own:crm.lookup",
      "connection:crm"
    ]);
    expect(byKey(view, "package:skills")?.tools.map((tool) => tool.name)).toEqual([
      "read_skill",
      "propose_skill_change"
    ]);
    // A Connection's operations are its tools, named by the operation.
    expect(byKey(view, "connection:crm")).toMatchObject({
      kind: "connection",
      title: "CRM",
      connection: { name: "crm", connectorType: "mcp" },
      choosable: ["connection.crm.find_customer", "connection.crm.update_customer"]
    });
    expect(byKey(view, "connection:crm")?.tools[0]).toMatchObject({
      title: "find_customer",
      summary: "Finds a customer.",
      effect: "reading"
    });
  });

  it("shows the title and summary in the reader's language, and the id where the title is missing", () => {
    const en = packages({});
    const de = packages({ locale: "de" });

    expect(byKey(en, "package:documents")?.tools[0]).toMatchObject({
      title: "Read document text",
      summary: "Reads the text of a document attached to the conversation.",
      module: "documents",
      effect: "reading"
    });
    expect(byKey(de, "package:documents")?.tools[0]).toMatchObject({ title: "Dokumenttext lesen" });
    const exec = byKey(en, "package:files")?.tools[0];
    expect(exec?.title).toBe("workspace.exec");
    expect(exec).not.toHaveProperty("summary");
    // A deployment's tool without wording is a row of its own, named by its id.
    expect(byKey(en, "own:crm.lookup")).toMatchObject({ kind: "own", title: "crm.lookup" });
  });

  it("lists every offered tool by its name where the server describes none", () => {
    const view = packages({
      references: references({ enabledToolNames: ["read_skill", "show_view"] })
    });

    expect(view.map((item) => item.key)).toEqual(["own:read_skill", "own:show_view"]);
    expect(view.map((item) => item.title)).toEqual(["read_skill", "show_view"]);
  });

  it("keeps a tool the agent holds that nothing offers, and leaves App tools to their group", () => {
    const view = packages({ selected: ["legacy.tool", "connection.crm.lookup", "app.offer.save"] });

    expect(view.filter((item) => item.kind === "own").map((item) => item.key)).toEqual([
      "own:crm.lookup",
      "own:legacy.tool"
    ]);
    expect(byKey(view, "own:legacy.tool")?.heldCount).toBe(1);
    // A Connection's tool stands with its Connection, an App's with the Apps.
    const names = view.flatMap((item) => item.tools.map((tool) => tool.name));
    expect(names).not.toContain("connection.crm.lookup");
    expect(names).not.toContain("app.offer.save");
  });

  it("counts what is on, so a row shows 1/2 while partly on, and the heading adds the rows up", () => {
    const view = packages({
      selected: ["read_skill", "web_fetch", "connection.crm.find_customer"],
      connections: crmConnection
    });

    expect(byKey(view, "package:skills")).toMatchObject({ heldCount: 1, tools: { length: 2 } });
    expect(byKey(view, "package:web")).toMatchObject({ heldCount: 1, tools: { length: 1 } });
    expect(byKey(view, "connection:crm")?.heldCount).toBe(1);
    // A row the agent uses none of stays, at 0.
    expect(byKey(view, "package:documents")?.heldCount).toBe(0);
    expect(heldToolCount(view)).toBe(3);
  });

  it("switches a row's tools all on and all off, mixed while only some are on", () => {
    const view = packages({ selected: ["web_fetch", "read_skill"] });
    const skills = byKey(view, "package:skills");
    if (!skills) throw new Error("no skills package");

    expect(packageSwitchState(skills, ["web_fetch", "read_skill"])).toBe("mixed");
    expect(packageSwitchState(skills, ["read_skill", "propose_skill_change"])).toBe("on");
    expect(packageSwitchState(skills, [])).toBe("off");
    // On adds what is missing and keeps the order of the rest; off removes only the row's.
    expect(setPackageTools(["web_fetch", "read_skill"], skills, true)).toEqual([
      "web_fetch",
      "read_skill",
      "propose_skill_change"
    ]);
    expect(setPackageTools(["web_fetch", "read_skill"], skills, false)).toEqual(["web_fetch"]);
  });
});

describe("tools an agent holds because of something else", () => {
  it("shows read_skill as included, with no check box, while the agent has a skill", () => {
    const skills = byKey(packages({ skillNames: ["tax-review"] }), "package:skills");

    expect(skills?.tools.find((tool) => tool.name === "read_skill")?.includedBecause).toBe(
      "skills"
    );
    // Adding and removing reach only what has a check box; read_skill counts as held.
    expect(skills?.choosable).toEqual(["propose_skill_change"]);
    expect(skills?.heldCount).toBe(1);
    // Without a skill it is a check box like any other.
    expect(byKey(packages({}), "package:skills")?.tools[0]?.includedBecause).toBeUndefined();
  });

  it("saves read_skill with an agent that has a skill, once", () => {
    expect(withImpliedTools(["web_fetch"], ["tax-review"], [])).toEqual([
      "web_fetch",
      "read_skill"
    ]);
    expect(withImpliedTools(["read_skill"], ["tax-review"], [])).toEqual(["read_skill"]);
    expect(withImpliedTools(["web_fetch"], [], [])).toEqual(["web_fetch"]);

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

describe("the fact sheet, one check box for keeping and reading it", () => {
  const resultTools = [
    { name: "show_view", group: "results", effect: "reading" },
    { name: "workspace.open", group: "results", effect: "changing" },
    {
      name: "structured_data.publish",
      title: { en: "Keep a fact sheet", de: "Faktenblatt führen" },
      group: "results",
      effect: "changing"
    },
    {
      name: "structured_data.read",
      title: { en: "Read the fact sheet", de: "Faktenblatt lesen" },
      group: "results",
      effect: "reading"
    },
    {
      name: "structured_result.read",
      title: { en: "Reopen an earlier result", de: "Früheres Ergebnis öffnen" },
      group: "results",
      effect: "reading"
    }
  ] satisfies ConfigAssetReferences["tools"];
  const offering = (names: string[]) =>
    references({
      enabledToolNames: names,
      tools: resultTools.filter((tool) => names.includes(tool.name))
    });
  const both = offering(resultTools.map((tool) => tool.name));
  const publishOnly = offering(
    resultTools.map((tool) => tool.name).filter((name) => name !== "structured_data.read")
  );
  const resultsPackage = (selected: string[], offered = both) =>
    byKey(packages({ references: offered, selected }), "package:results");
  const stored = (toolNames: string[]) => ({
    name: "assistant",
    displayName: "Assistant",
    instructions: "Help.",
    toolNames,
    skillNames: [],
    initialPrompts: []
  });
  /** What the agent page saves: the stored agent with its form changed by `edit`. */
  const save = (
    toolNames: string[],
    edit: (form: ReturnType<typeof agentConfigToForm>) => ReturnType<typeof agentConfigToForm>,
    offered = both
  ) => {
    const config = stored(toolNames);
    return editedAgentConfig(edit(agentConfigToForm(config)), config, offered.enabledToolNames)
      .toolNames;
  };
  const newInstructions = (form: ReturnType<typeof agentConfigToForm>) => ({
    ...form,
    instructions: "Help more."
  });

  it("shows four tools in Results, reading the fact sheet within keeping it", () => {
    const view = resultsPackage(["structured_data.publish", "structured_data.read"]);

    expect(view?.tools.map((tool) => tool.name)).toEqual([
      "show_view",
      "workspace.open",
      "structured_data.publish",
      "structured_result.read"
    ]);
    expect(view?.tools.find((tool) => tool.name === "structured_data.publish")?.title).toBe(
      "Keep a fact sheet"
    );
    expect(view?.choosable).not.toContain("structured_data.read");
    expect(view?.heldCount).toBe(1);
    // The section's count takes the pair as one tool too.
    expect(
      heldToolCount(
        packages({
          references: both,
          selected: ["structured_data.publish", "structured_data.read"]
        })
      )
    ).toBe(1);
  });

  it("shows the box on for a stored agent that holds only the keeping", () => {
    expect(resultsPackage(["structured_data.publish"])?.heldCount).toBe(1);
    expect(resultsPackage(["structured_data.read"])?.heldCount).toBe(0);
  });

  it("saves keeping and reading together, also when only another field changed", () => {
    // A stored agent of one half is saved as the pair or as neither, as its box shows.
    expect(save(["web_fetch", "structured_data.publish"], newInstructions)).toEqual([
      "web_fetch",
      "structured_data.publish",
      "structured_data.read"
    ]);
    expect(save(["web_fetch", "structured_data.read"], newInstructions)).toEqual(["web_fetch"]);
    // The pair as stored stays as stored.
    expect(save(["structured_data.read", "structured_data.publish"], newInstructions)).toEqual([
      "structured_data.read",
      "structured_data.publish"
    ]);
  });

  it("turns both on with the box and both off without it", () => {
    const keepBox = { choosable: ["structured_data.publish"] };
    expect(
      save([], (form) => ({ ...form, toolNames: setPackageTools(form.toolNames, keepBox, true) }))
    ).toEqual(["structured_data.publish", "structured_data.read"]);
    expect(
      save(["structured_data.publish", "structured_data.read"], (form) => ({
        ...form,
        toolNames: setPackageTools(form.toolNames, keepBox, false)
      }))
    ).toEqual([]);
    // The whole package on gives both too.
    const view = resultsPackage([]);
    if (!view) throw new Error("no results package");
    expect(
      save([], (form) => ({ ...form, toolNames: setPackageTools(form.toolNames, view, true) }))
    ).toContain("structured_data.read");
  });

  it("offers keeping alone where the instance does not offer reading", () => {
    const view = resultsPackage([], publishOnly);
    if (!view) throw new Error("no results package");
    expect(view.choosable).toContain("structured_data.publish");
    expect(view.tools.map((tool) => tool.name)).not.toContain("structured_data.read");
    // Its box adds the keeping only, so the server is never asked for a tool it lacks.
    expect(
      save(
        [],
        (form) => ({ ...form, toolNames: setPackageTools(form.toolNames, view, true) }),
        publishOnly
      )
    ).not.toContain("structured_data.read");
    expect(save(["structured_data.publish"], newInstructions, publishOnly)).toEqual([
      "structured_data.publish"
    ]);
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
      actions: {},
      notice: null,
      onUnsavedChange: noop,
      save: async () => ({ ok: true })
    };
  }

  function page(
    toolNames: string[],
    locale: LocaleCode = "en",
    canEdit = true,
    references: { value?: ConfigAssetReferences; loading?: boolean } = { value: described }
  ): string {
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
          references: references.value,
          referencesLoading: references.loading ?? false,
          editableAgentFields: canEdit ? ["toolNames"] : [],
          canManageAgentModels: false,
          skillChoice: { options: [], onSearch: noop },
          connectionTools: { read: crmConnection }
        })
      )
    );
  }

  const row = (markup: string, key: string) =>
    new RegExp(`data-tool-package="${key}"[\\s\\S]*?</li>`, "u").exec(markup)?.[0] ?? "";

  it("shows a row per package, its count, and a switch that is mixed while partly on", () => {
    const markup = page(["read_skill", "web_fetch", "connection.crm.find_customer"]);

    expect(markup).toContain(
      "What the agent can do. It always acts with the rights of the person it works for."
    );
    // Every package stands, the one the agent uses none of too, and the Connection.
    for (const key of ["package:documents", "package:web", "package:skills", "connection:crm"]) {
      expect(markup).toContain(`data-tool-package="${key}"`);
    }
    expect(row(markup, "package:documents")).toContain(">0/1<");
    expect(row(markup, "package:documents")).toContain('aria-checked="false"');
    expect(row(markup, "package:web")).toContain(">1/1<");
    expect(row(markup, "package:web")).toContain('aria-checked="true"');
    expect(row(markup, "package:skills")).toContain(">1/2<");
    expect(row(markup, "package:skills")).toContain('aria-checked="mixed"');
    expect(row(markup, "package:skills")).toContain('aria-label="All tools of Skills"');
    expect(row(markup, "package:skills")).toContain(
      "Reads its skills and proposes changes to them."
    );
    expect(row(markup, "connection:crm")).toContain(">1/2<");
    // The sub-headings of the instance's own tools and of the Connections.
    expect(markup).toContain(">This instance</h3>");
    expect(markup).toContain(">Connections</h3>");
    // The heading counts the tools that are on: what the rows add up to.
    expect(/>Tools<\/h2><span[^>]*>(\d+)</u.exec(markup)?.[1]).toBe("3");
    expect(markup).toContain("Technical details");
    // The tools stand folded in their row, so no id shows on the page at rest.
    expect(markup).not.toContain("propose_skill_change");
  });

  it("lets a reader fold the rows out but switch nothing", () => {
    const reader = page(["web_fetch"], "en", false);
    expect(row(reader, "package:web")).toMatch(/role="checkbox"[^>]*disabled=""/u);
    expect(row(reader, "package:web")).toContain('aria-expanded="false"');
  });

  it("waits for the references before it shows a row, and then shows the agent's own names if none came", () => {
    // On their way: the loading layout, and no tool by its id as a row of its own.
    const loading = page(["show_view", "read_skill"], "en", true, { loading: true });
    expect(loading).toContain("data-tool-loading");
    expect(loading).not.toContain("data-tool-package");
    // Refused: the agent's names stand by their ids, so nothing it holds is hidden.
    const refused = page(["show_view"], "en", true, {});
    expect(refused).not.toContain("data-tool-loading");
    expect(refused).toContain('data-tool-package="own:show_view"');
  });

  it("speaks German", () => {
    const markup = page(["web_fetch"], "de");

    expect(markup).toContain(">Web<");
    expect(markup).toContain(">Dieser Instanz</h3>");
    expect(markup).toContain(">Verbindungen</h3>");
    expect(markup).toContain('aria-label="Alle Werkzeuge von Web"');
    expect(markup).toContain("Technische Details");
    expect(markup).toContain(
      "Was der Agent tun kann. Er handelt immer mit den Rechten der Person, für die er arbeitet."
    );
  });
});
