import { createElement, createRef } from "react";
import { describe, expect, it } from "vitest";
import type { ConfigAssetReferences, LocaleCode } from "@vivd-catalyst/api-client";
import type { ConnectionToolsRead } from "@vivd-catalyst/chat-ui/build-area";
import {
  AgentEditor,
  agentConfigToForm,
  agentFormToConfig,
  setPackageTools,
  toolPackages,
  withImpliedTools,
  type BuildAssetEditorProps
} from "@vivd-catalyst/chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The tools on an agent's page as chips, the way its Skills are (TOOLS-1, variant B): a chip per
// package, per own tool of this instance and per Connection, the count on a chip that is partly
// on, the picker's offer, the id where a tool has no title, and `read_skill` held because the
// agent has skills. Without them the page showed one flat list of ids.

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

describe("the chips of the Tools section", () => {
  it("has a chip per package in the page's order, then one per own tool, then one per Connection", () => {
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
    // A deployment's tool without wording is a chip of its own, named by its id.
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

  it("counts what is on, so a chip shows 1/2 while partly on and the picker offers what is off", () => {
    const view = packages({
      selected: ["read_skill", "web_fetch", "connection.crm.find_customer"],
      connections: crmConnection
    });

    expect(byKey(view, "package:skills")).toMatchObject({ heldCount: 1, tools: { length: 2 } });
    expect(byKey(view, "package:web")).toMatchObject({ heldCount: 1, tools: { length: 1 } });
    expect(byKey(view, "connection:crm")?.heldCount).toBe(1);
    // Off, a chip is what the picker offers.
    expect(view.filter((item) => item.heldCount === 0).map((item) => item.key)).toEqual([
      "package:documents",
      "package:files",
      "own:crm.lookup"
    ]);
  });

  it("adds a chip with all its tools on and removes only its own", () => {
    const view = packages({ selected: ["web_fetch", "read_skill"] });
    const skills = byKey(view, "package:skills");
    if (!skills) throw new Error("no skills package");

    // Adding adds what is missing and keeps the order of the rest; removing removes only the chip's.
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

  function page(toolNames: string[], locale: LocaleCode = "en", canEdit = true): string {
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
          editableAgentFields: canEdit ? ["toolNames"] : [],
          canManageAgentModels: false,
          skillChoice: { options: [], onSearch: noop },
          connectionTools: { read: crmConnection }
        })
      )
    );
  }

  it("shows a chip per package in use, its count while partly on, and the picker to add more", () => {
    const markup = page(["read_skill", "web_fetch", "connection.crm.find_customer"]);

    expect(markup).toContain(
      "What the agent can do. It always acts with the rights of the person it works for."
    );
    expect(markup).toContain('data-tool-package="package:skills"');
    expect(markup).toContain('data-tool-package="package:web"');
    expect(markup).toContain('data-tool-package="connection:crm"');
    expect(markup).not.toContain('data-tool-package="package:documents"');
    // Skills is partly on, Web fully: only Skills shows its count.
    const chip = (key: string) =>
      new RegExp(`data-tool-package="${key}">.*?</li>`, "u").exec(markup)?.[0] ?? "";
    expect(chip("package:skills")).toContain("1/2");
    expect(chip("package:web")).not.toContain("1/1");
    expect(chip("connection:crm")).toContain("1/2");
    expect(chip("package:skills")).toContain('aria-label="Remove"');
    expect(markup).toContain("Add packages");
    expect(markup).toContain("Technical details");
    // The tools stand in the chip's panel, so no id shows on the page at rest.
    expect(markup).not.toContain("propose_skill_change");
    expect(markup).not.toContain("Skills require the read_skill tool");
  });

  it("says when no tool is chosen, and offers no picker and no removal to a reader", () => {
    expect(page([])).toContain("No tools chosen yet.");
    const reader = page(["web_fetch"], "en", false);
    expect(reader).toContain('data-tool-package="package:web"');
    expect(reader).not.toContain("Add packages");
    expect(reader).not.toContain('aria-label="Remove"');
  });

  it("speaks German", () => {
    const markup = page(["web_fetch"], "de");

    expect(markup).toContain(">Web<");
    expect(markup).toContain("Pakete hinzufügen");
    expect(markup).toContain("Technische Details");
    expect(markup).toContain(
      "Was der Agent tun kann. Er handelt immer mit den Rechten der Person, für die er arbeitet."
    );
  });
});
