import { withImpliedTools } from "./instance-tools";

export interface LocalizedPair<Value = string> {
  en: Value;
  de: Value;
}

interface AgentInitialPromptForm {
  title: LocalizedPair;
  prompt: LocalizedPair;
}

export interface AgentFormState {
  name: string;
  displayName: LocalizedPair;
  description: LocalizedPair;
  welcomeMessage: LocalizedPair;
  welcomeSubtitle: LocalizedPair;
  instructions: string;
  modelProviderId: string;
  modelBindingId: string;
  reasoningEffort: string;
  fastMode: boolean;
  userSelectableModelBindingIds: string[];
  /**
   * Efforts of the rows that are not the default, by binding id ("" for the instance default).
   * It also remembers rows that are not offered, so re-ticking one restores its effort; only
   * the offered ones are saved.
   */
  modelReasoningEfforts: Record<string, string>;
  maxSteps: string;
  toolNames: string[];
  skillNames: string[];
  initialPrompts: AgentInitialPromptForm[];
}

export interface SkillFormState {
  name: string;
  title: string;
  description: string;
  /** The sentence for people. Empty where the skill has none. */
  summary: string;
  /**
   * The skill's starters as its file holds them. The form does not edit them: they are kept
   * so that a save here leaves them as they are.
   */
  starters: unknown[];
  content: string;
  resources: SkillResourceFormState[];
}

interface SkillResourceFormState {
  path: string;
  mediaType: string;
  content: string;
}

/** Mirrors the availability contract; an agent without a stored row is hidden everywhere. */
export interface AgentAvailabilityForm {
  mode: "all" | "selected";
  personalWorkspaces: boolean;
  collaborationWorkspaceIds: string[];
}

export type AgentAvailabilitySummary =
  | { kind: "all" }
  | { kind: "hidden" }
  | { kind: "personal" }
  | { kind: "workspaces"; count: number; personalWorkspaces: boolean };

export function agentAvailabilityToForm(
  availability: AgentAvailabilityForm | undefined
): AgentAvailabilityForm {
  return availability
    ? { ...availability, collaborationWorkspaceIds: [...availability.collaborationWorkspaceIds] }
    : { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [] };
}

export function agentAvailabilitySummary(
  availability: AgentAvailabilityForm | undefined
): AgentAvailabilitySummary {
  if (availability?.mode === "all") {
    return { kind: "all" };
  }
  const count = availability?.collaborationWorkspaceIds.length ?? 0;
  if (count > 0) {
    return {
      kind: "workspaces",
      count,
      personalWorkspaces: availability?.personalWorkspaces ?? false
    };
  }
  return availability?.personalWorkspaces ? { kind: "personal" } : { kind: "hidden" };
}

export function agentAvailabilityFormsEqual(
  left: AgentAvailabilityForm,
  right: AgentAvailabilityForm
): boolean {
  if (left.mode !== right.mode) {
    return false;
  }
  if (left.mode === "all") {
    return true;
  }
  const rightIds = new Set(right.collaborationWorkspaceIds);
  return (
    left.personalWorkspaces === right.personalWorkspaces &&
    left.collaborationWorkspaceIds.length === rightIds.size &&
    left.collaborationWorkspaceIds.every((id) => rightIds.has(id))
  );
}

const EMPTY_LOCALIZED_PAIR: LocalizedPair = { en: "", de: "" };

export function localizedToPair(value: unknown): LocalizedPair {
  if (typeof value === "string") {
    return { en: value, de: value };
  }
  if (value && typeof value === "object") {
    const record = value as { en?: unknown; de?: unknown };
    return {
      en: typeof record.en === "string" ? record.en : "",
      de: typeof record.de === "string" ? record.de : ""
    };
  }
  return { ...EMPTY_LOCALIZED_PAIR };
}

export function pairToLocalized(
  pair: LocalizedPair
): string | { en?: string; de?: string } | undefined {
  const en = pair.en.trim();
  const de = pair.de.trim();
  if (!en && !de) {
    return undefined;
  }
  if (en === de) {
    return en;
  }
  return {
    ...(en ? { en } : {}),
    ...(de ? { de } : {})
  };
}

