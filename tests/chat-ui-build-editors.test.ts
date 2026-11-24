// @vitest-environment happy-dom

import { act, createElement, createRef, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigAssetReferences, LocaleCode } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
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
  type AgentUseChoice,
  type AvailabilityChoice,
  type BuildAsset,
  type BuildAssetEditorProps,
  type BuildWriteOutcome
} from "@work-shape/catalyst-chat-ui/build-area";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { listedKind, mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { settingsUser } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import { headMenuItems } from "./support/head-menu";

afterEach(unmountBuildPages);

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
    actions: {},
    notice: null,
    onUnsavedChange: noop,
    save: async () => ({ ok: true }),
    folder: { read: async () => [], save: saved },
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
  /** What the stored agent's read reports it names and the instance cannot run. */
  status?: Pick<
    BuildAsset,
    "unavailableTools" | "unavailableSkills" | "unavailableModels" | "chatAvailable"
  >;
  editableAgentFields?: string[];
  canManageAgentModels?: boolean;
  onMakeDefault?: () => Promise<string | undefined>;
  isDefault?: boolean;
  availability?: Partial<AvailabilityChoice>;
  agentUse?: AgentUseChoice;
  locale?: LocaleCode;
}

function agentPage(input: AgentInput = {}): string {
  return render(agentElement(input), input.locale);
}

function agentElement(input: AgentInput = {}): ReactElement {
  const config = { ...agentBase, ...input.config };
  return createElement(AgentEditor, {
    frame: frame({
      ...(input.started
        ? { start: { name: input.started.name, title: "" } }
        : { asset: { ...storedAsset("agent", config), ...input.status } }),
      ...input.frame
    }),
    initialForm: input.started ?? agentConfigToForm(config),
    isDefault: input.isDefault ?? true,
    references: references(input.references),
    editableAgentFields: input.editableAgentFields ?? [],
    canManageAgentModels: input.canManageAgentModels ?? false,
    skillChoice: { options: [{ name: "tax-review", title: "Tax review" }], onSearch: noop },
    onMakeDefault: input.onMakeDefault,
    ...(input.availability
      ? {
          availability: {
            saved: undefined,
            workspaces: [],
            save: async () => undefined,
            ...input.availability
          }
        }
      : {}),
    ...(input.agentUse ? { agentUse: input.agentUse } : {})
  });
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
  it("is read-only to a reader who may not write the agent, and offers a new one nothing to create", () => {
    const editable = { editableAgentFields: ["displayName", "toolNames"] };
    const writer = agentPage(editable);
    const reader = agentPage({ ...editable, frame: { canWrite: false } });

    expect(writer).not.toContain("You can read this but not change it.");
    expect(inputOf(writer, "Display name")).not.toContain('readOnly=""');
    expect(reader).toContain("You can read this but not change it.");
    expect(inputOf(reader, "Display name")).toContain('readOnly=""');
    expect(inputOf(reader, "Display name")).not.toContain('required=""');
    expect(
      agentPage({
        ...editable,
        started: startedAgentForm({ name: "tax-a", title: "A" }, "en"),
        frame: { canWrite: false }
      })
    ).not.toContain('type="submit"');
  });

  it("shows a tool the instance cannot run as unavailable and removable, and keeps one the reader was not told of", () => {
    const tools = (unavailable: BuildAsset["unavailableTools"]) =>
      section(
        agentPage({
          config: { toolNames: ["read_skill", "documents.read"] },
          references: { enabledToolNames: ["read_skill"] },
          status: unavailable ? { unavailableTools: unavailable } : {},
          editableAgentFields: ["toolNames"]
        }),
        "tools"
      );

    for (const reason of ["module_off", "unknown_tool"] as const) {
      const markup = tools([{ name: "documents.read", reason, module: "documents" }]);
      expect(markup).toContain('data-unavailable-option="documents.read"');
      expect(markup).toContain('aria-label="Remove"');
      expect(markup).not.toContain('data-tool-package="own:documents.read"');
    }
    // A tool the agent names that the read does not report stays a chip of its own.
    const kept = tools(undefined);
    expect(kept).toContain('data-tool-package="own:documents.read"');
    expect(kept).not.toContain("data-unavailable-option");
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
    const selects = (markup: string) => markup.match(/<select[^>]*>/gu) ?? [];

    const editable = page(true);
    expect(editable).toMatch(/<option value="fast" selected="">/u);
    expect(selects(editable).some((select) => select.includes('disabled=""'))).toBe(false);
    expect(fastSwitch(editable)).toContain('aria-checked="true"');
    expect(fastSwitch(editable)).not.toContain('disabled=""');
    expect(editable).toContain('data-model-binding="plain"');

    const readOnly = page(false);
    expect(readOnly).toMatch(/<option value="fast" selected="">/u);
    expect(selects(readOnly).every((select) => select.includes('disabled=""'))).toBe(true);
    expect(fastSwitch(readOnly)).toContain('disabled=""');
    // A model the agent does not offer is no row for a reader who cannot offer it.
    expect(readOnly).not.toContain('data-model-binding="plain"');

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
    expect(editable).not.toContain("retired");

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
    expect(section(agentPage({ canManageAgentModels: true }), "model")).not.toBe("");
  });

  it("names the skills an agent has by their titles, falls back to the id, and changes them only for a writer", () => {
    const skillsOf = (editableAgentFields: string[]) =>
      section(
        agentPage({
          config: { skillNames: ["tax-review", "gone_skill"], toolNames: [] },
          editableAgentFields
        }),
        "skills"
      );

    const writer = skillsOf(["skillNames"]);
    expect(writer).toContain(">Tax review<");
    expect(writer).toContain(">gone_skill<");
    expect(writer).toContain("Choose skills");
    expect(writer).toContain('aria-label="Remove"');
    const reader = skillsOf([]);
    expect(reader).toContain(">Tax review<");
    expect(reader).not.toContain("Choose skills");
    expect(reader).not.toContain('aria-label="Remove"');
  });

  it("offers to make the agent the default only where the frame hands the way", async () => {
    expect(await headMenuItems(agentElement({ onMakeDefault: async () => undefined }))).toContain(
      "Make default"
    );
    expect(await headMenuItems(agentElement())).not.toContain("Make default");
  });
});

