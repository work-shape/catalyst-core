import { createElement, createRef, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { ConfigAssetReferences, LocaleCode } from "@vivd-catalyst/api-client";
import {
  AgentAvailabilityEditor,
  AgentEditor,
  agentConfigToForm,
  AssetEditorShell,
  FieldRefusals,
  refusalsOf,
  SkillEditor,
  skillConfigToForm,
  startedAgentForm,
  startedSkillForm,
  type AgentFormState,
  type BuildAsset,
  type BuildAssetEditorProps,
  type BuildWriteOutcome
} from "@vivd-catalyst/chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

const noop = () => undefined;
const saved = async (): Promise<BuildWriteOutcome> => ({ ok: true });

function storedAsset(kind: string, config: Record<string, unknown>): BuildAsset {
  return {
    id: `asset_${kind}`,
    kind,
    name: typeof config.name === "string" ? config.name : "",
    scope: { kind: "instance" },
    revision: 3,
    config,
    updatedAt: "2026-10-08T10:00:00.000Z"
  };
}

/** What the Build frame hands a kind's page. An asset stands for an open one, none for a new one. */
function frame(overrides: Partial<BuildAssetEditorProps> = {}): BuildAssetEditorProps {
  return {
    page: { ref: createRef<HTMLDivElement>(), above: null, shown: noop },
    asset: undefined,
    start: undefined,
    canWrite: true,
    instanceWrite: true,
    back: null,
    actions: null,
    notice: null,
    onUnsavedChange: noop,
    save: async () => ({ ok: true }),
    ...overrides
  };
}

function render(element: ReactElement, locale: LocaleCode = "en"): string {
  return renderToStaticMarkup(
    createElement(TranslationProvider, { children: null, locale }, element)
  );
}

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

const agentBase = {
  name: "assistant",
  displayName: "Assistant",
  instructions: "Help the user.",
  toolNames: [],
  skillNames: [],
  initialPrompts: []
};

interface AgentInput {
  config?: Record<string, unknown>;
  /** The form of a new agent. With it the page has no stored asset. */
  started?: AgentFormState;
  frame?: Partial<BuildAssetEditorProps>;
  references?: Partial<ConfigAssetReferences>;
  editableAgentFields?: string[];
  canManageAgentModels?: boolean;
  onMakeDefault?: () => Promise<string | undefined>;
  locale?: LocaleCode;
}

function agentPage(input: AgentInput = {}): string {
  const config = { ...agentBase, ...input.config };
  return render(
    createElement(AgentEditor, {
      frame: frame({
        ...(input.started
          ? { start: { name: input.started.name, title: "" } }
          : { asset: storedAsset("agent", config) }),
        ...input.frame
      }),
      initialForm: input.started ?? agentConfigToForm(config),
      isDefault: true,
      references: references(input.references),
      editableAgentFields: input.editableAgentFields ?? [],
      canManageAgentModels: input.canManageAgentModels ?? false,
      skillChoice: { options: [{ name: "tax-review", title: "Tax review" }], onSearch: noop },
      onMakeDefault: input.onMakeDefault
    }),
    input.locale
  );
}

/** One section of an asset page, by its anchor. */
function section(markup: string, id: string): string {
  return new RegExp(`<section[^>]*id="${id}">.*?</section>`, "u").exec(markup)?.[0] ?? "";
}

/** The input under a field's label. */
function inputOf(markup: string, label: string): string {
  return (
    new RegExp(`<span class="min-w-0">${label}</span>.*?(<input[^>]*>)`, "u").exec(markup)?.[1] ??
    ""
  );
}

describe("agent page", () => {
  it("shows configured runtime values while the agent is read-only", () => {
    const markup = agentPage({
      config: {
        description: "Help with the workflow.",
        modelProviderId: "azure-eu",
        reasoningEffort: "high",
        maxSteps: 128
      },
      references: { reasoningEfforts: ["none", "low", "medium", "high", "xhigh"] }
    });

    expect(markup).toContain("azure-eu");
    expect(markup).toContain('value="Help with the workflow."');
    expect(markup).toContain('<option value="high" selected="">high</option>');
    expect(markup).toContain('value="128"');
    expect(markup).not.toContain("Save changes");
    expect(markup).toContain("You can read this but not change it.");
  });

  it("says that the page is read-only to a reader who may not write the agent", () => {
    const editable = { editableAgentFields: ["displayName", "toolNames"] };
    const writer = agentPage(editable);
    const reader = agentPage({ ...editable, frame: { canWrite: false } });

    expect(writer).not.toContain("You can read this but not change it.");
    expect(inputOf(writer, "Display name")).not.toContain('disabled=""');
    expect(reader).toContain("You can read this but not change it.");
    // A field that is only read is read-only, not disabled, and asks for nothing.
    expect(inputOf(reader, "Display name")).toContain('readOnly=""');
    expect(inputOf(reader, "Display name")).not.toContain('disabled=""');
    expect(inputOf(reader, "Display name")).not.toContain('required=""');
    // A new agent the reader may not write has nothing to create either.
    expect(
      agentPage({
        ...editable,
        started: startedAgentForm({ name: "tax-a", title: "A" }, "en"),
        frame: { canWrite: false }
      })
    ).not.toContain('type="submit"');
  });

  it("shows a tool of a module that is off as selected, unavailable and removable", () => {
    const markup = agentPage({
      config: { modelProviderId: "azure-eu", toolNames: ["read_skill", "documents.read"] },
      references: {
        enabledToolNames: ["read_skill"],
        moduleOffTools: [
          { name: "documents.read", module: "documents" },
          { name: "documents.search", module: "documents" }
        ]
      },
      editableAgentFields: ["toolNames"]
    });

    expect(markup).toContain('data-unavailable-option="documents.read"');
    expect(markup).toContain("Not available: the module Documents is off. Remove it to save.");
    expect(section(markup, "tools")).toContain('aria-label="Remove"');
    // A tool of the module that the agent does not name is not shown at all.
    expect(markup).not.toContain("documents.search");
  });

  it("keeps a tool the agent names and the reader was not told of", () => {
    const tools = section(
      agentPage({
        config: { toolNames: ["read_skill", "crm.lookup"] },
        references: { enabledToolNames: ["read_skill"] }
      }),
      "tools"
    );

    expect(tools).toContain("crm.lookup");
    expect(tools).not.toContain("data-unavailable-option");
  });

  it("does not expose a model binding control for a legacy provider-only edit policy", () => {
    const markup = agentPage({
      config: { modelProviderId: "azure-eu" },
      references: {
        modelBindingIds: ["reasoning"],
        modelBindings: [{ id: "reasoning", model: "gpt-5" }]
      },
      editableAgentFields: ["modelProviderId"]
    });
    const model = section(markup, "model");

    expect(model).toContain("Instance default (azure-eu)");
    expect(model.match(/<select[^>]*>/gu)?.every((select) => select.includes('disabled=""'))).toBe(
      true
    );
    // The binding is no row of its own: the reader cannot offer it.
    expect(model).not.toContain("data-model-binding");
  });

  it("makes model, reasoning effort and fast mode editable by permission, not by edit policy", () => {
    const page = (canManageAgentModels: boolean, modelBindingId = "fast") =>
      section(
        agentPage({
          config: {
            modelBindingId,
            reasoningEffort: "high",
            fastMode: modelBindingId === "fast"
          },
          references: {
            modelBindingIds: ["fast", "plain"],
            modelBindings: [
              { id: "fast", model: "gpt-fast" },
              { id: "plain", model: "gpt-plain" }
            ],
            fastModeModelBindingIds: ["fast"],
            reasoningEfforts: ["low", "high"]
          },
          // The legacy entries no longer make the model settings editable.
          editableAgentFields: canManageAgentModels ? [] : ["modelBindingId", "reasoningEffort"],
          canManageAgentModels
        }),
        "model"
      );
    const fastSwitch = (markup: string) => /<button[^>]*role="switch"[^>]*>/u.exec(markup)?.[0];
    const effortSelect = (markup: string) =>
      /<select[^>]*aria-label="Default model: Reasoning effort"[^>]*>/u.exec(markup)?.[0];
    const defaultSelect = (markup: string) =>
      /(<select[^>]*>)<option value="">Instance default/u.exec(markup)?.[1];

    const editable = page(true);
    expect(editable).toContain('<option value="fast" selected="">GPT-fast</option>');
    expect(defaultSelect(editable)).not.toContain('disabled=""');
    expect(effortSelect(editable)).not.toContain('disabled=""');
    expect(fastSwitch(editable)).toContain('aria-checked="true"');
    expect(fastSwitch(editable)).not.toContain('disabled=""');
    expect(editable).toContain("Fast runs are billed at a higher rate.");
    expect(editable).toContain('data-model-binding="plain"');

    const readOnly = page(false);
    expect(readOnly).toContain('<option value="fast" selected="">GPT-fast</option>');
    expect(defaultSelect(readOnly)).toContain('disabled=""');
    // A model the agent does not offer is no row for a reader who cannot offer it.
    expect(readOnly).not.toContain('data-model-binding="plain"');
    expect(effortSelect(readOnly)).toContain('disabled=""');
    expect(fastSwitch(readOnly)).toContain('disabled=""');

    // No fast-mode control for a binding that does not support it.
    expect(fastSwitch(page(true, "plain"))).toBeUndefined();
  });

  it("shows the agent's default model and the models people can choose beside it", () => {
    const page = (
      canManageAgentModels: boolean,
      modelBindingId: string,
      userSelectableModelBindingIds: string[]
    ) =>
      section(
        agentPage({
          config: {
            ...(modelBindingId ? { modelBindingId } : {}),
            userSelectableModelBindingIds,
            reasoningEffort: "high",
            modelReasoningEfforts: { terra: "low" }
          },
          references: {
            modelProviderIds: ["openai"],
            modelBindingIds: ["sol", "terra", "luna"],
            modelBindings: [
              { id: "sol", model: "gpt-5.6-sol" },
              { id: "terra", model: "gpt-5.6-terra" },
              { id: "luna", model: "gpt-5.6-luna" }
            ],
            reasoningEfforts: ["low", "high"]
          },
          canManageAgentModels
        }),
        "model"
      );
    const chosen = (select: string | undefined) =>
      /<option value="([^"]*)" selected="">/u.exec(select ?? "")?.[1] ?? "";
    const disabled = (tag: string | undefined) => (tag?.includes('disabled=""') ? "disabled" : "");
    /** The default model with its effort, then one line per model beside it. */
    const models = (markup: string) => {
      const [head = "", ...rows] = markup.split('data-model-binding="');
      const [defaultModel, defaultEffort] = [...head.matchAll(/<select[^>]*>.*?<\/select>/gu)].map(
        ([select]) => select
      );
      return [
        ["default", chosen(defaultModel), chosen(defaultEffort), disabled(defaultModel)].join("|"),
        ...rows.map((row) => {
          const checkbox = /<button[^>]*role="checkbox"[^>]*>/u.exec(row)?.[0];
          const effort = /<select[^>]*>.*?<\/select>/u.exec(row)?.[0];
          return [
            row.slice(0, row.indexOf('"')),
            checkbox?.includes('aria-checked="true"') ? "offered" : "",
            effort === undefined ? "no effort" : chosen(effort),
            disabled(checkbox)
          ].join("|");
        })
      ];
    };

    const editable = page(true, "sol", ["terra", "retired"]);
    expect(models(editable)).toEqual([
      "default|sol|high|",
      "terra|offered|low|",
      // A model that is not offered has no effort control.
      "luna||no effort|"
    ]);
    expect(editable).toContain(">Models people can choose in chat<");
    expect(editable).toContain('aria-label="GPT-5.6 Terra: Reasoning effort"');
    expect(editable).not.toContain("retired");
    expect(editable).toContain(
      "Users only see a model selector in the chat when at least one additional model is ticked."
    );

    // On the instance default every binding can still be offered.
    expect(models(page(true, "", ["luna"]))).toEqual([
      "default||high|",
      "sol||no effort|",
      "terra||no effort|",
      "luna|offered||"
    ]);

    // Without the permission: only the default and the offered models, all read-only.
    expect(models(page(false, "sol", ["terra"]))).toEqual([
      "default|sol|high|disabled",
      "terra|offered|low|disabled"
    ]);
    expect(models(page(false, "", []))).toEqual(["default||high|disabled"]);
  });

  it("leaves the model section out where the agent names no model and the reader may set none", () => {
    const markup = agentPage({
      references: { modelBindingIds: ["sol"], modelBindings: [{ id: "sol", model: "gpt-5.6-sol" }] }
    });

    expect(section(markup, "model")).toBe("");
    expect(markup).not.toContain('href="#model"');
    expect(agentPage({ canManageAgentModels: true })).toContain('href="#model"');
  });

  it("lists the sections in the page's outline, with how many things each one holds", () => {
    const markup = agentPage({
      config: {
        toolNames: ["read_skill", "show_view"],
        skillNames: ["tax-review"],
        initialPrompts: []
      },
      canManageAgentModels: true
    });
    const index = /<nav aria-label="On this page".*?<\/nav>/u.exec(markup)?.[0] ?? "";
    const entries = [...index.matchAll(/<a href="#([^"]*)"[^>]*>(.*?)<\/a>/gu)].map(
      ([, id, body = ""]) =>
        `${id}: ${body
          .replace(/<[^>]*>/gu, " ")
          .replace(/\s+/gu, " ")
          .trim()}`
    );

    expect(entries).toEqual([
      "overview: Overview",
      "instructions: Instructions",
      "model: Model",
      "skills: Skills 1",
      "tools: Tools 2",
      "prompts: Starter prompts 0"
    ]);
    // The sections are no list of pages: nothing of the kinds' rail is on the page.
    expect(markup).not.toContain("data-sub-rail");
    // Every entry of the outline leads to a section of the page.
    for (const id of ["overview", "instructions", "model", "skills", "tools", "prompts"]) {
      expect(section(markup, id)).not.toBe("");
    }
    // The availability is a section only where the frame hands one.
    expect(markup).not.toContain('href="#availability"');
  });

  it("names the skills an agent has by their titles, and falls back to the id", () => {
    const skillsOf = (editableAgentFields: string[]) =>
      section(
        agentPage({
          config: { skillNames: ["tax-review", "gone_skill"], toolNames: [] },
          editableAgentFields
        }),
        "skills"
      );

    expect(skillsOf(["skillNames"])).toContain(">Tax review<");
    expect(skillsOf(["skillNames"])).toContain(">gone_skill<");
    expect(skillsOf(["skillNames"])).toContain("Choose skills");
    expect(skillsOf(["skillNames"])).toContain('aria-label="Remove"');
    expect(skillsOf(["skillNames"])).toContain("read_skill");
    // Read-only, the skills are named and can be neither removed nor added.
    expect(skillsOf([])).toContain(">Tax review<");
    expect(skillsOf([])).not.toContain("Choose skills");
    expect(skillsOf([])).not.toContain('aria-label="Remove"');
    expect(section(agentPage(), "skills")).toContain("No skills chosen.");
  });

  it("offers to make the agent the default only where the frame hands the way", () => {
    expect(agentPage({ onMakeDefault: async () => undefined })).toContain("Make default");
    expect(agentPage()).not.toContain("Make default");
    expect(agentPage()).toContain(">Default agent<");
  });
});

