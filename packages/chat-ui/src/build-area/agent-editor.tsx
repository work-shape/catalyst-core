import { Star } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type {
  AdministeredCollaborationWorkspace,
  ConfigAssetReferences
} from "@vivd-catalyst/api-client";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Chip,
  Field,
  FormNotice,
  Input,
  Picker,
  PickerButton,
  RadioGroup,
  Select,
  Switch,
  Textarea
} from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { modelDisplayLabel } from "../model-label";
import { useModuleName } from "../module-texts";
import { AssetEditorShell, useAssetForm, type AssetSection } from "./asset-editor-shell";
import {
  CheckboxGroup,
  FieldRefusals,
  InitialPromptsEditor,
  LocalizedField
} from "./asset-form-fields";
import {
  agentAvailabilityFormsEqual,
  agentAvailabilityToForm,
  agentMissingTranslations,
  agentModelReasoningEffort,
  agentModelRows,
  countChangedFields,
  editedAgentConfig,
  selectAgentModelBinding,
  setAgentModelReasoningEffort,
  setAgentModelUserSelectable,
  type AgentAvailabilityForm,
  type AgentFormState
} from "./asset-form-model";
import type { BuildAssetEditorProps } from "./build-asset-kind";
import { refusalsOf } from "./build-refusals";
import { isConnectionToolName, type ConnectionToolChoice } from "./connection-tools";
import { ConnectionToolsGroup } from "./connection-tools-group";

/** The skills an agent can be given, as far as the instance was asked for them. */
export interface SkillChoice {
  /** The skills that match what the reader typed, a page of them. */
  options: readonly { name: string; title: string }[];
  /** The reader typed into the search: the instance is asked for the skills that match. */
  onSearch(text: string): void;
}