// The page passes the reader's model-management permission through to the agent's form.
it.each([true, false])(
  "passes the reader's model-management permission to the actual agent editor (%s)",
  async (canManageModels) => {
    const asset: BuildAsset = {
      id: "asset_model_reader",
      kind: "agent",
      name: "model_reader",
      scope: { kind: "instance" },
      revision: 1,
      allowed: ["write"],
      updatedAt: "2026-10-01T08:00:00Z",
      config: { ...agentBase, name: "model_reader", modelBindingId: "primary" }
    };
    const container = await mountBuildPage(
      asset,
      "agents",
      (request, url) => {
        if (url.pathname === apiOperations["platform.references.get"].path)
          return Response.json(
            references({
              modelProviderIds: ["local"],
              modelBindingIds: ["primary"],
              modelBindings: [{ id: "primary", model: "gpt-primary" }]
            })
          );
        if (
          url.pathname ===
          apiOperations["agents.draft.get"].buildPath({ params: { name: asset.name } })
        )
          return Response.json({ draft: null });
        if (listedKind(request, url) !== undefined) return Response.json({ items: [] });
        return undefined;
      },
      ["displayName", "modelBindingId"],
      {
        user: settingsUser({
          roles: canManageModels ? ["superadmin"] : ["admin"],
          permissions: canManageModels
            ? ["config_assets.read", "config_assets.write", "agent_models.manage"]
            : ["config_assets.read", "config_assets.write"]
        })
      }
    );
    await vi.waitFor(
      async () => {
        await act(async () => {
          const model = required(
            container.querySelector<HTMLSelectElement>("section#model select")
          );
          expect(model.querySelector<HTMLOptionElement>('option[value="primary"]')?.selected).toBe(
            true
          );
          expect(model.disabled).toBe(!canManageModels);
        });
      },
      { timeout: CONDITION_WAIT_MS }
    );
  }
);