describe("texts per language", () => {
  const config = {
    displayName: { de: "Assistent" },
    description: { en: "Help with the workflow.", de: "Hilfe beim Workflow." },
    welcomeMessage: { en: "How can I help?" },
    initialPrompts: [{ title: { en: "Weather" }, prompt: { en: "Check the weather." } }]
  };
  const editable = ["displayName", "description", "welcomeMessage", "initialPrompts"];
  const page = (locale: LocaleCode) => agentPage({ config, editableAgentFields: editable, locale });
  const language = (markup: string, value: string) =>
    new RegExp(`<button[^>]*role="radio"[^>]*value="${value}"[^>]*>.*?</button>`, "u").exec(
      markup
    )?.[0] ?? "";

  it("shows one language at a time, the reader's own first", () => {
    const english = page("en");
    const german = page("de");

    expect(language(english, "en")).toContain('aria-checked="true"');
    expect(language(english, "de")).toContain('aria-checked="false"');
    expect(language(german, "de")).toContain('aria-checked="true"');
    expect(inputOf(english, "Description")).toContain('lang="en"');
    expect(inputOf(english, "Description")).toContain('value="Help with the workflow."');
    expect(english).not.toContain("Hilfe beim Workflow.");
    expect(inputOf(german, "Beschreibung")).toContain('lang="de"');
    expect(inputOf(german, "Beschreibung")).toContain('value="Hilfe beim Workflow."');
    expect(german).not.toContain("Help with the workflow.");
  });

  it("shows the other language's text as the placeholder of an empty one, and says so", () => {
    const english = page("en");
    const german = page("de");
    const name = inputOf(english, "Display name");

    expect(name).toContain('value=""');
    expect(name).toContain('placeholder="Assistent"');
    // The text people read comes from the other language, so the empty field is not required.
    expect(name).not.toContain('required=""');
    expect(section(english, "overview")).toContain(
      "Empty in this language. People read the German text."
    );
    expect(section(english, "overview")).not.toContain("People read the English text.");
    expect(inputOf(german, "Begrüßungsnachricht")).toContain('placeholder="How can I help?"');
    expect(section(german, "overview")).toContain(
      "In dieser Sprache leer. Es wird der englische Text gezeigt."
    );
    // A text written in both languages, and one written in neither, has no hint.
    expect(inputOf(english, "Description")).toContain('placeholder=""');
    expect(inputOf(english, "Welcome subtitle")).toContain('placeholder=""');
    expect(section(english, "overview").match(/Empty in this language/gu)).toHaveLength(1);
  });

  it("counts on the switch how many texts the other language still lacks", () => {
    // German lacks the welcome message and both texts of the starter prompt, English the name.
    expect(language(page("en"), "de")).toContain(">3<");
    expect(language(page("en"), "de")).toContain('title="3 texts are empty in this language"');
    expect(language(page("en"), "en")).not.toMatch(/>\d+</u);
    expect(language(page("de"), "en")).toContain(">1<");
  });

  it("has no language switch on a page without texts per language", () => {
    const markup = render(
      createElement(SkillEditor, {
        frame: frame({ start: { name: "review", title: "Review" } }),
        initialForm: startedSkillForm({ name: "review", title: "Review" }),
        editable: true
      })
    );

    expect(markup).not.toContain("Texts in");
    expect(markup).not.toContain('role="radio"');
  });
});