export function agentConfigToForm(config: Record<string, unknown>): AgentFormState {
  const modelProviderId = typeof config.modelProviderId === "string" ? config.modelProviderId : "";
  const modelBindingId = typeof config.modelBindingId === "string" ? config.modelBindingId : "";
  const initialPrompts = Array.isArray(config.initialPrompts) ? config.initialPrompts : [];
  return {
    name: typeof config.name === "string" ? config.name : "",
    displayName: localizedToPair(config.displayName),
    description: localizedToPair(config.description),
    welcomeMessage: localizedToPair(config.welcomeMessage),
    welcomeSubtitle: localizedToPair(config.welcomeSubtitle),
    instructions: typeof config.instructions === "string" ? config.instructions : "",
    modelProviderId,
    modelBindingId,
    reasoningEffort: typeof config.reasoningEffort === "string" ? config.reasoningEffort : "",
    fastMode: config.fastMode === true,
    userSelectableModelBindingIds: stringArray(config.userSelectableModelBindingIds),
    modelReasoningEfforts: stringRecord(config.modelReasoningEfforts),
    maxSteps: typeof config.maxSteps === "number" ? String(config.maxSteps) : "",
    toolNames: stringArray(config.toolNames),
    skillNames: stringArray(config.skillNames),
    initialPrompts: initialPrompts.map((prompt) => {
      const record = (prompt ?? {}) as { title?: unknown; prompt?: unknown };
      return {
        title: localizedToPair(record.title),
        prompt: localizedToPair(record.prompt)
      };
    })
  };
}

/**
 * The config to save for an edited agent. A field the form left as loaded keeps its stored
 * value, so the form's normalisation (trimming, collapsing equal locales) never reaches the
 * server as a change to a field nobody touched.
 */
export function editedAgentConfig(
  form: AgentFormState,
  storedConfig: Record<string, unknown> | undefined
): Record<string, unknown> {
  const edited = agentFormToConfig(form);
  if (!storedConfig) {
    return edited;
  }
  const loaded = agentFormToConfig(agentConfigToForm(storedConfig));
  return Object.fromEntries(
    Object.entries(edited).map(([field, value]) => [
      field,
      field in storedConfig && JSON.stringify(value) === JSON.stringify(loaded[field])
        ? storedConfig[field]
        : value
    ])
  );
}

export function agentFormToConfig(form: AgentFormState): Record<string, unknown> {
  const displayName = pairToLocalized(form.displayName);
  const description = pairToLocalized(form.description);
  const welcomeMessage = pairToLocalized(form.welcomeMessage);
  const welcomeSubtitle = hasLocalizedContent(form.welcomeSubtitle)
    ? pairToLocalized(form.welcomeSubtitle)
    : undefined;
  const maxSteps = form.maxSteps.trim() ? Number(form.maxSteps) : undefined;
  // The default model is always offered to users, so it is never stored in the list.
  const userSelectableModelBindingIds = form.userSelectableModelBindingIds.filter(
    (bindingId) => bindingId !== form.modelBindingId
  );
  const modelReasoningEfforts = Object.fromEntries(
    userSelectableModelBindingIds.flatMap((bindingId) => {
      const effort = form.modelReasoningEfforts[bindingId];
      return effort ? [[bindingId, effort]] : [];
    })
  );
  return {
    name: form.name.trim(),
    displayName: displayName ?? "",
    ...(description === undefined ? {} : { description }),
    ...(welcomeMessage === undefined ? {} : { welcomeMessage }),
    ...(welcomeSubtitle === undefined ? {} : { welcomeSubtitle }),
    instructions: form.instructions,
    ...(form.modelBindingId
      ? { modelBindingId: form.modelBindingId }
      : form.modelProviderId
        ? { modelProviderId: form.modelProviderId }
        : {}),
    ...(form.reasoningEffort ? { reasoningEffort: form.reasoningEffort } : {}),
    ...(form.fastMode ? { fastMode: true } : {}),
    ...(userSelectableModelBindingIds.length ? { userSelectableModelBindingIds } : {}),
    ...(Object.keys(modelReasoningEfforts).length ? { modelReasoningEfforts } : {}),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    // The tools the agent holds because of something else are saved with it.
    toolNames: withImpliedTools(form.toolNames, form.skillNames),
    skillNames: form.skillNames,
    initialPrompts: form.initialPrompts
      .filter((prompt) => hasLocalizedContent(prompt.title) || hasLocalizedContent(prompt.prompt))
      .map((prompt) => ({
        title: pairToLocalized(prompt.title) ?? "",
        prompt: pairToLocalized(prompt.prompt) ?? ""
      }))
  };
}