// Where an agent can be chosen: a section of the agent's page, saved with the agent through the
// page's save bar (AGENT-AVAIL-1).
describe("agent availability", () => {
  const sales = { id: "ws_sales", name: "Sales", createdAt: "2026-06-27T00:00:00.000Z" };
  const legal = { id: "ws_legal", name: "Legal", createdAt: "2026-06-27T00:00:00.000Z" };
  const availabilityOf = (availability: Partial<AvailabilityChoice>, isDefault = false) =>
    section(
      agentPage({ availability: { workspaces: [sales, legal], ...availability }, isDefault }),
      "availability"
    );
  const ticked = (markup: string) => markup.match(/type="checkbox"[^>]*checked=""/gu) ?? [];

  it("shows the saved choice by workspace name, with no save of its own", () => {
    const selected = availabilityOf({
      saved: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: ["ws_legal"] }
    });
    expect(selected).toContain("Legal");
    expect(selected).not.toContain("ws_legal");
    expect(ticked(selected)).toHaveLength(2);
    expect(selected).not.toContain("Save availability");

    const except = availabilityOf({
      saved: {
        mode: "all_except",
        personalWorkspaces: true,
        collaborationWorkspaceIds: ["ws_legal"]
      }
    });
    expect(except).toMatch(
      /value="all_except"[^>]*aria-checked="true"|aria-checked="true"[^>]*value="all_except"/u
    );
    expect(ticked(except)).toHaveLength(2);
  });

  it("never offers to exclude a workspace whose own default the agent is", () => {
    const section = availabilityOf({
      saved: { mode: "all_except", personalWorkspaces: true, collaborationWorkspaceIds: [] },
      workspaces: [sales, { ...legal, defaultAgentName: "assistant" }]
    });
    expect(section).toMatch(/<label[^>]*>(?:(?!<\/label>).)*Sales/u);
    expect(section).not.toMatch(/<label[^>]*>(?:(?!<\/label>).)*Legal/u);
  });

  // #334: with the agent the default everywhere, the list of workspaces to leave out was empty
  // without a word.
  it("says why no workspace can be left out when the agent is the default in every one", () => {
    const everywhere = {
      saved: { mode: "all_except", personalWorkspaces: true, collaborationWorkspaceIds: [] },
      workspaces: [sales, { ...legal, defaultAgentName: "assistant" }]
    } satisfies Partial<AvailabilityChoice>;
    // Sales names no default of its own, so the instance default stays there too.
    const en = availabilityOf(everywhere, true);
    expect(en).not.toMatch(/<label[^>]*>(?:(?!<\/label>).)*(?:Sales|Legal)/u);
    expect(en).toContain("This agent is the default agent in every shared workspace.");
    expect(en).not.toContain("There are no shared workspaces yet.");
    const failed = availabilityOf(
      { ...everywhere, workspacesError: "The workspaces could not be read." },
      true
    );
    expect(failed).toContain("The workspaces could not be read.");
    expect(failed).not.toContain("This agent is the default agent in every shared workspace.");
  });

  it("lets the default agent be restricted", () => {
    const section = availabilityOf(
      { saved: { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] } },
      true
    );
    expect(section).toContain('role="radiogroup"');
    expect(section).not.toMatch(/<div role="radiogroup"[^>]*data-disabled=""/u);
  });

  // Who uses the agent where it is available (AGENT-USE-1), for whoever sets that.
  it("offers who may use it only to a reader who sets availability, linking to the rights when limited", () => {
    const save = async () => undefined;
    const use = (agentUse: AgentUseChoice | undefined) =>
      section(
        agentPage({ availability: {}, isDefault: false, ...(agentUse ? { agentUse } : {}) }),
        "agent-use"
      );

    expect(use({ saved: "everyone", save })).not.toBe("");
    expect(use({ saved: "everyone", save })).not.toContain("/settings/instance/access");
    expect(use({ saved: "granted", save })).toContain('href="/settings/instance/access"');
    expect(use(undefined)).toBe("");
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
    expect(language(german, "de")).toContain('aria-checked="true"');
    expect(inputOf(english, "Description")).toContain('value="Help with the workflow."');
    expect(english).not.toContain("Hilfe beim Workflow.");
    expect(inputOf(german, "Beschreibung")).toContain('value="Hilfe beim Workflow."');
    expect(german).not.toContain("Help with the workflow.");
  });

  it("shows the other language's text in an empty field, which is then not required, and counts the gaps", () => {
    const english = page("en");
    const name = inputOf(english, "Display name");

    expect(name).toContain('value=""');
    expect(name).toContain('placeholder="Assistent"');
    expect(name).not.toContain('required=""');
    expect(inputOf(page("de"), "Begrüßungsnachricht")).toContain('placeholder="How can I help?"');
    // German lacks the welcome message and both texts of the starter prompt, English the name.
    expect(language(english, "de")).toContain(">3<");
    expect(language(page("de"), "en")).toContain(">1<");
  });

  // fix(studio): the switch scrolled away with a long page.
  it("keeps the switch reachable under the page's head while the page scrolls", () => {
    const markup = page("en");
    const bar = /<div([^>]*)><span[^>]*>Texts in<\/span>/u.exec(markup);
    expect(bar?.[1]).toContain('data-page-bar=""');
    expect(bar?.[1]).toMatch(/class="[^"]*\bsticky\b/u);
  });
});