describe("save bar", () => {
  it("is absent on an agent nothing was changed on, and present on a new one", () => {
    const fields = { editableAgentFields: ["displayName"], canManageAgentModels: true };
    const existing = agentPage(fields);
    const started = agentPage({
      ...fields,
      started: startedAgentForm({ name: "tax-assistant", title: "Tax assistant" }, "en")
    });

    expect(existing).not.toContain('type="submit"');
    expect(existing).not.toContain("Save changes");
    expect(existing).not.toContain("Applies to new conversations immediately.");
    expect(started).toMatch(/<button[^>]*type="submit"[^>]*>Create agent<\/button>/u);
    expect(started).toContain("Applies to new conversations immediately.");
    // A new asset has nothing to go back to and no count of changes.
    expect(started).not.toContain("Discard");
    expect(started).not.toMatch(/\d+ changes?/u);
    // The id stands once, in the first section with a copy button, and not in the head.
    expect(started.match(/>tax-assistant<\/code>/gu)).toHaveLength(1);
    expect(started.indexOf("data-asset-identifier")).toBeGreaterThan(started.indexOf("</header>"));
    expect(started).toMatch(/data-asset-identifier[^]*?<button[^>]*aria-label="Copy"/u);
    expect(inputOf(started, "Display name")).toContain('value="Tax assistant"');
  });

  it("is absent on a skill nothing was changed on, and present on a new one", () => {
    const config = { name: "review", title: "Review", description: "How to review", content: "#" };
    const existing = render(
      createElement(SkillEditor, {
        frame: frame({ asset: storedAsset("skill", config) }),
        initialForm: skillConfigToForm(config),
        editable: true
      })
    );
    const started = render(
      createElement(SkillEditor, {
        frame: frame({ start: { name: "tax-review", title: "Tax review" } }),
        initialForm: startedSkillForm({ name: "tax-review", title: "Tax review" }),
        editable: true
      })
    );

    expect(existing).not.toContain('type="submit"');
    expect(existing).toContain("Add reference");
    expect(started).toMatch(/<button[^>]*type="submit"[^>]*>Create skill<\/button>/u);
    // The head is one row: a long name is cut and says itself whole in a tooltip.
    expect(started).toContain(
      '<h1 class="min-w-0 truncate outline-none text-title" title="Tax review">Tax review'
    );
    expect(started).toMatch(/<header data-variant="detail" class="[^"]*\bmd:flex-nowrap\b/u);
  });
});