export interface AgentModelRow {
  bindingId: string;
  model: string;
  /** The agent's own model. */
  isDefault: boolean;
  /** Offered in the chat: the default always is, the others when listed. */
  userSelectable: boolean;
  /** "" uses the binding's default. Applies only while the row is the default or offered. */
  reasoningEffort: string;
}

/**
 * One row per model binding the agent may use. A default that is no longer among them still
 * gets a row, so the configured model stays visible.
 */
export function agentModelRows(
  form: Pick<
    AgentFormState,
    "modelBindingId" | "userSelectableModelBindingIds" | "reasoningEffort" | "modelReasoningEfforts"
  >,
  modelBindings: ReadonlyArray<{ id: string; model: string }>
): AgentModelRow[] {
  const bindings =
    form.modelBindingId && !modelBindings.some((binding) => binding.id === form.modelBindingId)
      ? [...modelBindings, { id: form.modelBindingId, model: form.modelBindingId }]
      : modelBindings;
  return bindings.map((binding) => {
    const isDefault = binding.id === form.modelBindingId;
    return {
      bindingId: binding.id,
      model: binding.model,
      isDefault,
      userSelectable: isDefault || form.userSelectableModelBindingIds.includes(binding.id),
      reasoningEffort: agentModelReasoningEffort(form, binding.id)
    };
  });
}

/**
 * Makes a binding the agent's default ("" for the instance default). The other models keep
 * their user-selectable state: the list is left alone, and the previous default is offered
 * again only if it was listed. Efforts stay with their model: the new default's effort becomes
 * the agent's `reasoningEffort` and the previous default's is kept for its row. Selecting a
 * binding without fast-mode support clears the flag, as the server does.
 */
export function selectAgentModelBinding(
  form: AgentFormState,
  modelBindingId: string,
  references: { fastModeModelBindingIds: readonly string[]; modelBindingIds: readonly string[] }
): AgentFormState {
  if (modelBindingId === form.modelBindingId) {
    return form;
  }
  const { [modelBindingId]: reasoningEffort = "", ...otherEfforts } = form.modelReasoningEfforts;
  return {
    ...form,
    modelBindingId,
    modelProviderId: "",
    reasoningEffort,
    modelReasoningEfforts: { ...otherEfforts, [form.modelBindingId]: form.reasoningEffort },
    fastMode: form.fastMode && references.fastModeModelBindingIds.includes(modelBindingId),
    userSelectableModelBindingIds: knownModelBindingIds(form, references.modelBindingIds)
  };
}

/** The effort of one row: the agent's own for the default, otherwise the one kept per model. */
export function agentModelReasoningEffort(
  form: Pick<AgentFormState, "modelBindingId" | "reasoningEffort" | "modelReasoningEfforts">,
  modelBindingId: string
): string {
  return modelBindingId === form.modelBindingId
    ? form.reasoningEffort
    : (form.modelReasoningEfforts[modelBindingId] ?? "");
}

export function setAgentModelReasoningEffort(
  form: AgentFormState,
  modelBindingId: string,
  reasoningEffort: string
): AgentFormState {
  return modelBindingId === form.modelBindingId
    ? { ...form, reasoningEffort }
    : {
        ...form,
        modelReasoningEfforts: { ...form.modelReasoningEfforts, [modelBindingId]: reasoningEffort }
      };
}

export function setAgentModelUserSelectable(
  form: AgentFormState,
  modelBindingId: string,
  userSelectable: boolean,
  modelBindingIds: readonly string[]
): AgentFormState {
  const others = knownModelBindingIds(form, modelBindingIds).filter((id) => id !== modelBindingId);
  return {
    ...form,
    userSelectableModelBindingIds: userSelectable ? [...others, modelBindingId] : others
  };
}

/** An edited list drops ids whose binding no longer exists; the server would reject them. */
function knownModelBindingIds(
  form: Pick<AgentFormState, "userSelectableModelBindingIds">,
  modelBindingIds: readonly string[]
): string[] {
  return form.userSelectableModelBindingIds.filter((id) => modelBindingIds.includes(id));
}

