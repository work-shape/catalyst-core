import { Send, Star, Undo2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AgentDraft, ConfigAssetReferences } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenuItem,
  Field,
  FormNotice,
  Input,
  Switch,
  Textarea
} from "@work-shape/catalyst-ui";
import { actionLabel } from "../../admin/access/right-words";
import { useTranslation } from "../../shared/i18n";
import { AssetEditorShell, useAssetForm, type AssetSection } from "./asset-editor-shell";
import { FieldRefusals, InitialPromptsEditor, LocalizedField } from "./asset-form-fields";
import {
  agentConfigToForm,
  agentMissingTranslations,
  countChangedFields,
  editedAgentConfig,
  selectAgentModelBinding,
  setAgentModelReasoningEffort,
  setAgentModelUserSelectable,
  type AgentFormState
} from "./asset-form-model";
import type { BuildAssetEditorProps } from "./build-asset-kind";
import { refusalsOf, type BuildWriteOutcome } from "./build-refusals";
import { AppToolsGroup, isAppToolName, type AppToolsRead } from "../apps/app-tools-group";
import { connectionToolTitle, type ConnectionToolChoice } from "./connection-tools";
import { heldToolCount, toolPackages } from "./instance-tools";
import { AgentUnavailableNotices, savedAgentUnavailable } from "./agent-unavailable";
import { ToolPackagesSection } from "./tool-packages-section";
import {
  AvailabilityFields,
  useAvailabilityEdit,
  type AvailabilityChoice
} from "./asset-availability-fields";
import { MissingDependencies, type DependencyAvailability } from "./dependency-availability";
import { AgentCreateReview, type AgentCreateCheck } from "./agent-create-review";
import type { DependencyConsent } from "../../shared/api/asset-writes";
import { AgentKnowledge, type KnowledgeBaseChoice } from "./agent-knowledge";
import { AgentModels, modelBindingLabel } from "./agent-models";
import { AgentSkills, type SkillChoice } from "./agent-skills";
import {
  AgentDraftBadge,
  AgentDraftNotice,
  DraftSectionMark,
  draftFieldsView,
  type DraftTitles
} from "./agent-draft";
import type { AgentDraftSource } from "./agent-draft-source";
import type { DraftDecision } from "./build-data";
import { PlatformInstructions } from "./platform-instructions";

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
  createCheck,
  draft
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
  availability?: AvailabilityChoice;
  /**
   * A new agent's: what it would use that is missing where it starts, read before the create.
   * Absent for an existing agent and for one that starts hidden.
   */
  createCheck?: AgentCreateCheck;
  /**
   * The agent's one draft, for a reader who may change the agent: the form starts from the
   * draft the source read, and saves write it. Absent for a new agent and for a reader.
   */
  draft?: AgentDraftSource;
}) {
  const { locale, t } = useTranslation();
  const state = useAssetForm(initialForm);
  const { form, setForm, outcome } = state;
  const [saving, setSaving] = useState(false);
  const [defaultError, setDefaultError] = useState<string>();
  const [deciding, setDeciding] = useState<DraftDecision>();
  const publishReasonId = useId();
  const { canWrite } = frame;
  // The draft the form was started from or last saved as. The page writes against it, and a
  // newer one somebody else wrote is taken over only where nothing is typed.
  const [held, setHeld] = useState<AgentDraft | null>(draft?.latest ?? null);
  const availabilityEdit = useAvailabilityEdit(availability);
  const availabilityChanged = availabilityEdit.changed;
  // Publish also makes what the draft uses available where the agent is, where the reader
  // chose so in the dialog. The choice starts unticked each time the dialog opens, and the
  // dialog reads the draft again first: only the instance tells what the draft uses that is
  // missing where the agent is.
  const [publishDependencies, setPublishDependencies] = useState(false);
  const [preflight, setPreflight] = useState(false);
  // A new agent's create that waits for the reader's answer to what it would leave missing.
  const [creating, setCreating] = useState<{
    config: Record<string, unknown>;
    dependencies: DependencyAvailability;
  }>();
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
  const titles: DraftTitles = {
    skill: (name) => skillsByName.get(name)?.title || name,
    tool: (name) =>
      references?.tools?.find((tool) => tool.name === name)?.title?.[locale].trim() ||
      connectionToolTitle(connectionTools.read, name) ||
      name,
    knowledgeBase: (name) =>
      knowledgeChoice?.options.find((option) => option.name === name)?.title || name,
    model: (id) => {
      const binding = modelBindings.find((candidate) => candidate.id === id);
      return binding ? modelBindingLabel(binding, modelBindings) : id;
    }
  };
  // The live agent the page loaded. The draft as saved is compared with it, with the published
  // value under each field the draft changes.
  const live = useMemo(
    () => (frame.asset === undefined ? undefined : agentConfigToForm(frame.asset.config)),
    [frame.asset]
  );
  const proposed = draftFieldsView(
    live ?? state.baseline,
    held === null ? undefined : state.baseline,
    titles
  );
  // The draft names the agent as people who use it know it now, not as the form edits it.
  const liveTitle =
    (live ?? state.baseline).displayName[locale].trim() ||
    (live ?? state.baseline).displayName[locale === "de" ? "en" : "de"].trim() ||
    state.baseline.name;
  // The name the page head shows: as the form holds it.
  const title =
    form.displayName[locale].trim() ||
    form.displayName[locale === "de" ? "en" : "de"].trim() ||
    form.name;
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
  const dirty = changedFields > 0 || availabilityChanged;
  const latest = draft?.latest;
  const latestRevision = latest === undefined ? undefined : (latest?.revision ?? null);
  const differs = latestRevision !== undefined && latestRevision !== (held?.revision ?? null);
  const busy = draft?.busy;
  // Somebody else wrote the draft, or published or discarded it, while the reader types: the
  // page keeps what was typed and says who, and saves nothing over it.
  const behind = draft !== undefined && differs && dirty ? { latest: latest ?? null } : undefined;
  const { amend } = state;
  const { reload } = frame;
  // The live agent is read again once: the page starts again from it.
  const reloading = useRef(false);
  useEffect(() => {
    if (latest === undefined || saving || busy !== undefined) return;
    if (!differs) {
      // The same revision read again names its author as the instance does.
      if (latest !== null && latest !== held) setHeld(latest);
      return;
    }
    if (dirty) return;
    if (latest === null) {
      // Published or discarded elsewhere: the live agent is read again.
      if (!reloading.current) {
        reloading.current = true;
        reload?.().catch(() => undefined);
      }
      return;
    }
    amend(() => agentConfigToForm(latest.config));
    setHeld(latest);
  }, [amend, busy, differs, dirty, held, latest, reload, saving]);
  const { onDraftRead } = frame;
  useEffect(() => {
    onDraftRead?.(held?.revision ?? null);
  }, [held, onDraftRead]);
  const answer = draft?.answerFor(held?.revision);
  const stale = held !== null && (held.stale || answer?.kind === "stale");
  // One save bar for the agent and where it can be chosen: the agent first, then its
  // availability, each only when it changed. A new agent that would miss what it uses where it
  // starts is created from the dialog that offers to make it available, as a publish is.
  const submit = async (): Promise<BuildWriteOutcome> => {
    setSaving(true);
    const config = editedAgentConfig(
      form,
      held?.config ?? frame.asset?.config,
      references?.enabledToolNames
    );
    if (frame.asset === undefined && createCheck !== undefined) {
      // Nothing is created without the check: a check that fails keeps the form as it is.
      const checked = await createCheck.read(config).then(
        (dependencies) => ({ dependencies }),
        () => undefined
      );
      if (checked === undefined) {
        const failed: BuildWriteOutcome = {
          ok: false,
          conflict: false,
          refusals: [{ message: t("build.dependencyCheckFailed") }]
        };
        setSaving(false);
        state.setOutcome(failed);
        return failed;
      }
      const { dependencies } = checked;
      if (dependencies !== null && dependencies.missing.length > 0) {
        setSaving(false);
        setCreating({ config, dependencies });
        // Nothing is written yet, and nothing was refused.
        return { ok: true };
      }
    }
    return write(config);
  };
  const write = async (
    config: Record<string, unknown>,
    dependencyConsent?: DependencyConsent
  ): Promise<BuildWriteOutcome> => {
    setSaving(true);
    const asset = frame.asset;
    const saved: BuildWriteOutcome & { draftRevision?: number } =
      asset === undefined || changedFields > 0
        ? await frame.save(
            config,
            asset !== undefined && draft !== undefined
              ? { expectedDraftRevision: held?.revision ?? null }
              : asset === undefined && dependencyConsent !== undefined
                ? { dependencyConsent }
                : undefined
          )
        : { ok: true };
    if (saved.ok) {
      state.markSaved();
      if (asset !== undefined && draft !== undefined && saved.draftRevision !== undefined) {
        setHeld(
          draft.saved({ revision: saved.draftRevision, config, liveRevision: asset.revision })
        );
      }
    } else if (saved.conflict && saved.draft) {
      // The page reads the draft again and says who wrote it.
      await draft?.reread().catch(() => undefined);
    }
    const refused = saved.ok && availabilityChanged ? await availabilityEdit.save() : undefined;
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
          <AgentSkills
            choice={skillChoice}
            value={form.skillNames}
            editable={canEdit("skillNames")}
            onChange={(skillNames) => update({ skillNames })}
          />
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
              <AvailabilityFields
                edit={availabilityEdit}
                locked={isDefault && availability.saved?.mode === "all"}
                disabled={saving}
                workspaces={availability.workspaces}
                workspacesError={availability.workspacesError}
                hiddenHint={t("configAvailabilityHiddenHint")}
                dependencies={availability.dependencies}
                refusals={refusalsOf(outcome, "availability")}
              />
            )
          }
        ]
      : [])
  ];

  const page = (
    <AssetEditorShell
      frame={{
        ...frame,
        saveBlocked: frame.saveBlocked === true || behind !== undefined,
        canWrite:
          canWrite &&
          (editableAgentFields.length > 0 || canManageAgentModels || availability !== undefined)
      }}
      title={title}
      description={
        form.description[locale].trim() || form.description[locale === "de" ? "en" : "de"].trim()
      }
      badges={
        <>
          {held === null ? null : <AgentDraftBadge draft={held} />}
          {isDefault ? <Badge>{t("configDefaultAgent")}</Badge> : null}
        </>
      }
      primaryAction={
        draft !== undefined && held !== null && !stale ? (
          <Button
            data-agent-publish=""
            disabled={!frame.canPublish || dirty || busy !== undefined || behind !== undefined}
            aria-describedby={frame.canPublish ? undefined : publishReasonId}
            title={
              frame.canPublish
                ? dirty
                  ? t("build.publishSaveFirst")
                  : undefined
                : t("agentDraft.publishNeedsRight", { right: actionLabel("agent.publish", t) })
            }
            onClick={() => {
              setPublishDependencies(false);
              setPreflight(true);
              setDeciding("publish");
              draft
                .reread()
                .catch(() => undefined)
                .finally(() => setPreflight(false));
            }}
          >
            <Send aria-hidden="true" />
            {t("build.publish")}
          </Button>
        ) : undefined
      }
      menu={
        draft !== undefined && held !== null && !frame.saveBlocked ? (
          <DropdownMenuItem
            icon={<Undo2 aria-hidden="true" />}
            disabled={busy !== undefined}
            onSelect={() => setDeciding("discard")}
          >
            <span data-agent-discard="">{t("agentDraft.discard")}</span>
          </DropdownMenuItem>
        ) : undefined
      }
      notices={
        <>
          {draft !== undefined ? (
            <AgentDraftNotice
              draft={held}
              behind={behind}
              name={liveTitle}
              publishRight={frame.canPublish ? undefined : actionLabel("agent.publish", t)}
              publishReasonId={publishReasonId}
              answer={answer}
              onLoad={() => {
                reload?.().catch(() => undefined);
              }}
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
        ...(proposed.sections.has(section.id) ? { state: <DraftSectionMark /> } : {}),
        // While Publish or Discard is on its way nothing is typed: either reads the page again.
        body: (
          <fieldset disabled={busy !== undefined} className="contents">
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
          availabilityEdit.discard();
        }
      }}
      outcome={outcome}
      saving={saving}
      // The agent's own fields go to its draft; where it can be chosen applies at once.
      saveLabel={
        frame.asset === undefined
          ? t("configCreateAgent")
          : draft !== undefined && changedFields > 0
            ? t("agentDraft.saveDraft")
            : t("configSaveChanges")
      }
      {...(frame.asset !== undefined && draft !== undefined && changedFields > 0
        ? { saveHint: t("agentDraft.saveHint") }
        : {})}
    />
  );
  // What the dialog lists, as the publish preflight read it for the draft it publishes.
  const reviewed =
    held === null
      ? undefined
      : (latest?.revision === held.revision ? latest : held).dependencyAvailability;
  const decision =
    held === null ? null : (
      <>
        <ConfirmDialog
          open={deciding === "publish"}
          tone="primary"
          title={t("build.publishTitle", { name: liveTitle })}
          confirmLabel={t("build.publish")}
          loading={busy === "publish"}
          confirmDisabled={preflight}
          onConfirm={() => {
            draft
              ?.decide("publish", held.revision, {
                makeDependenciesAvailable: publishDependencies,
                // The workspaces the list in this dialog was read for.
                expectedAvailability: reviewed?.availability ?? null
              })
              .finally(() => setDeciding(undefined))
              .catch(() => undefined);
          }}
          onClose={() => setDeciding(undefined)}
        >
          <div className="grid gap-3">
            <p>
              {t("agentDraft.publishDescription", { revision: held.revision, name: liveTitle })}
            </p>
            <MissingDependencies
              dependencies={preflight ? undefined : reviewed}
              workspaceName={(id) =>
                availability?.workspaces.find((workspace) => workspace.id === id)?.name
              }
              makeAvailable={publishDependencies}
              disabled={busy === "publish"}
              onMakeAvailableChange={setPublishDependencies}
            />
          </div>
        </ConfirmDialog>
        <ConfirmDialog
          open={deciding === "discard"}
          title={t("agentDraft.discardTitle", { name: liveTitle })}
          confirmLabel={t("agentDraft.discard")}
          loading={busy === "discard"}
          onConfirm={() => {
            draft
              ?.decide("discard", held.revision)
              .finally(() => setDeciding(undefined))
              .catch(() => undefined);
          }}
          onClose={() => setDeciding(undefined)}
        >
          {t("agentDraft.discardDescription", { revision: held.revision })}
        </ConfirmDialog>
      </>
    );
  return (
    <>
      {page}
      {decision}
      {creating && createCheck ? (
        <AgentCreateReview
          name={title}
          check={createCheck}
          dependencies={creating.dependencies}
          onCreate={(dependencyConsent) => write(creating.config, dependencyConsent)}
          onClose={() => setCreating(undefined)}
        />
      ) : null}
    </>
  );
}

/** What the page is handed while nobody asked the instance for the tools of Connections. */
const NO_CONNECTION_TOOLS: ConnectionToolChoice = { read: { status: "unknown" } };
/** The same for the actions of Apps. */
const NO_APP_TOOLS: AppToolsRead = { status: "unknown" };