describe("refused save", () => {
  const outcome: BuildWriteOutcome = {
    ok: false,
    conflict: false,
    refusals: [
      { field: "tools", message: "The tool documents.read is not allowed in Namespace tax-." },
      { message: "The change would break an asset the caller may not read" }
    ]
  };
  const page = (
    answer: BuildWriteOutcome | undefined,
    input: Partial<BuildAssetEditorProps> = {}
  ) =>
    render(
      createElement(AssetEditorShell, {
        frame: frame({ asset: storedAsset("agent", agentBase), ...input }),
        title: "Assistant",
        sections: [
          { id: "details", label: "Details", body: createElement("p", null, "Fields") },
          {
            id: "tools",
            label: "Tools",
            refusalField: "tools",
            body: createElement(FieldRefusals, { messages: refusalsOf(answer, "tools") })
          }
        ],
        control: { changes: 0, submit: saved, discard: noop },
        outcome: answer,
        saving: false,
        saveLabel: "Save changes"
      })
    );

  it("says a refusal that names the tools under the tools, and nowhere else", () => {
    const markup = page(outcome);
    const tools = section(markup, "tools");

    expect(tools).toContain('data-field-refusal=""');
    expect(tools).toContain("The tool documents.read is not allowed in Namespace tax-.");
    expect(markup.match(/The tool documents\.read is not allowed/gu)).toHaveLength(1);
    expect(markup.match(/data-field-refusal/gu)).toHaveLength(1);
    expect(section(markup, "details")).not.toContain("data-field-refusal");
  });

  it("marks the section a refusal names in the page's outline, and no other", () => {
    const linkTo = (markup: string, id: string) =>
      new RegExp(`<a href="#${id}"[^>]*>.*?</a>`, "u").exec(markup)?.[0] ?? "";
    const refused = page(outcome);

    expect(linkTo(refused, "tools")).toContain('data-invalid=""');
    expect(linkTo(refused, "tools")).toContain("Has an error");
    expect(linkTo(refused, "details")).not.toContain("data-invalid");
    expect(refused.match(/data-invalid=""/gu)).toHaveLength(1);
    expect(page({ ok: true })).not.toContain("data-invalid");
  });

  it("says a refusal that names no field after the sections, as the instance said it", () => {
    const markup = page(outcome);
    const after = markup.slice(markup.lastIndexOf("</section>"));

    expect(after).toContain("The change would break an asset the caller may not read");
    expect(after).not.toContain("data-field-refusal");
    // It shows to a reader too, who has no save bar.
    expect(page(outcome, { canWrite: false })).toContain(
      "The change would break an asset the caller may not read"
    );
  });

  it("shows nothing of a refusal on a page whose save went through", () => {
    const answers: (BuildWriteOutcome | undefined)[] = [
      undefined,
      { ok: true },
      { ok: false, conflict: true }
    ];
    for (const answer of answers) {
      const markup = page(answer);

      expect(markup).not.toContain("data-field-refusal");
      expect(markup).not.toContain('role="alert"');
    }
  });

  it("shows what the frame says of a conflict above the save bar", () => {
    const markup = page(
      { ok: false, conflict: true },
      { notice: createElement("p", { "data-build-conflict": "" }, "Somebody saved this.") }
    );

    expect(markup.slice(markup.lastIndexOf("</section>"))).toContain("Somebody saved this.");
  });

  it("counts the changes beside the save button and offers to discard them", () => {
    const changed = (changes: number) =>
      render(
        createElement(AssetEditorShell, {
          frame: frame({ asset: storedAsset("agent", agentBase) }),
          title: "Assistant",
          sections: [{ id: "details", label: "Details", body: null }],
          control: { changes, submit: saved, discard: noop },
          outcome: undefined,
          saving: false,
          saveLabel: "Save changes"
        })
      );

    expect(changed(1)).toContain("1 change<");
    expect(changed(3)).toContain("3 changes<");
    expect(changed(3)).toContain("Discard");
    expect(changed(3)).toMatch(/<button[^>]*type="submit"[^>]*>Save changes<\/button>/u);
    expect(changed(0)).not.toContain("Save changes");
    // A page of one section has no index.
    expect(changed(0)).not.toContain("Sections of this page");
  });
});