export function emptyAgentForm(): AgentFormState {
  return {
    name: "",
    displayName: { ...EMPTY_LOCALIZED_PAIR },
    description: { ...EMPTY_LOCALIZED_PAIR },
    welcomeMessage: { ...EMPTY_LOCALIZED_PAIR },
    welcomeSubtitle: { ...EMPTY_LOCALIZED_PAIR },
    instructions: "",
    modelProviderId: "",
    modelBindingId: "",
    reasoningEffort: "",
    fastMode: false,
    userSelectableModelBindingIds: [],
    modelReasoningEfforts: {},
    maxSteps: "",
    toolNames: [],
    skillNames: [],
    initialPrompts: []
  };
}

export function skillConfigToForm(config: Record<string, unknown>): SkillFormState {
  const resources = Array.isArray(config.resources) ? config.resources : [];
  return {
    name: typeof config.name === "string" ? config.name : "",
    title: typeof config.title === "string" ? config.title : "",
    description: typeof config.description === "string" ? config.description : "",
    summary: typeof config.summary === "string" ? config.summary : "",
    starters: Array.isArray(config.starters) ? config.starters : [],
    content: typeof config.content === "string" ? config.content : "",
    resources: resources.flatMap((resource) => {
      if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
        return [];
      }
      const record = resource as Record<string, unknown>;
      return typeof record.path === "string" &&
        typeof record.mediaType === "string" &&
        typeof record.content === "string"
        ? [{ path: record.path, mediaType: record.mediaType, content: record.content }]
        : [];
    })
  };
}

export function skillFormToConfig(form: SkillFormState): Record<string, unknown> {
  return {
    name: form.name.trim(),
    title: form.title.trim(),
    description: form.description.trim(),
    ...(form.summary.trim() ? { summary: form.summary.trim() } : {}),
    ...(form.starters.length ? { starters: form.starters } : {}),
    content: form.content,
    ...(form.resources.length ? { resources: form.resources } : {})
  };
}

/** Example names shown in the empty name fields. Names are identifiers and are not translated. */

/** The file that holds a skill's instructions. */
export const SKILL_ROOT_FILE_NAME = "SKILL.md";

export function emptySkillForm(): SkillFormState {
  return {
    name: "",
    title: "",
    description: "",
    summary: "",
    starters: [],
    content: "",
    resources: []
  };
}

function hasLocalizedContent(pair: LocalizedPair): boolean {
  return Boolean(pair.en.trim() || pair.de.trim());
}

function stringRecord(value: unknown): Record<string, string> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** The two languages a localized text is written in. */
export const ASSET_LANGUAGES = ["en", "de"] as const satisfies readonly (keyof LocalizedPair)[];

/** The localized texts of an agent that people read in chat, starter prompts included. */
function agentLocalizedTexts(form: AgentFormState): LocalizedPair[] {
  return [
    form.displayName,
    form.description,
    form.welcomeMessage,
    form.welcomeSubtitle,
    ...form.initialPrompts.flatMap((prompt) => [prompt.title, prompt.prompt])
  ];
}

/**
 * How many of an agent's texts are written in some language and still empty in each one. A
 * text that is empty everywhere is not missing anywhere.
 */
export function agentMissingTranslations(form: AgentFormState): LocalizedPair<number> {
  const texts = agentLocalizedTexts(form).filter(hasLocalizedContent);
  return {
    en: texts.filter((text) => !text.en.trim()).length,
    de: texts.filter((text) => !text.de.trim()).length
  };
}

/** How many fields of a form differ from the form it is compared with. */
export function countChangedFields<Form extends object>(form: Form, baseline: Form): number {
  const before = new Map(Object.entries(baseline));
  return Object.entries(form).filter(
    ([field, value]) => JSON.stringify(value) !== JSON.stringify(before.get(field))
  ).length;
}

/** An agent as the dialog that starts one leaves it: its id, and its name in the reader's language. */
export function startedAgentForm(
  start: { name: string; title: string },
  language: keyof LocalizedPair
): AgentFormState {
  const form = emptyAgentForm();
  return {
    ...form,
    name: start.name,
    displayName: { ...form.displayName, [language]: start.title }
  };
}

export function startedSkillForm(start: { name: string; title: string }): SkillFormState {
  return { ...emptySkillForm(), name: start.name, title: start.title };
}