export function AgentEditor({
  frame,
  initialForm,
  isDefault,
  references,
  editableAgentFields,
  canManageAgentModels,
  skillChoice,
  connectionTools = NO_CONNECTION_TOOLS,
  onMakeDefault,
  availability
}: {
  frame: BuildAssetEditorProps;
  initialForm: AgentFormState;
  isDefault: boolean;
  references: ConfigAssetReferences | undefined;
  /** The fields the instance lets people change. The model settings follow their own right. */
  editableAgentFields: readonly string[];
  canManageAgentModels: boolean;
  skillChoice: SkillChoice;
  /** The tools of Connections on offer. Left out, the page shows only those the agent holds. */
  connectionTools?: ConnectionToolChoice;
  /** Makes the agent the instance's default. Answers with what went wrong, if anything did. */
  onMakeDefault?: () => Promise<string | undefined>;
  /** Saved on its own, so it sits outside the agent form's save. */
  availability?: ReactNode;
}) {
  const { locale, t } = useTranslation();
  const state = useAssetForm(initialForm);
  const { form, setForm, outcome } = state;
  const [saving, setSaving] = useState(false);
  const [defaultError, setDefaultError] = useState<string>();
  const moduleName = useModuleName();
  const { canWrite } = frame;
  const canEdit = (field: string) => canWrite && editableAgentFields.includes(field);
  const canEditModel = canWrite && canManageAgentModels;
  const canEditMaxSteps = canEdit("maxSteps");
  const modelBindings = useMemo(
    () =>
      references?.modelBindings ??
      references?.modelBindingIds.map((id) => ({ id, model: id })) ??
      [],
    [references]
  );
  const modelBindingIds = modelBindings.map((binding) => binding.id);
  const showModels =
    canEditModel ||
    Boolean(form.modelBindingId || form.modelProviderId || form.reasoningEffort) ||
    form.userSelectableModelBindingIds.some((id) => modelBindingIds.includes(id));
  const showMaxSteps = canEditMaxSteps || Boolean(form.maxSteps);
  const fastModeModelBindingIds = references?.fastModeModelBindingIds ?? [];
  const showFastMode = form.fastMode || fastModeModelBindingIds.includes(form.modelBindingId);

  const update = (patch: Partial<AgentFormState>) => setForm((value) => ({ ...value, ...patch }));
  const submit = async () => {
    setSaving(true);
    const answer = await frame.save(editedAgentConfig(form, frame.asset?.config));
    setSaving(false);
    state.setOutcome(answer);
    if (answer.ok) {
      state.markSaved();
    }
    return answer;
  };
  const skillTitles = new Map(skillChoice.options.map((skill) => [skill.name, skill.title]));

  const sections: AssetSection[] = [
    {
      id: "overview",
      label: t("build.sectionOverview"),
      description: t("configIdentityDescription"),
      body: (
        <>
          <LocalizedField
            label={t("configDisplayName")}
            required
            readOnly={!canEdit("displayName")}
            value={form.displayName}
            onChange={(displayName) => update({ displayName })}
          />
          <LocalizedField
            label={t("configDescription")}
            readOnly={!canEdit("description")}
            value={form.description}
            onChange={(description) => update({ description })}
          />
          <LocalizedField
            label={t("configWelcomeMessage")}
            readOnly={!canEdit("welcomeMessage")}
            value={form.welcomeMessage}
            onChange={(welcomeMessage) => update({ welcomeMessage })}
          />
          <LocalizedField
            label={t("configWelcomeSubtitle")}
            readOnly={!canEdit("welcomeSubtitle")}
            value={form.welcomeSubtitle}
            onChange={(welcomeSubtitle) => update({ welcomeSubtitle })}
          />
        </>
      )
    },
    {
      id: "instructions",
      label: t("configInstructions"),
      body: (
        <>
          <Field
            label={t("configSystemPrompt")}
            hint={t("configSystemPromptHint")}
            required={canEdit("instructions")}
          >
            <Textarea
              variant="code"
              className="min-h-72"
              value={form.instructions}
              readOnly={!canEdit("instructions")}
              onChange={(event) => update({ instructions: event.target.value })}
            />
          </Field>
          {showMaxSteps ? (
            <Field label={t("configMaxSteps")} hint={t("configMaxStepsHint")}>
              <Input
                type="number"
                min={1}
                value={form.maxSteps}
                readOnly={!canEditMaxSteps}
                onChange={(event) => update({ maxSteps: event.target.value })}
              />
            </Field>
          ) : null}
        </>
      )
    },
    ...(showModels
      ? [
          {
            id: "model",
            label: t("build.sectionModel"),
            description: t("configModelsHint"),
            refusalField: "model" as const,
            body: (
              <>
                <AgentModels
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
                      setAgentModelUserSelectable(
                        value,
                        modelBindingId,
                        userSelectable,
                        modelBindingIds
                      )
                    )
                  }
                  onSetReasoningEffort={(modelBindingId, reasoningEffort) =>
                    setForm((value) =>
                      setAgentModelReasoningEffort(value, modelBindingId, reasoningEffort)
                    )
                  }
                />
                {showFastMode ? (
                  <Field layout="inline" label={t("configFastMode")} hint={t("configFastModeHint")}>
                    <Switch
                      checked={form.fastMode}
                      disabled={!canEditModel}
                      onCheckedChange={(fastMode) => update({ fastMode })}
                    />
                  </Field>
                ) : null}
                <FieldRefusals messages={refusalsOf(outcome, "model")} />
              </>
            )
          }
        ]
      : []),
    {
      id: "skills",
      label: t("configSkills"),
      count: form.skillNames.length,
      refusalField: "skills",
      body: (
        <>
          {form.skillNames.length === 0 ? (
            <p className="text-body text-muted-foreground">{t("build.noSkillsChosen")}</p>
          ) : (
            <ul aria-label={t("configSkills")} className="flex flex-wrap gap-2">
              {form.skillNames.map((name) => (
                <li key={name}>
                  <Chip
                    onRemove={
                      canEdit("skillNames")
                        ? () =>
                            update({
                              skillNames: form.skillNames.filter((entry) => entry !== name)
                            })
                        : undefined
                    }
                  >
                    {skillTitles.get(name) ?? name}
                  </Chip>
                </li>
              ))}
            </ul>
          )}
          {canEdit("skillNames") ? (
            <div>
              <Picker
                multiple
                search
                label={t("build.chooseSkills")}
                onSearchChange={skillChoice.onSearch}
                options={skillChoice.options.map((skill) => ({
                  value: skill.name,
                  label: skill.title || skill.name,
                  description: skill.name
                }))}
                value={form.skillNames}
                onValueChange={(skillNames) => update({ skillNames })}
              >
                <PickerButton
                  label={t("configSkills")}
                  placeholder={t("build.chooseSkills")}
                  value={undefined}
                />
              </Picker>
            </div>
          ) : null}
          {form.skillNames.length > 0 && !form.toolNames.includes("read_skill") ? (
            <Banner tone="warning">{t("configSkillsRequireReadSkill")}</Banner>
          ) : null}
          <FieldRefusals messages={refusalsOf(outcome, "skills")} />
        </>
      )
    },
    {
      id: "tools",
      label: t("configTools"),
      count: form.toolNames.length,
      refusalField: "tools",
      // One group per source of tools, each a sibling with its heading: the instance's own,
      // then the Connections. A further source is a further sibling.
      body: (
        <>
          <CheckboxGroup
            label={t("configToolsOfInstance")}
            description={t("configToolsOfInstanceHint")}
            options={toolOptions(references, form.toolNames)}
            selected={form.toolNames}
            unavailable={(references?.moduleOffTools ?? []).map((tool) => ({
              option: tool.name,
              reason: t("configToolModuleOff", { module: moduleName(tool.module) })
            }))}
            disabled={!canEdit("toolNames")}
            emptyHint={t("configNoTools")}
            onChange={(toolNames) => update({ toolNames })}
          />
          <ConnectionToolsGroup
            choice={connectionTools}
            selected={form.toolNames}
            disabled={!canEdit("toolNames")}
            onChange={(toolNames) => update({ toolNames })}
          />
          <FieldRefusals messages={refusalsOf(outcome, "tools")} />
        </>
      )
    },
    {
      id: "prompts",
      label: t("configStarterPrompts"),
      description: t("configStarterPromptsDescription"),
      count: form.initialPrompts.length,
      body: (
        <InitialPromptsEditor
          prompts={form.initialPrompts}
          disabled={!canEdit("initialPrompts")}
          onChange={(initialPrompts) => update({ initialPrompts })}
        />
      )
    },
    ...(availability
      ? [
          {
            id: "availability",
            label: t("configAvailability"),
            description: t("configAvailabilityDescription"),
            body: availability
          }
        ]
      : [])
  ];

  return (
    <AssetEditorShell
      frame={{
        ...frame,
        canWrite: canWrite && (editableAgentFields.length > 0 || canManageAgentModels)
      }}
      kindLabel={t("configAgent")}
      title={
        form.displayName[locale].trim() ||
        form.displayName[locale === "de" ? "en" : "de"].trim() ||
        form.name
      }
      badges={isDefault ? <Badge>{t("configDefaultAgent")}</Badge> : null}
      headActions={
        <>
          {defaultError ? <FormNotice tone="error">{defaultError}</FormNotice> : null}
          {onMakeDefault ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onMakeDefault().then(setDefaultError, () => undefined);
              }}
            >
              <Star aria-hidden="true" />
              {t("configMakeDefault")}
            </Button>
          ) : null}
        </>
      }
      sections={sections}
      missingTranslations={agentMissingTranslations(form)}
      control={{
        changes: countChangedFields(form, state.baseline),
        submit,
        discard: state.discard
      }}
      outcome={outcome}
      saving={saving}
      saveLabel={frame.asset ? t("configSaveChanges") : t("configCreateAgent")}
    />
  );
}