describe("save bar", () => {
  it("is absent on an agent nothing was changed on, and present on a new one", () => {
    const fields = { editableAgentFields: ["displayName"], canManageAgentModels: true };
    const started = agentPage({
      ...fields,
      started: startedAgentForm({ name: "tax-assistant", title: "Tax assistant" }, "en")
    });

    expect(agentPage(fields)).not.toContain('type="submit"');
    expect(started).toMatch(/<button[^>]*type="submit"[^>]*>Create agent<\/button>/u);
    // A new asset has nothing to go back to.
    expect(started).not.toContain("Discard");
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
    expect(started).toMatch(/<button[^>]*type="submit"[^>]*>Create skill<\/button>/u);
  });
});

describe("refused save", () => {
  const outcome: BuildWriteOutcome = {
    ok: false,
    conflict: false,
    refusals: [
      { field: "tools", message: "The tool documents.read is not allowed in the workspace Tax." },
      { message: "The change would break an asset the caller may not read" }
    ]
  };
  const shell = (input: {
    answer?: BuildWriteOutcome;
    frame?: Partial<BuildAssetEditorProps>;
    changes?: number;
    submit?: () => Promise<BuildWriteOutcome>;
    settings?: boolean;
  }) => {
    const tools = {
      id: "tools",
      label: "Tools",
      refusalField: "tools" as const,
      body: createElement(FieldRefusals, { messages: refusalsOf(input.answer, "tools") })
    };
    const details = { id: "details", label: "Details", body: createElement("p", null, "Fields") };
    return createElement(AssetEditorShell, {
      frame: frame({ asset: storedAsset("agent", agentBase), ...input.frame }),
      title: "Assistant",
      ...(input.settings
        ? {
            outline: false,
            sections: [details],
            settings: { label: "Settings", hint: "Name, access", sections: [tools] }
          }
        : { sections: [details, tools] }),
      control: { changes: input.changes ?? 0, submit: input.submit ?? saved, discard: noop },
      outcome: input.answer,
      saving: false,
      saveLabel: "Save changes"
    });
  };
  const page = (
    answer: BuildWriteOutcome | undefined,
    input: Partial<BuildAssetEditorProps> = {}
  ) => render(shell({ answer, frame: input }));

  it("says a refusal that names the tools under the tools, and marks that section alone", () => {
    const markup = page(outcome);
    const tools = section(markup, "tools");

    expect(tools).toContain('data-field-refusal=""');
    expect(tools).toContain("The tool documents.read is not allowed in the workspace Tax.");
    expect(markup.match(/The tool documents\.read is not allowed/gu)).toHaveLength(1);
    expect(section(markup, "details")).not.toContain("data-field-refusal");
    expect(markup).toMatch(/<a href="#tools"[^>]*data-invalid=""/u);
    expect(markup.match(/<a [^>]*data-invalid=""/gu)).toHaveLength(1);
  });

  it("says a refusal that names no field after the sections, also to a reader", () => {
    const markup = page(outcome);
    const after = markup.slice(markup.lastIndexOf("</section>"));

    expect(after).toContain("The change would break an asset the caller may not read");
    expect(after).not.toContain("data-field-refusal");
    expect(page(outcome, { canWrite: false })).toContain(
      "The change would break an asset the caller may not read"
    );
  });

  it("shows nothing of a refusal on a page whose save went through, and a conflict as the frame says it", () => {
    for (const answer of [undefined, { ok: true }, { ok: false, conflict: true }] as const) {
      const markup = page(answer);
      expect(markup).not.toContain("data-field-refusal");
      expect(markup).not.toContain('role="alert"');
    }
    const conflict = page(
      { ok: false, conflict: true },
      { notice: createElement("p", { "data-build-conflict": "" }, "Somebody saved this.") }
    );
    expect(conflict.slice(conflict.lastIndexOf("</section>"))).toContain("Somebody saved this.");
  });

  it("opens the folded sections when a refused save names a field in them", async () => {
    const refused: BuildWriteOutcome = {
      ok: false,
      conflict: false,
      refusals: [{ field: "tools", message: "The tool documents.read is not allowed." }]
    };
    const host = document.createElement("div");
    document.body.append(host);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          createElement(
            UiRoot,
            { mode: "light", labels: uiLabelsEn },
            createElement(
              TranslationProvider,
              { children: null, locale: "en" },
              shell({ answer: refused, changes: 1, submit: async () => refused, settings: true })
            )
          )
        )
      );
      const trigger = () => host.querySelector("[data-asset-settings-trigger]");
      expect(trigger()?.getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        host
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(trigger()?.getAttribute("aria-expanded")).toBe("true");
      expect(host.querySelector("#tools")?.textContent).toContain(
        "The tool documents.read is not allowed."
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  // ACCEPT-FIX-9 E6: a save that waits for an approval showed a red refusal, and "Applies
  // immediately" stood beside it.
  it("says a change that waits for an approval in a neutral tone, without applying at once", () => {
    const waiting: BuildWriteOutcome = {
      ok: false,
      conflict: false,
      refusals: [{ message: "This change waits for approval by Mara Lindqvist.", waiting: true }]
    };
    const markup = render(shell({ answer: waiting, changes: 1 }));

    expect(markup).toMatch(
      /data-testid="build-save-waiting"[^>]*>[\s\S]*This change waits for approval by Mara Lindqvist\./u
    );
    expect(markup).toContain('data-tone="info"');
    expect(markup).not.toContain('data-tone="error"');
    expect(markup).not.toContain("Applies to new conversations immediately.");
    expect(render(shell({ changes: 1 }))).toContain("Applies to new conversations immediately.");
  });

  // ACCEPT-2e C-2: Elif's save of a skill waited for Mara or Jonas, but before the save the bar
  // said it applied at once. The bar now says so before the save, with who decides.
  it("names who approves before a save that would wait for an approval", () => {
    const skillAsset = storedAsset("skill", { name: "hr-leave-policy" });
    const bar = (asset: BuildAsset) => render(shell({ frame: { asset }, changes: 1 }));
    const held = (approverNames: string[]) => ({ ...skillAsset, saveApproval: { approverNames } });

    const named = bar(held(["Mara Lindqvist", "Jonas Brandt"]));
    expect(named).toContain("Mara Lindqvist");
    expect(named).toContain("Jonas Brandt");
    expect(named).not.toContain("Applies to new conversations immediately.");
    expect(bar(held([]))).not.toContain("Applies to new conversations immediately.");
    // A save the instance does not hold still applies at once.
    expect(bar(skillAsset)).toContain("Applies to new conversations immediately.");
  });

  it("counts the changes beside the save button and offers to discard them", () => {
    const changed = (changes: number) => render(shell({ changes }));

    expect(changed(3)).toContain("3 changes<");
    expect(changed(3)).toContain("Discard");
    expect(changed(3)).toMatch(/<button[^>]*type="submit"[^>]*>Save changes<\/button>/u);
    expect(changed(0)).not.toContain("Save changes");
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
      expect(markup).toContain("references/checks.md");
      expect(markup).toMatch(/<textarea[^>]*readOnly=""[^>]*># Review<\/textarea>/u);
      expect(inputOf(markup, "Title")).toContain('readOnly=""');
      expect(markup).not.toContain('aria-label="Add a file to references/"');
      expect(markup).not.toContain("Save changes");
    }
  });

  it("lets a writer change the package", () => {
    const markup = page({ canWrite: true, editable: true });

    expect(markup).toContain('aria-label="Add a file to references/"');
    expect(markup).not.toMatch(/<textarea[^>]*readOnly=""/u);
    expect(inputOf(markup, "Title")).not.toContain('readOnly=""');
  });
});