describe("skill page", () => {
  const config = {
    name: "document_review",
    title: "Document review",
    description: "Review submitted documents.",
    content: "# Review",
    resources: [{ path: "references/checks.md", mediaType: "text/markdown", content: "# Checks" }]
  };
  const page = (input: { canWrite: boolean; editable: boolean }) =>
    render(
      createElement(SkillEditor, {
        frame: frame({ asset: storedAsset("skill", config), canWrite: input.canWrite }),
        initialForm: skillConfigToForm(config),
        editable: input.editable
      })
    );

  it("keeps a read-only skill package navigable without mutation controls", () => {
    // Read-only for the reader, and read-only because the instance does not let people edit.
    for (const markup of [
      page({ canWrite: false, editable: true }),
      page({ canWrite: true, editable: false })
    ]) {
      expect(markup).toContain("SKILL.md");
      expect(markup).toContain("references/checks.md");
      expect(markup).toContain("lucide-file-text");
      expect(markup).toMatch(/<textarea[^>]*readOnly=""[^>]*># Review<\/textarea>/u);
      expect(inputOf(markup, "Title")).toContain('readOnly=""');
      expect(inputOf(markup, "Title")).not.toContain('required=""');
      expect(markup).toContain("You can read this but not change it.");
      expect(markup).not.toContain("Add reference");
      expect(markup).not.toContain("Save changes");
    }
  });

  it("lets a writer change the package", () => {
    const markup = page({ canWrite: true, editable: true });

    expect(markup).not.toContain("You can read this but not change it.");
    expect(markup).toContain("Add reference");
    expect(markup).not.toMatch(/<textarea[^>]*readOnly=""/u);
    expect(inputOf(markup, "Title")).not.toContain('disabled=""');
    // The index counts the files of the package: the instructions and one reference.
    expect(markup).toMatch(/<a href="#instructions"[^>]*>.*?>2<\/span><\/a>/u);
  });
});

describe("agent availability", () => {
  const workspaces = [
    { id: "ws_sales", name: "Sales", createdAt: "2026-06-27T00:00:00.000Z" },
    { id: "ws_legal", name: "Legal", createdAt: "2026-06-27T00:00:00.000Z" }
  ];
  const stored = async () => undefined;

  it("offers personal and shared workspaces for a selectively available agent", () => {
    const markup = render(
      createElement(AgentAvailabilityEditor, {
        availability: {
          mode: "selected",
          personalWorkspaces: true,
          collaborationWorkspaceIds: ["ws_legal"]
        },
        isDefault: false,
        workspaces,
        mutating: false,
        onSave: stored
      })
    );

    expect(markup).toContain("Available in");
    expect(markup).toContain("Personal workspaces");
    expect(markup).toContain("Sales");
    expect(markup).toContain("Legal");
    expect(markup).not.toContain("ws_legal");
    expect(markup.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(2);
    expect(markup).toContain("Save availability");
    expect(markup).not.toContain("not available in any workspace");
  });

  it("locks the default agent to all workspaces and explains why", () => {
    const markup = render(
      createElement(AgentAvailabilityEditor, {
        availability: { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] },
        isDefault: true,
        workspaces,
        mutating: false,
        onSave: stored
      })
    );

    expect(markup).toMatch(/<div role="radiogroup"[^>]*data-disabled=""/u);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("The default agent is always available in all workspaces.");
    expect(markup).not.toContain("Save availability");
  });

  it("warns that an agent without any selection is hidden", () => {
    const markup = render(
      createElement(AgentAvailabilityEditor, {
        availability: undefined,
        isDefault: false,
        workspaces: [],
        mutating: false,
        onSave: stored
      })
    );

    expect(markup).toContain("There are no shared workspaces yet.");
    expect(markup).toContain("this agent is not available in any workspace");
  });

  it("says why the shared workspaces could not be listed", () => {
    const markup = render(
      createElement(AgentAvailabilityEditor, {
        availability: undefined,
        isDefault: false,
        workspaces: [],
        workspacesError: "The workspaces could not be read.",
        mutating: false,
        onSave: stored
      })
    );

    expect(markup).toContain("The workspaces could not be read.");
    expect(markup).not.toContain("There are no shared workspaces yet.");
  });
});
