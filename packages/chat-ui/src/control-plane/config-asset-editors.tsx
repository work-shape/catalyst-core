import { Check, ChevronDown, FileText, History, Plus, Star, Trash2, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type {
  AdministeredCollaborationWorkspace,
  ConfigAssetKind,
  ConfigAssetRevision,
  ConfigAssetsOverview
} from "@vivd-catalyst/api-client";
import { SKILL_RESOURCE_MEDIA_TYPES } from "@vivd-catalyst/core";
import {
  CheckboxGroup,
  DeleteDialog,
  Field,
  InitialPromptsEditor,
  LocalizedField
} from "./config-asset-form-fields";
import {
  EXAMPLE_AGENT_NAME,
  EXAMPLE_SKILL_NAME,
  SKILL_ROOT_FILE_NAME,
  agentAvailabilityFormsEqual,
  agentAvailabilityToForm,
  agentModelRows,
  agentModelReasoningEffort,
  selectAgentModelBinding,
  setAgentModelReasoningEffort,
  setAgentModelUserSelectable,
  type AgentAvailabilityForm,
  type AgentFormState,
  type SkillFormState
} from "./config-assets-model";
import { useTranslation } from "../i18n";
import { formatModelLabel } from "../model-label";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Input, Textarea } from "../ui/input";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { apiErrorMessage } from "../workspace-utils";

interface MutationOutcome {
  ok: boolean;
  error?: string;
}

