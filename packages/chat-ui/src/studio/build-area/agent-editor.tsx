import { Star } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  AdministeredCollaborationWorkspace,
  ConfigAssetReferences
} from "@work-shape/catalyst-api-client";
import {
  Badge,
  Checkbox,
  Chip,
  Field,
  FormNotice,
  Input,
  Picker,
  PickerButton,
  RadioGroup,
  Select,
  SkillIcon,
  Switch,
  Textarea
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { modelDisplayLabel } from "../../shared/model-label";
import { reasoningEffortLabel } from "../../shared/reasoning-effort-label";
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
import { refusalsOf, type BuildWriteOutcome } from "./build-refusals";
import { AppToolsGroup, isAppToolName, type AppToolsRead } from "../apps/app-tools-group";
import type { ConnectionToolChoice } from "./connection-tools";
import { heldToolCount, toolPackages } from "./instance-tools";
import { AgentUnavailableNotices, savedAgentUnavailable } from "./agent-unavailable";
import { ToolPackagesSection } from "./tool-packages-section";
import { AgentKnowledge, type KnowledgeBaseChoice } from "./agent-knowledge";
import {
  AgentProposalNotice,
  ProposedSectionMark,
  proposedFieldsView,
  type ProposalTitles
} from "./agent-proposal";
import type { AgentProposalState } from "./agent-proposal-source";
import { PlatformInstructions } from "./platform-instructions";
import type { SkillFacts } from "./skill-facts";

/**
 * Where an agent can be chosen. It is stored beside the agent's definition and saved with it
 * through the page's save bar, whichever agent fields the instance lets people change.
 */
export interface AgentAvailabilityChoice {
  saved: AgentAvailabilityForm | undefined;
  workspaces: readonly AdministeredCollaborationWorkspace[];
  workspacesError?: string;
  /** Answers with what went wrong, if anything did. */
  save(availability: AgentAvailabilityForm): Promise<string | undefined>;
}

/** The skills an agent can be given, as far as the instance was asked for them. */
export interface SkillChoice {
  /** The skills that match what the reader typed, a page of them. */
  options: readonly ({ name: string; title: string } & SkillFacts)[];
  /** The reader typed into the search: the instance is asked for the skills that match. */
  onSearch(text: string): void;
}

export function AgentEditor({
  frame,
  initialForm,
  isDefault,
  references,
  referencesLoading = false,
  editableAgentFields,
  canManageAgentModels,
  skillChoice,
  knowledgeChoice,
  connectionTools = NO_CONNECTION_TOOLS,
  appTools = NO_APP_TOOLS,
  onMakeDefault,
  availability,
  proposal
}: {
  frame: BuildAssetEditorProps;
  initialForm: AgentFormState;
  isDefault: boolean;
  references: ConfigAssetReferences | undefined;
  /**
   * The references are on their way. The Tools section waits for them, so no tool shows by its
   * id before its package is known. Without references after that, the agent's own names show.
   */
  referencesLoading?: boolean;
  /** The fields the instance lets people change. The model settings follow their own right. */
  editableAgentFields: readonly string[];
  canManageAgentModels: boolean;
  skillChoice: SkillChoice;
  /** The Knowledge Bases on offer. Left out where the instance has none: the section is not shown. */
  knowledgeChoice?: KnowledgeBaseChoice;
  /** The tools of Connections on offer. Left out, the page shows only those the agent holds. */
  connectionTools?: ConnectionToolChoice;
  /** The actions of Apps on offer. Left out, the page shows only those the agent holds. */
  appTools?: AppToolsRead;
  /** Makes the agent the instance's default. Answers with what went wrong, if anything did. */
  onMakeDefault?: () => Promise<string | undefined>;
  /** Where the agent can be chosen, for a reader who may change it. */
  availability?: AgentAvailabilityChoice;
  /** The change the agent in the dock proposes for this agent, where it proposed one. */
  proposal?: AgentProposalState;
}) {
  const { locale, t } = useTranslation();
  const state = useAssetForm(initialForm);
  const { form, setForm, outcome } = state;
  const [saving, setSaving] = useState(false);
  const [defaultError, setDefaultError] = useState<string>();
  const { canWrite } = frame;
  const savedAvailability = useMemo(
    () => agentAvailabilityToForm(availability?.saved),
    [availability?.saved]
  );
  const [availabilityForm, setAvailabilityForm] = useState(savedAvailability);
  const availabilityChanged =
    availability !== undefined && !agentAvailabilityFormsEqual(availabilityForm, savedAvailability);
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
  const skillsByName = new Map(skillChoice.options.map((skill) => [skill.name, skill]));
  const titles: ProposalTitles = {
    skill: (name) => skillsByName.get(name)?.title || name,
    tool: (name) =>
      references?.tools?.find((tool) => tool.name === name)?.title?.[locale].trim() || name,
    knowledgeBase: (name) =>
      knowledgeChoice?.options.find((option) => option.name === name)?.title || name,
    model: (id) => {
      const binding = modelBindings.find((candidate) => candidate.id === id);
      return binding ? modelBindingLabel(binding, modelBindings) : id;
    }
  };
  // What the proposal changes against the agent as loaded or last saved, with its value
  // under each field it changes.
  const proposed = proposedFieldsView(proposal, state.baseline, titles);
  // The proposal names the agent it changes as people know it now, not as the form edits it.
  const liveTitle =
    state.baseline.displayName[locale].trim() ||
    state.baseline.displayName[locale === "de" ? "en" : "de"].trim() ||
    state.baseline.name;
  const showModels =
    canEditModel ||
    proposed.fields.includes("model") ||
    Boolean(form.modelBindingId || form.modelProviderId || form.reasoningEffort) ||
    form.userSelectableModelBindingIds.some((id) => modelBindingIds.includes(id));
  const showMaxSteps =
    canEditMaxSteps || Boolean(form.maxSteps) || proposed.fields.includes("maxSteps");
  const fastModeModelBindingIds = references?.fastModeModelBindingIds ?? [];
  const showFastMode = form.fastMode || fastModeModelBindingIds.includes(form.modelBindingId);

  const update = (patch: Partial<AgentFormState>) => setForm((value) => ({ ...value, ...patch }));
  const changedFields = countChangedFields(form, state.baseline);
  // One save bar for the agent and where it can be chosen: the agent first, then its
  // availability, each only when it changed.
  const submit = async (): Promise<BuildWriteOutcome> => {
    setSaving(true);
    const saved: BuildWriteOutcome =
      frame.asset === undefined || changedFields > 0
        ? await frame.save(
            editedAgentConfig(form, frame.asset?.config, references?.enabledToolNames)
          )
        : { ok: true };
    if (saved.ok) {
      state.markSaved();
    }
    const refused =
      saved.ok && availability !== undefined && availabilityChanged
        ? await availability.save(availabilityForm)
        : undefined;
    const answer: BuildWriteOutcome =
      refused === undefined
        ? saved
        : { ok: false, conflict: false, refusals: [{ field: "availability", message: refused }] };
    setSaving(false);
    state.setOutcome(answer);
    return answer;
  };
  // What the agent's read reported unavailable, as far as the last save left it named.
  const unavailable = savedAgentUnavailable(frame.asset, state.baseline);

  const sections: AssetSection[] = [
    {
      id: "overview",
      label: t("build.sectionOverview"),
      description: t("configIdentityDescription"),
      body: (
        <>
          {proposed.around(
            "displayName",
            <LocalizedField
              label={t("configDisplayName")}
              required
              readOnly={!canEdit("displayName")}
              value={form.displayName}
              onChange={(displayName) => update({ displayName })}
            />
          )}
          {proposed.around(
            "description",
            <LocalizedField
              label={t("configDescription")}
              readOnly={!canEdit("description")}
              value={form.description}
              onChange={(description) => update({ description })}
            />
          )}
          {proposed.around(
            "welcomeMessage",
            <LocalizedField
              label={t("configWelcomeMessage")}
              readOnly={!canEdit("welcomeMessage")}
              value={form.welcomeMessage}
              onChange={(welcomeMessage) => update({ welcomeMessage })}
            />
          )}
          {proposed.around(
            "welcomeSubtitle",
            <LocalizedField
              label={t("configWelcomeSubtitle")}
              readOnly={!canEdit("welcomeSubtitle")}
              value={form.welcomeSubtitle}
              onChange={(welcomeSubtitle) => update({ welcomeSubtitle })}
            />
          )}
        </>
      )
    },
    {
      id: "instructions",
      label: t("configInstructions"),
      body: (
        <>
          <PlatformInstructions
            instructions={references?.platformInstructions}
            toolNames={state.baseline.toolNames}
          />
          {proposed.around(
            "instructions",
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
          )}
          {proposed.around(
            "maxSteps",
            showMaxSteps ? (
              <Field label={t("configMaxSteps")} hint={t("configMaxStepsHint")}>
                <Input
                  type="number"
                  min={1}
                  value={form.maxSteps}
                  readOnly={!canEditMaxSteps}
                  onChange={(event) => update({ maxSteps: event.target.value })}
                />
              </Field>
            ) : null
          )}
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
                  setByModelManagers={canWrite && !canManageAgentModels}
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
                {proposed.value("model")}
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
                    leading={<SkillIcon icon={skillsByName.get(name)?.icon} size="sm" />}
                    onRemove={
                      canEdit("skillNames")
                        ? () =>
                            update({
                              skillNames: form.skillNames.filter((entry) => entry !== name)
                            })
                        : undefined
                    }
                  >
                    {skillsByName.get(name)?.title || name}
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
                wrapDescriptions
                className="w-120"
                label={t("build.chooseSkills")}
                note={t("build.skillsNote")}
                onSearchChange={skillChoice.onSearch}
                // A skill without a summary shows its title alone. Its id is never shown and
                // is still found by the search.
                options={skillChoice.options.map((skill) => ({
                  value: skill.name,
                  label: skill.title || skill.name,
                  description: skill.summary,
                  keywords: skill.name,
                  leading: <SkillIcon icon={skill.icon} />
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
          {proposed.value("skillNames")}
          <FieldRefusals messages={refusalsOf(outcome, "skills")} />
        </>
      )
    },
    ...(knowledgeChoice
      ? [
          {
            id: "knowledge",
            label: t("knowledge.agentSection"),
            description: t("knowledge.agentSectionDescription"),
            count: form.knowledgeBases.length,
            refusalField: "knowledge" as const,
            body: (
              <>
                <AgentKnowledge
                  choice={knowledgeChoice}
                  value={form.knowledgeBases}
                  editable={canEdit("knowledgeBases")}
                  onChange={(knowledgeBases) => update({ knowledgeBases })}
                />
                {proposed.value("knowledgeBases")}
                <FieldRefusals messages={refusalsOf(outcome, "knowledge")} />
              </>
            )
          }
        ]
      : []),
    {
      id: "tools",
      label: t("configTools"),
      // The tools that are on: what the rows add up to, and the Apps' tools after them.
      count:
        heldToolCount(
          toolPackages({
            references,
            selected: form.toolNames,
            skillNames: form.skillNames,
            locale,
            connections: connectionTools.read,
            unavailable: unavailable?.unavailableTools?.map((tool) => tool.name) ?? [],
            isOtherSource: isAppToolName
          })
        ) + form.toolNames.filter(isAppToolName).length,
      refusalField: "tools",
      description: t("configToolsDescription"),
      // A row per package, per own tool of this instance and per Connection; then the Apps.
      body: (
        <>
          <ToolPackagesSection
            references={references}
            loading={referencesLoading}
            selected={form.toolNames}
            skillNames={form.skillNames}
            connectionTools={connectionTools}
            unavailable={unavailable?.unavailableTools ?? []}
            isOtherSource={isAppToolName}
            disabled={!canEdit("toolNames")}
            onChange={(toolNames) => update({ toolNames })}
          />
          <AppToolsGroup
            read={appTools}
            selected={form.toolNames}
            disabled={!canEdit("toolNames")}
            onChange={(toolNames) => update({ toolNames })}
          />
          {proposed.value("toolNames")}
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
        <>
          <InitialPromptsEditor
            prompts={form.initialPrompts}
            disabled={!canEdit("initialPrompts")}
            onChange={(initialPrompts) => update({ initialPrompts })}
          />
          {proposed.value("initialPrompts")}
        </>
      )
    },
    ...(availability
      ? [
          {
            id: "availability",
            label: t("configAvailability"),
            description: t("configAvailabilityDescription"),
            refusalField: "availability" as const,
            body: (
              <AgentAvailabilityFields
                form={availabilityForm}
                locked={isDefault && savedAvailability.mode === "all"}
                disabled={saving}
                workspaces={availability.workspaces}
                workspacesError={availability.workspacesError}
                refusals={refusalsOf(outcome, "availability")}
                onChange={setAvailabilityForm}
              />
            )
          }
        ]
      : [])
  ];

  return (
    <AssetEditorShell
      frame={{
        ...frame,
        canWrite:
          canWrite &&
          (editableAgentFields.length > 0 || canManageAgentModels || availability !== undefined)
      }}
      title={
        form.displayName[locale].trim() ||
        form.displayName[locale === "de" ? "en" : "de"].trim() ||
        form.name
      }
      description={
        form.description[locale].trim() || form.description[locale === "de" ? "en" : "de"].trim()
      }
      badges={isDefault ? <Badge>{t("configDefaultAgent")}</Badge> : null}
      notices={
        <>
          {proposal ? (
            <AgentProposalNotice
              state={proposal}
              name={liveTitle}
              changes={proposed.fields.length}
              unsaved={changedFields > 0 || availabilityChanged}
            />
          ) : null}
          {defaultError ? <FormNotice tone="error">{defaultError}</FormNotice> : null}
          <AgentUnavailableNotices status={unavailable} />
        </>
      }
      headActions={
        onMakeDefault
          ? [
              {
                label: t("configMakeDefault"),
                icon: <Star aria-hidden="true" />,
                onSelect: () => {
                  onMakeDefault().then(setDefaultError, () => undefined);
                }
              }
            ]
          : undefined
      }
      sections={sections.map((section) => ({
        ...section,
        ...(proposed.sections.has(section.id) ? { state: <ProposedSectionMark /> } : {}),
        // While Apply or Discard is on its way nothing is typed: an Apply reads the page again.
        body: (
          <fieldset disabled={proposal?.busy !== undefined} className="contents">
            {section.body}
          </fieldset>
        )
      }))}
      missingTranslations={agentMissingTranslations(form)}
      control={{
        changes: changedFields + (availabilityChanged ? 1 : 0),
        submit,
        discard: () => {
          state.discard();
          setAvailabilityForm(savedAvailability);
        }
      }}
      outcome={outcome}
      saving={saving}
      saveLabel={frame.asset ? t("configSaveChanges") : t("configCreateAgent")}
    />
  );
}

/** What the page is handed while nobody asked the instance for the tools of Connections. */
const NO_CONNECTION_TOOLS: ConnectionToolChoice = { read: { status: "unknown" } };
/** The same for the actions of Apps. */
const NO_APP_TOOLS: AppToolsRead = { status: "unknown" };

/**
 * Where an agent can be chosen, as the fields of its section. The section's heading names it,
 * and the page's save bar saves it with the agent.
 */
function AgentAvailabilityFields({
  form,
  locked,
  disabled,
  workspaces,
  workspacesError,
  refusals,
  onChange
}: {
  form: AgentAvailabilityForm;
  /** The default agent is offered everywhere, and stays so until another agent is the default. */
  locked: boolean;
  disabled: boolean;
  workspaces: readonly AdministeredCollaborationWorkspace[];
  workspacesError?: string;
  refusals: readonly string[];
  onChange(form: AgentAvailabilityForm): void;
}) {
  const { t } = useTranslation();
  const fixed = locked || disabled;
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
  const update = (patch: Partial<AgentAvailabilityForm>) => onChange({ ...form, ...patch });

  return (
    <>
      <RadioGroup
        variant="plain"
        label={t("configAvailability")}
        labelHidden
        hint={locked ? t("configAvailabilityDefaultLocked") : undefined}
        disabled={fixed}
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
            disabled={fixed}
            label={t("configAvailabilityPersonal")}
            description={t("configAvailabilityPersonalHint")}
            onCheckedChange={(personalWorkspaces) => update({ personalWorkspaces })}
          />
          <CheckboxGroup
            label={t("collaborationWorkspaceSharedHeading")}
            options={workspaceIds}
            optionLabel={(id) => workspaceNames.get(id) ?? id}
            selected={form.collaborationWorkspaceIds}
            disabled={fixed}
            emptyHint={workspacesError ?? t("configAvailabilityNoSharedWorkspaces")}
            hint={nothingSelected ? t("configAvailabilityHiddenHint") : undefined}
            onChange={(collaborationWorkspaceIds) => update({ collaborationWorkspaceIds })}
          />
        </>
      ) : null}

      <FieldRefusals messages={refusals} />
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
  setByModelManagers,
  onSelectDefault,
  onSetUserSelectable,
  onSetReasoningEffort
}: {
  form: AgentFormState;
  modelBindings: readonly { id: string; model: string; label?: string }[];
  reasoningEfforts: readonly string[];
  editable: boolean;
  /** The reader may change the agent but not its models: the default model says who may. */
  setByModelManagers: boolean;
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
          {reasoningEffortLabel(effort, t)}
        </option>
      ))}
    </Select>
  );

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t("build.defaultModel")}
          hint={setByModelManagers ? t("build.modelSetByModelManagers") : undefined}
        >
          <Select
            value={form.modelBindingId}
            disabled={!editable}
            onChange={(event) => onSelectDefault(event.target.value)}
          >
            <option value="">{t("configInstanceDefault")}</option>
            {rows.map((row) => (
              <option key={row.bindingId} value={row.bindingId}>
                {row.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("configReasoningEffort")} hint={t("build.reasoningEffortHint")}>
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