/** What the page is handed while nobody asked the instance for the tools of Connections. */
const NO_CONNECTION_TOOLS: ConnectionToolChoice = { read: { status: "unknown" } };

/**
 * The instance's own tools on offer, and the ones the agent names that the reader was not told
 * of. A tool of a Connection is shown in the group of the Connections.
 */
function toolOptions(
  references: ConfigAssetReferences | undefined,
  selected: readonly string[]
): string[] {
  const offered = references?.enabledToolNames ?? [];
  const off = new Set((references?.moduleOffTools ?? []).map((tool) => tool.name));
  return [
    ...offered,
    ...selected.filter(
      (name) => !offered.includes(name) && !off.has(name) && !isConnectionToolName(name)
    )
  ];
}

/**
 * Where an agent can be chosen. It is stored apart from the agent's definition and has its own
 * save, so it does not depend on which agent fields are editable.
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
  workspaces: readonly AdministeredCollaborationWorkspace[];
  workspacesError?: string;
  mutating: boolean;
  /** Answers with what went wrong, if anything did. */
  onSave(availability: AgentAvailabilityForm): Promise<string | undefined>;
}) {
  const { t } = useTranslation();
  const saved = useMemo(() => agentAvailabilityToForm(availability), [availability]);
  const [form, setForm] = useState(saved);
  const [error, setError] = useState<string>();
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
    <>
      <RadioGroup
        variant="plain"
        label={t("configAvailability")}
        hint={locked ? t("configAvailabilityDefaultLocked") : undefined}
        disabled={disabled}
        value={form.mode}
        onValueChange={(mode) => update({ mode })}
        options={[
          {
            value: "all",
            label: t("configAvailabilityAll"),
            description: t("configAvailabilityAllHint")
          },
          { value: "selected", label: t("configAvailabilitySelected") }
        ]}
      />

      {form.mode === "selected" ? (
        <>
          <Checkbox
            checked={form.personalWorkspaces}
            disabled={disabled}
            label={t("configAvailabilityPersonal")}
            description={t("configAvailabilityPersonalHint")}
            onCheckedChange={(personalWorkspaces) => update({ personalWorkspaces })}
          />
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

      {error ? <FormNotice tone="error">{error}</FormNotice> : null}

      {locked ? null : (
        <div>
          <Button
            variant="outline"
            size="sm"
            loading={mutating}
            disabled={agentAvailabilityFormsEqual(form, saved)}
            onClick={() => {
              onSave(form).then(setError, () => undefined);
            }}
          >
            {t("configAvailabilitySave")}
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * The agent's models: which one runs the agent, and which ones its users may pick instead.
 * Read-only, the list below the default holds only the models people may choose.
 */
function AgentModels({
  form,
  modelBindings,
  reasoningEfforts,
  editable,
  onSelectDefault,
  onSetUserSelectable,
  onSetReasoningEffort
}: {
  form: AgentFormState;
  modelBindings: readonly { id: string; model: string; label?: string }[];
  reasoningEfforts: readonly string[];
  editable: boolean;
  onSelectDefault(modelBindingId: string): void;
  onSetUserSelectable(modelBindingId: string, userSelectable: boolean): void;
  onSetReasoningEffort(modelBindingId: string, reasoningEffort: string): void;
}) {
  const { t } = useTranslation();
  const rows = agentModelRows(form, modelBindings).map((row) => ({
    ...row,
    label: modelBindingLabel(
      modelBindings.find((binding) => binding.id === row.bindingId) ?? {
        id: row.bindingId,
        model: row.model
      },
      modelBindings
    )
  }));
  const others = rows.filter((row) => !row.isDefault && (editable || row.userSelectable));
  const instanceDefaultLabel = form.modelProviderId
    ? `${t("configInstanceDefault")} (${form.modelProviderId})`
    : t("configInstanceDefault");
  const effortSelect = (bindingId: string, label: string) => (
    <Select
      size="sm"
      aria-label={`${label}: ${t("configReasoningEffort")}`}
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
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("build.defaultModel")}>
          <Select
            value={form.modelBindingId}
            disabled={!editable}
            onChange={(event) => onSelectDefault(event.target.value)}
          >
            <option value="">{instanceDefaultLabel}</option>
            {rows.map((row) => (
              <option key={row.bindingId} value={row.bindingId}>
                {row.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("configReasoningEffort")}>
          {effortSelect(form.modelBindingId, t("build.defaultModel"))}
        </Field>
      </div>
      {others.length > 0 ? (
        <fieldset className="grid min-w-0 gap-2">
          <legend className="pb-2 text-label">{t("build.selectableModels")}</legend>
          {others.map((row) => (
            <div
              key={row.bindingId}
              data-model-binding={row.bindingId}
              className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-1"
            >
              <Checkbox
                checked={row.userSelectable}
                disabled={!editable}
                label={row.label}
                onCheckedChange={(checked) => onSetUserSelectable(row.bindingId, checked)}
              />
              {row.userSelectable ? (
                <div className="w-40 shrink-0">{effortSelect(row.bindingId, row.label)}</div>
              ) : null}
            </div>
          ))}
        </fieldset>
      ) : null}
    </>
  );
}

function modelBindingLabel(
  binding: { id: string; model: string; label?: string },
  bindings: readonly { id: string; model: string }[]
): string {
  const duplicateModel = bindings.some(
    (candidate) => candidate.id !== binding.id && candidate.model === binding.model
  );
  const label = modelDisplayLabel(binding);
  return duplicateModel ? `${label} (${binding.id})` : label;
}