export function AgentEditor({
  initialForm,
  isNew,
  isDefault,
  references,
  editableAgentFields,
  canManageAgentModels,
  skillNames,
  mutating,
  onSave,
  onDelete,
  onMakeDefault,
  availability,
  revisions
}: {
  initialForm: AgentFormState;
  isNew: boolean;
  isDefault: boolean;
  references: ConfigAssetsOverview["references"] | undefined;
  editableAgentFields: string[];
  /** The model settings follow this permission, not `editableAgentFields`. */
  canManageAgentModels: boolean;
  skillNames: string[];
  mutating: boolean;
  onSave(form: AgentFormState): Promise<MutationOutcome>;
  onDelete?: () => Promise<MutationOutcome>;
  onMakeDefault?: () => Promise<MutationOutcome>;
  /** Saved on its own, so it sits outside the agent form's save. */
  availability?: React.ReactNode;
  revisions: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState<string | undefined>(undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The form as last saved; any edit replaces `form` and so ends the confirmation.
  const [savedForm, setSavedForm] = useState<typeof form | undefined>(undefined);
  const canEdit = (field: string) => editableAgentFields.includes(field);
  const canEditModel = canManageAgentModels;
  const canEditMaxSteps = canEdit("maxSteps");
  const modelBindings =
    references?.modelBindings ?? references?.modelBindingIds.map((id) => ({ id, model: id })) ?? [];
  const modelBindingIds = modelBindings.map((binding) => binding.id);
  const showModels =
    canEditModel ||
    Boolean(form.modelBindingId || form.modelProviderId || form.reasoningEffort) ||
    form.userSelectableModelBindingIds.some((id) => modelBindingIds.includes(id));
  const showMaxSteps = canEditMaxSteps || Boolean(form.maxSteps);
  const fastModeModelBindingIds = references?.fastModeModelBindingIds ?? [];
  const showFastMode = form.fastMode || fastModeModelBindingIds.includes(form.modelBindingId);

  const update = (patch: Partial<AgentFormState>) => setForm((value) => ({ ...value, ...patch }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const outcome = await onSave(form);
    setError(outcome.error);
    setSavedForm(outcome.ok ? form : undefined);
  };

  return (
    <form className="grid min-w-0 content-start" onSubmit={submit}>
      <EditorHeader
        eyebrow={t("configAgent")}
        title={
          isNew
            ? t("configNewAgent")
            : form.displayName.en.trim() || form.displayName.de.trim() || form.name
        }
        identifier={isNew ? undefined : form.name}
        badges={isDefault ? <Badge variant="secondary">{t("configDefaultAgent")}</Badge> : null}
        actions={
          <>
            {onMakeDefault ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={mutating}
                onClick={async () => setError((await onMakeDefault()).error)}
              >
                <Star size={14} aria-hidden="true" />
                {t("configMakeDefault")}
              </Button>
            ) : null}
            {onDelete ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                disabled={mutating}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 size={14} aria-hidden="true" />
                {t("configDelete")}
              </Button>
            ) : null}
          </>
        }
      />

      <EditorSection
        title={t("configIdentityWelcome")}
        description={t("configIdentityDescription")}
      >
        {isNew ? (
          <Field label={t("configName")} hint={t("configAgentNameHint")}>
            <Input
              value={form.name}
              required
              placeholder={EXAMPLE_AGENT_NAME}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
        ) : null}
        <LocalizedField
          label={t("configDisplayName")}
          required
          disabled={!canEdit("displayName")}
          value={form.displayName}
          onChange={(displayName) => update({ displayName })}
        />
        <LocalizedField
          label={t("configDescription")}
          disabled={!canEdit("description")}
          value={form.description}
          onChange={(description) => update({ description })}
        />
        <LocalizedField
          label={t("configWelcomeMessage")}
          disabled={!canEdit("welcomeMessage")}
          value={form.welcomeMessage}
          onChange={(welcomeMessage) => update({ welcomeMessage })}
        />
        <LocalizedField
          label={t("configWelcomeSubtitle")}
          disabled={!canEdit("welcomeSubtitle")}
          value={form.welcomeSubtitle}
          onChange={(welcomeSubtitle) => update({ welcomeSubtitle })}
        />
      </EditorSection>

      <EditorSection
        title={t("configBehavior")}
        description={
          canEditModel || canEditMaxSteps
            ? t("configBehaviorDescriptionWithControls")
            : t("configBehaviorDescription")
        }
      >
        <Field label={t("configInstructions")} hint={t("configSystemPromptHint")}>
          <EditorTextarea
            label={t("configSystemPrompt")}
            value={form.instructions}
            required
            disabled={!canEdit("instructions")}
            className="min-h-72"
            onChange={(event) => update({ instructions: event.target.value })}
          />
        </Field>
        {showModels ? (
          <AgentModelList
            form={form}
            modelBindings={modelBindings}
            reasoningEfforts={references?.reasoningEfforts ?? []}
            editable={canEditModel}
            onSelectDefault={(modelBindingId) =>
              setForm((value) =>
                selectAgentModelBinding(value, modelBindingId, {
                  fastModeModelBindingIds,
                  modelBindingIds
                })
              )
            }
            onSetUserSelectable={(modelBindingId, userSelectable) =>
              setForm((value) =>
                setAgentModelUserSelectable(value, modelBindingId, userSelectable, modelBindingIds)
              )
            }
            onSetReasoningEffort={(modelBindingId, reasoningEffort) =>
              setForm((value) =>
                setAgentModelReasoningEffort(value, modelBindingId, reasoningEffort)
              )
            }
          />
        ) : null}
        {showFastMode || showMaxSteps ? (
          <div className={cn("grid gap-5", showFastMode && showMaxSteps && "sm:grid-cols-2")}>
            {showFastMode ? (
              <Field label={t("configFastMode")} hint={t("configFastModeHint")}>
                <Switch
                  checked={form.fastMode}
                  disabled={!canManageAgentModels}
                  aria-label={t("configFastMode")}
                  onCheckedChange={(fastMode) => update({ fastMode })}
                />
              </Field>
            ) : null}
            {showMaxSteps ? (
              <Field label={t("configMaxSteps")} hint={t("configMaxStepsHint")}>
                <Input
                  type="number"
                  min={1}
                  value={form.maxSteps}
                  disabled={!canEditMaxSteps}
                  onChange={(event) => update({ maxSteps: event.target.value })}
                />
              </Field>
            ) : null}
          </div>
        ) : null}
      </EditorSection>

      <EditorSection
        title={t("configCapabilities")}
        description={t("configCapabilitiesDescription")}
      >
        <CheckboxGroup
          label={t("configTools")}
          options={references?.enabledToolNames ?? []}
          selected={form.toolNames}
          disabled={!canEdit("toolNames")}
          emptyHint={t("configNoTools")}
          onChange={(toolNames) => update({ toolNames })}
        />
        <CheckboxGroup
          label={t("configSkills")}
          options={skillNames}
          selected={form.skillNames}
          disabled={!canEdit("skillNames")}
          emptyHint={t("configNoSkills")}
          hint={
            form.skillNames.length > 0 && !form.toolNames.includes("read_skill")
              ? t("configSkillsRequireReadSkill")
              : undefined
          }
          onChange={(selected) => update({ skillNames: selected })}
        />
      </EditorSection>

      <EditorSection
        title={t("configStarterPrompts")}
        description={t("configStarterPromptsDescription")}
      >
        <InitialPromptsEditor
          prompts={form.initialPrompts}
          disabled={!canEdit("initialPrompts")}
          onChange={(initialPrompts) => update({ initialPrompts })}
        />
      </EditorSection>

      {availability}

      {revisions}

      {error ? (
        <p role="alert" className="px-5 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {editableAgentFields.length > 0 || canManageAgentModels ? (
        <SaveBar
          label={isNew ? t("configCreateAgent") : t("configSaveChanges")}
          mutating={mutating}
          saved={savedForm === form}
        />
      ) : null}

      {onDelete ? (
        <DeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          kind="agent"
          name={form.name}
          onConfirm={async () => {
            setDeleteOpen(false);
            setError((await onDelete()).error);
          }}
        />
      ) : null}
    </form>
  );
}

/**
 * Where an agent can be chosen. It is stored apart from the agent's config and
 * has its own save, so it does not depend on which agent fields are editable.
 */
export function AgentAvailabilityEditor({
  availability,
  isDefault,
  workspaces,
  workspacesError,
  mutating,
  onSave
}: {
  availability: AgentAvailabilityForm | undefined;
  isDefault: boolean;
  workspaces: AdministeredCollaborationWorkspace[];
  workspacesError?: string;
  mutating: boolean;
  onSave(availability: AgentAvailabilityForm): Promise<MutationOutcome>;
}) {
  const { t } = useTranslation();
  const saved = useMemo(() => agentAvailabilityToForm(availability), [availability]);
  const [form, setForm] = useState(saved);
  const [error, setError] = useState<string | undefined>(undefined);
  const locked = isDefault && saved.mode === "all";
  const disabled = locked || mutating;
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  // Ids the list no longer returns stay visible, so saving never drops them unseen.
  const workspaceIds = [
    ...workspaces.map((workspace) => workspace.id),
    ...form.collaborationWorkspaceIds.filter((id) => !workspaceNames.has(id))
  ];
  const nothingSelected =
    form.mode === "selected" &&
    !form.personalWorkspaces &&
    form.collaborationWorkspaceIds.length === 0;

  const update = (patch: Partial<AgentAvailabilityForm>) =>
    setForm((value) => ({ ...value, ...patch }));

  return (
    <EditorSection title={t("configAvailability")} description={t("configAvailabilityDescription")}>
      <fieldset className="grid gap-2" disabled={disabled}>
        <legend className="sr-only">{t("configAvailability")}</legend>
        {(["all", "selected"] as const).map((mode) => (
          <label key={mode} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="agent-availability-mode"
              className="mt-0.5 size-4 shrink-0 accent-primary"
              checked={form.mode === mode}
              onChange={() => update({ mode })}
            />
            <span className="grid gap-0.5">
              <span className="font-medium">
                {t(mode === "all" ? "configAvailabilityAll" : "configAvailabilitySelected")}
              </span>
              {mode === "all" ? (
                <span className="text-xs text-muted-foreground">
                  {t("configAvailabilityAllHint")}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>

      {locked ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {t("configAvailabilityDefaultLocked")}
        </p>
      ) : null}

      {form.mode === "selected" ? (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-primary"
              checked={form.personalWorkspaces}
              disabled={disabled}
              onChange={(event) => update({ personalWorkspaces: event.target.checked })}
            />
            <span className="grid gap-0.5">
              <span className="font-medium">{t("configAvailabilityPersonal")}</span>
              <span className="text-xs text-muted-foreground">
                {t("configAvailabilityPersonalHint")}
              </span>
            </span>
          </label>
          <CheckboxGroup
            label={t("collaborationWorkspaceSharedHeading")}
            options={workspaceIds}
            optionLabel={(id) => workspaceNames.get(id) ?? id}
            selected={form.collaborationWorkspaceIds}
            disabled={disabled}
            emptyHint={workspacesError ?? t("configAvailabilityNoSharedWorkspaces")}
            hint={nothingSelected ? t("configAvailabilityHiddenHint") : undefined}
            onChange={(collaborationWorkspaceIds) => update({ collaborationWorkspaceIds })}
          />
        </>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {locked ? null : (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={mutating || agentAvailabilityFormsEqual(form, saved)}
            onClick={async () => setError((await onSave(form)).error)}
          >
            {t("configAvailabilitySave")}
          </Button>
        </div>
      )}
    </EditorSection>
  );
}

/**
 * The agent's models as one list: which one runs the agent, and which ones its users may pick
 * instead. Read-only, it shows only the default and the offered models.
 */
function AgentModelList({
  form,
  modelBindings,
  reasoningEfforts,
  editable,
  onSelectDefault,
  onSetUserSelectable,
  onSetReasoningEffort
}: {
  form: AgentFormState;
  modelBindings: Array<{ id: string; model: string }>;
  reasoningEfforts: string[];
  editable: boolean;
  onSelectDefault(modelBindingId: string): void;
  onSetUserSelectable(modelBindingId: string, userSelectable: boolean): void;
  onSetReasoningEffort(modelBindingId: string, reasoningEffort: string): void;
}) {
  const { t } = useTranslation();
  const defaultGroupName = useId();
  const rows = agentModelRows(form, modelBindings)
    .filter((row) => editable || row.userSelectable)
    .map((row) => ({
      ...row,
      label: modelBindingLabel({ id: row.bindingId, model: row.model }, modelBindings)
    }));
  const instanceDefaultLabel = form.modelProviderId
    ? `${t("configInstanceDefault")} (${form.modelProviderId})`
    : t("configInstanceDefault");
  // The form column is often narrow whatever the viewport, so the row wraps by itself: its two
  // halves share a line when both fit their basis (about 37rem of list width) and stack below.
  // The halves carry the vertical spacing so that an empty second half adds no height.
  const rowClassName =
    "flex min-h-10 flex-wrap items-center gap-x-4 bg-background px-3 py-1 text-sm";
  const nameHalfClassName = "my-1 flex min-w-0 flex-[1_1_14rem] items-center justify-between gap-3";
  const optionsHalfClassName =
    "my-1 flex min-w-0 flex-[1_1_20rem] items-center justify-between gap-3";
  const optionClassName =
    "flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-muted-foreground";
  const nameHalf = (bindingId: string, label: string, isDefault: boolean) => (
    <div className={nameHalfClassName}>
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
      <label className={optionClassName}>
        <input
          type="radio"
          name={defaultGroupName}
          className="size-4 shrink-0 accent-primary"
          aria-label={`${label}: ${t("configModelIsDefault")}`}
          checked={isDefault}
          disabled={!editable}
          onChange={() => onSelectDefault(bindingId)}
        />
        {t("configModelIsDefault")}
      </label>
    </div>
  );
  // Only a model that is in use has an effort: the default and the ones offered to users.
  const effortSelect = (bindingId: string, label: string) => (
    <Select
      className="ml-auto h-8 w-40 shrink-0 px-2 text-xs"
      aria-label={`${label}: ${t("configReasoningEffort")}`}
      title={t("configReasoningEffort")}
      value={agentModelReasoningEffort(form, bindingId)}
      disabled={!editable}
      onChange={(event) => onSetReasoningEffort(bindingId, event.target.value)}
    >
      <option value="">{t("configModelDefault")}</option>
      {reasoningEfforts.map((effort) => (
        <option key={effort} value={effort}>
          {effort}
        </option>
      ))}
    </Select>
  );

  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="sr-only">{t("configModels")}</legend>
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="flex items-center justify-between gap-3 border-b bg-muted/20 px-3 py-2">
          <span className="text-sm font-medium">{t("configModels")}</span>
          <span aria-hidden="true" className="text-xs text-muted-foreground">
            {t("configReasoningEffort")}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-px bg-border">
          {editable || !form.modelBindingId ? (
            <div className={cn(rowClassName, !form.modelBindingId && "bg-muted/30")}>
              {nameHalf("", instanceDefaultLabel, !form.modelBindingId)}
              {form.modelBindingId ? (
                // Keeps the radio in line with the other rows when the halves share a line.
                <div aria-hidden="true" className="flex-[1_1_20rem]" />
              ) : (
                <div className={optionsHalfClassName}>{effortSelect("", instanceDefaultLabel)}</div>
              )}
            </div>
          ) : null}
          {rows.map((row) => (
            <div key={row.bindingId} className={cn(rowClassName, row.isDefault && "bg-muted/30")}>
              {nameHalf(row.bindingId, row.label, row.isDefault)}
              <div className={optionsHalfClassName}>
                <label className={optionClassName}>
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-primary"
                    aria-label={`${row.label}: ${t("configModelUserSelectable")}`}
                    checked={row.userSelectable}
                    disabled={!editable || row.isDefault}
                    onChange={(event) => onSetUserSelectable(row.bindingId, event.target.checked)}
                  />
                  {t("configModelUserSelectable")}
                </label>
                {row.userSelectable ? effortSelect(row.bindingId, row.label) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("configModelsHint")}</p>
    </fieldset>
  );
}

function modelBindingLabel(
  binding: { id: string; model: string },
  bindings: Array<{ id: string; model: string }>
): string {
  const duplicateModel = bindings.some(
    (candidate) => candidate.id !== binding.id && candidate.model === binding.model
  );
  const label = formatModelLabel(binding.model);
  return duplicateModel ? `${label} (${binding.id})` : label;
}

export function SkillEditor({
  initialForm,
  isNew,
  editable,
  mutating,
  onSave,
  onDelete,
  revisions
}: {
  initialForm: SkillFormState;
  isNew: boolean;
  editable: boolean;
  mutating: boolean;
  onSave(form: SkillFormState): Promise<MutationOutcome>;
  onDelete?: () => Promise<MutationOutcome>;
  revisions: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState<string | undefined>(undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The form as last saved; any edit replaces `form` and so ends the confirmation.
  const [savedForm, setSavedForm] = useState<typeof form | undefined>(undefined);
  const [selectedResource, setSelectedResource] = useState<"root" | number>("root");

  const update = (patch: Partial<SkillFormState>) => setForm((value) => ({ ...value, ...patch }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const outcome = await onSave(form);
    setError(outcome.error);
    setSavedForm(outcome.ok ? form : undefined);
  };

  return (
    <form className="grid min-w-0 content-start" onSubmit={submit}>
      <EditorHeader
        eyebrow={t("configSkill")}
        title={isNew ? t("configNewSkill") : form.title.trim() || form.name}
        identifier={isNew ? undefined : form.name}
        badges={null}
        actions={
          onDelete ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              disabled={mutating}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 size={14} aria-hidden="true" />
              {t("configDelete")}
            </Button>
          ) : null
        }
      />

      <EditorSection
        title={t("configSkillDetails")}
        description={t("configSkillDetailsDescription")}
      >
        {isNew ? (
          <Field label={t("configName")} hint={t("configSkillNameHint")}>
            <Input
              value={form.name}
              disabled={!editable}
              required
              placeholder={EXAMPLE_SKILL_NAME}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
        ) : null}
        <Field label={t("configTitle")} hint={t("configSkillTitleHint")}>
          <Input
            value={form.title}
            required
            disabled={!editable}
            onChange={(event) => update({ title: event.target.value })}
          />
        </Field>
        <Field label={t("configDescription")} hint={t("configSkillDescriptionHint")}>
          <Input
            value={form.description}
            required
            disabled={!editable}
            onChange={(event) => update({ description: event.target.value })}
          />
        </Field>
      </EditorSection>

      <EditorSection
        title={t("configInstructions")}
        description={t("configSkillInstructionsDescription")}
        sidebar={
          <div className="grid min-w-0 content-start gap-2 pt-2">
            <button
              type="button"
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm",
                selectedResource === "root" && "border-primary bg-muted"
              )}
              onClick={() => setSelectedResource("root")}
            >
              <FileText className="shrink-0" size={14} aria-hidden="true" />
              <span className="truncate">{SKILL_ROOT_FILE_NAME}</span>
            </button>
            {form.resources.length || editable ? (
              <div className="ml-3 grid min-w-0 gap-2 border-l pl-3">
                {form.resources.map((resource, index) => (
                  <button
                    key={`${index}:${resource.path}`}
                    type="button"
                    className={cn(
                      "flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm",
                      selectedResource === index && "border-primary bg-muted"
                    )}
                    onClick={() => setSelectedResource(index)}
                  >
                    <FileText className="shrink-0" size={14} aria-hidden="true" />
                    <span className="truncate">{resource.path}</span>
                  </button>
                ))}
                {editable ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const used = new Set(form.resources.map((resource) => resource.path));
                      let number = 1;
                      let path = "references/reference.md";
                      while (used.has(path)) {
                        number += 1;
                        path = `references/reference-${number}.md`;
                      }
                      const index = form.resources.length;
                      update({
                        resources: [
                          ...form.resources,
                          { path, mediaType: "text/markdown", content: "" }
                        ]
                      });
                      setSelectedResource(index);
                    }}
                  >
                    <Plus size={14} aria-hidden="true" />
                    {t("configAddResource")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        }
      >
        {selectedResource === "root" || !form.resources[selectedResource] ? (
          <Field
            label={t("configContent")}
            hint={t("configSkillContentHint")}
            className="h-full grid-rows-[auto_minmax(24rem,1fr)_auto]"
          >
            <EditorTextarea
              label={t("configMarkdown")}
              value={form.content}
              required
              readOnly={!editable}
              className="min-h-96"
              onChange={(event) => update({ content: event.target.value })}
            />
          </Field>
        ) : (
          <SkillResourceEditor
            resource={form.resources[selectedResource]}
            editable={editable}
            onChange={(resource) =>
              update({
                resources: form.resources.map((candidate, index) =>
                  index === selectedResource ? resource : candidate
                )
              })
            }
            onRemove={() => {
              update({
                resources: form.resources.filter((_, index) => index !== selectedResource)
              });
              setSelectedResource("root");
            }}
          />
        )}
      </EditorSection>

      {revisions}

      {error ? (
        <p role="alert" className="px-5 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {editable ? (
        <SaveBar
          label={isNew ? t("configCreateSkill") : t("configSaveChanges")}
          mutating={mutating}
          saved={savedForm === form}
        />
      ) : null}

      {onDelete ? (
        <DeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          kind="skill"
          name={form.name}
          onConfirm={async () => {
            setDeleteOpen(false);
            setError((await onDelete()).error);
          }}
        />
      ) : null}
    </form>
  );
}

function SkillResourceEditor({
  resource,
  editable,
  onChange,
  onRemove
}: {
  resource: SkillFormState["resources"][number];
  editable: boolean;
  onChange(resource: SkillFormState["resources"][number]): void;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid h-full min-w-0 grid-rows-[auto_minmax(24rem,1fr)] gap-4">
      <div
        className={cn(
          "grid gap-4",
          editable ? "sm:grid-cols-[minmax(0,1fr)_12rem_auto]" : "sm:grid-cols-[minmax(0,1fr)_auto]"
        )}
      >
        <Field label={t("configResourcePath")}>
          {editable ? (
            <Input
              value={resource.path}
              required
              onChange={(event) => onChange({ ...resource, path: event.target.value })}
            />
          ) : (
            <code className="block min-w-0 truncate py-2 text-sm" title={resource.path}>
              {resource.path}
            </code>
          )}
        </Field>
        <Field label={t("configResourceType")}>
          {editable ? (
            <Select
              value={resource.mediaType}
              onChange={(event) => onChange({ ...resource, mediaType: event.target.value })}
            >
              {SKILL_RESOURCE_MEDIA_TYPES.map((mediaType) => (
                <option key={mediaType} value={mediaType}>
                  {mediaType}
                </option>
              ))}
            </Select>
          ) : (
            <span className="block py-2 text-sm">{resource.mediaType}</span>
          )}
        </Field>
        {editable ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-end text-muted-foreground"
            onClick={onRemove}
          >
            <X size={14} aria-hidden="true" />
            {t("configRemove")}
          </Button>
        ) : null}
      </div>
      <EditorTextarea
        label={t("configResourceContent")}
        value={resource.content}
        readOnly={!editable}
        className="min-h-96"
        onChange={(event) => onChange({ ...resource, content: event.target.value })}
      />
    </div>
  );
}

export function RevisionHistory({
  kind,
  name,
  mutating,
  onLoadRevisions,
  onRevert
}: {
  kind: ConfigAssetKind;
  name: string;
  mutating: boolean;
  onLoadRevisions(kind: ConfigAssetKind, name: string): Promise<ConfigAssetRevision[]>;
  onRevert?: (revision: number) => Promise<MutationOutcome>;
}) {
  const { locale, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<ConfigAssetRevision[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && revisions === undefined) {
      try {
        setRevisions(await onLoadRevisions(kind, name));
      } catch (loadError) {
        setError(apiErrorMessage(loadError, t("configRevisionLoadFailed")));
      }
    }
  };

  const currentRevision = useMemo(
    () => revisions?.reduce((max, revision) => Math.max(max, revision.revision), 0),
    [revisions]
  );

  return (
    <section className="grid border-t">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-5 py-4 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
        aria-expanded={open}
        onClick={toggle}
      >
        <History size={14} aria-hidden="true" />
        {t("configRevisionHistory")}
        <ChevronDown
          size={15}
          aria-hidden="true"
          className={cn("ml-auto transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div className="border-t bg-muted/10 px-5 py-4">
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : revisions === undefined ? (
            <Spinner className="size-4" />
          ) : revisions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("configNoRevisions")}</p>
          ) : (
            <ul className="divide-y overflow-hidden rounded-lg border bg-background">
              {[...revisions].reverse().map((revision) => {
                const action = configRevisionAction(
                  revision.revision,
                  currentRevision,
                  Boolean(onRevert && revision.config !== null)
                );
                return (
                  <li
                    key={revision.revision}
                    className="grid min-w-0 items-center gap-2 px-3 py-2.5 text-xs sm:grid-cols-[auto_auto_minmax(0,1fr)_auto]"
                  >
                    <span className="font-mono font-medium">#{revision.revision}</span>
                    <Badge variant="outline" className="w-fit capitalize">
                      {t(
                        revision.operation === "create"
                          ? "configRevisionCreate"
                          : revision.operation === "update"
                            ? "configRevisionUpdate"
                            : revision.operation === "delete"
                              ? "configRevisionDelete"
                              : "configRevisionRevert"
                      )}
                    </Badge>
                    <span className="min-w-0 text-muted-foreground">
                      {new Date(revision.createdAt).toLocaleString(locale)}
                      {revision.actor ? ` · ${revision.actor.displayLabel}` : ""}
                    </span>
                    {action === "current" ? (
                      <span className="text-right text-muted-foreground">{t("configCurrent")}</span>
                    ) : action === "restore" && onRevert ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 w-fit px-2 text-xs"
                        disabled={mutating}
                        onClick={async () => {
                          const outcome = await onRevert(revision.revision);
                          if (outcome.ok) {
                            setRevisions(undefined);
                            setOpen(false);
                          } else if (outcome.error) {
                            setError(outcome.error);
                          }
                        }}
                      >
                        {t("configRestore")}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function configRevisionAction(
  revision: number,
  currentRevision: number | undefined,
  canRevert: boolean
): "current" | "restore" | undefined {
  if (revision === currentRevision) {
    return "current";
  }
  return canRevert ? "restore" : undefined;
}

function EditorHeader({
  eyebrow,
  title,
  identifier,
  badges,
  actions
}: {
  eyebrow: string;
  title: string;
  identifier?: string;
  badges: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-4 border-b px-5 py-5">
      <div className="grid min-w-0 gap-1">
        <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
          {eyebrow}
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="min-w-0 break-words text-lg font-semibold tracking-normal">{title}</h2>
          {badges}
        </div>
        {identifier ? (
          <code className="min-w-0 truncate text-xs text-muted-foreground" title={identifier}>
            {identifier}
          </code>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
    </header>
  );
}

function EditorSection({
  title,
  description,
  sidebar,
  children
}: {
  title: string;
  description: string;
  sidebar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "grid min-w-0 gap-4 border-b px-5 py-6 xl:grid-cols-[11rem_minmax(0,1fr)] xl:gap-6",
        sidebar && "xl:grid-cols-[16rem_minmax(0,1fr)]"
      )}
    >
      <div className="grid content-start gap-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
        {sidebar}
      </div>
      <div className="grid h-full min-w-0 gap-5">{children}</div>
    </section>
  );
}

function EditorTextarea({
  label,
  className,
  ...props
}: React.ComponentProps<typeof Textarea> & { label: string }) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-muted/15 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
      <div className="flex h-9 items-center border-b bg-muted/20 px-3 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      <Textarea
        {...props}
        className={cn(
          "min-h-0 flex-1 resize-y rounded-none border-0 bg-transparent p-4 font-mono text-[13px] leading-6 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:[color-scheme:dark]",
          className
        )}
      />
    </div>
  );
}

function SaveBar({
  label,
  mutating,
  saved,
  disabled = false
}: {
  label: string;
  mutating: boolean;
  /** True after a successful save, until the form changes again. */
  saved: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-3 bg-muted/10 px-5 py-4">
      <Button type="submit" className="w-full sm:w-auto" disabled={mutating || disabled}>
        {mutating ? <Spinner className="size-4" /> : null}
        {label}
      </Button>
      {saved && !mutating ? (
        <span
          role="status"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-success"
          data-testid="config-saved-notice"
        >
          <Check size={15} aria-hidden="true" />
          {t("configChangesSaved")}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">{t("configAppliesImmediately")}</span>
      )}
    </div>
  );
}
