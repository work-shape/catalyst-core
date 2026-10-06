export interface LocalizedPair {
  en: string;
  de: string;
}

export interface AgentInitialPromptForm {
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
  maxSteps: string;
  toolNames: string[];
  skillNames: string[];
  initialPrompts: AgentInitialPromptForm[];
}

export interface SkillFormState {
  name: string;
  title: string;
  description: string;
  content: string;
  resources: SkillResourceFormState[];
}

export interface SkillResourceFormState {
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

export const EMPTY_LOCALIZED_PAIR: LocalizedPair = { en: "", de: "" };

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
    ...(maxSteps === undefined ? {} : { maxSteps }),
    toolNames: form.toolNames,
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
}

/**
 * One row per model binding the agent may use. A default that is no longer among them still
 * gets a row, so the configured model stays visible.
 */
export function agentModelRows(
  form: Pick<AgentFormState, "modelBindingId" | "userSelectableModelBindingIds">,
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
      userSelectable: isDefault || form.userSelectableModelBindingIds.includes(binding.id)
    };
  });
}

/**
 * Makes a binding the agent's default ("" for the instance default). The other models keep
 * their user-selectable state: the list is left alone, and the previous default is offered
 * again only if it was listed. Selecting a binding without fast-mode support clears the flag,
 * as the server does.
 */
export function selectAgentModelBinding(
  form: AgentFormState,
  modelBindingId: string,
  references: { fastModeModelBindingIds: readonly string[]; modelBindingIds: readonly string[] }
): AgentFormState {
  return {
    ...form,
    modelBindingId,
    modelProviderId: "",
    fastMode: form.fastMode && references.fastModeModelBindingIds.includes(modelBindingId),
    userSelectableModelBindingIds: knownModelBindingIds(form, references.modelBindingIds)
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
    content: form.content,
    ...(form.resources.length ? { resources: form.resources } : {})
  };
}

export function emptySkillForm(): SkillFormState {
  return { name: "", title: "", description: "", content: "", resources: [] };
}

export function configAssetMutationErrorMessage(
  error: unknown,
  fallback = "The change could not be saved."
): string {
  const issueMessages = readValidationIssueMessages(error);
  if (issueMessages.length > 0) {
    return issueMessages.join(" ");
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function hasLocalizedContent(pair: LocalizedPair): boolean {
  return Boolean(pair.en.trim() || pair.de.trim());
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readValidationIssueMessages(error: unknown): string[] {
  const payload = readObjectProperty(error, "payload");
  const responseError = readObjectProperty(payload, "error");
  const details = readObjectProperty(responseError, "details");
  const issues = readObjectProperty(details, "issues");
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.flatMap((issue) => {
    const message = readObjectProperty(issue, "message");
    return typeof message === "string" && message ? [message] : [];
  });
}

function readObjectProperty(value: unknown, property: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[property];
}
