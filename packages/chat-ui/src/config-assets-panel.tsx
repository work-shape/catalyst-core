import { Bot, BookOpen, ChevronDown, History, Plus, Star, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  ConfigAssetKind,
  ConfigAssetRevision,
  ConfigAssetsOverview
} from "@vivd-catalyst/api-client";
import {
  agentConfigToForm,
  agentFormToConfig,
  configAssetMutationErrorMessage,
  emptyAgentForm,
  emptySkillForm,
  skillConfigToForm,
  skillFormToConfig,
  type AgentFormState,
  type SkillFormState
} from "./config-assets-model";
import {
  CheckboxGroup,
  DeleteDialog,
  Field,
  InitialPromptsEditor,
  LocalizedField
} from "./config-asset-form-fields";
import { ControlPlanePage } from "./control-plane/control-plane-page";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { Dialog } from "./ui/dialog";
import { Input, Textarea } from "./ui/input";
import { Select } from "./ui/select";
import { Spinner } from "./ui/spinner";
import { apiErrorMessage, apiErrorStatus } from "./workspace-utils";

export interface ConfigAssetBundleEntry {
  name: string;
  config: Record<string, unknown>;
}

export interface ConfigAssetsPanelInput {
  editableAgentFields: string[];
  allowAgentCreation: boolean;
  allowAgentDeletion: boolean;
  allowDefaultAgentChange: boolean;
  allowSkillEditing: boolean;
  overview: ConfigAssetsOverview | undefined;
  agents: ConfigAssetBundleEntry[];
  skills: ConfigAssetBundleEntry[];
  loading: boolean;
  error?: string;
  mutating: boolean;
  onSaveAsset(input: {
    kind: ConfigAssetKind;
    name: string;
    config: Record<string, unknown>;
    baseVersion?: number;
  }): Promise<unknown>;
  onDeleteAsset(input: { kind: ConfigAssetKind; name: string; baseVersion?: number }): Promise<unknown>;
  onSetDefaultAgent(input: { agentName?: string; baseVersion?: number }): Promise<unknown>;
  onRevertAsset(input: {
    kind: ConfigAssetKind;
    name: string;
    revision: number;
    baseVersion?: number;
  }): Promise<unknown>;
  onLoadRevisions(kind: ConfigAssetKind, name: string): Promise<ConfigAssetRevision[]>;
  onReload(): Promise<unknown>;
}

interface MutationOutcome {
  ok: boolean;
  error?: string;
}

type PanelSelection =
  | { mode: "existing"; kind: ConfigAssetKind; name: string }
  | { mode: "new"; kind: ConfigAssetKind };

export function ConfigAssetsPanel(input: ConfigAssetsPanelInput) {
  const [selection, setSelection] = useState<PanelSelection | undefined>(undefined);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [resetToken, setResetToken] = useState(0);

  const version = input.overview?.version;
  const defaultAgentName = input.overview?.defaultAgentName;
  const agentNames = input.agents.map((agent) => agent.name);
  const skillNames = input.skills.map((skill) => skill.name);
  const pageDescription = (
    <>
      {agentNames.length.toLocaleString()} {agentNames.length === 1 ? "agent" : "agents"}
      {" · "}
      {skillNames.length.toLocaleString()} {skillNames.length === 1 ? "skill" : "skills"}
      {version !== undefined ? ` · Version ${version}` : ""}
    </>
  );

  const selectedEntry =
    selection?.mode === "existing"
      ? (selection.kind === "agent" ? input.agents : input.skills).find(
          (entry) => entry.name === selection.name
        )
      : undefined;

  const runMutation = async (action: () => Promise<unknown>): Promise<MutationOutcome> => {
    try {
      await action();
      return { ok: true };
    } catch (error) {
      if (apiErrorStatus(error) === 409) {
        setConflictOpen(true);
        return { ok: false };
      }
      return { ok: false, error: configAssetMutationErrorMessage(error) };
    }
  };

  const reloadAfterConflict = async () => {
    await input.onReload();
    setConflictOpen(false);
    setResetToken((token) => token + 1);
  };

  if (input.loading) {
    return (
      <ControlPlanePage title="Configuration" description={pageDescription}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading configuration…
        </div>
      </ControlPlanePage>
    );
  }

  return (
    <ControlPlanePage
      title="Configuration"
      description={pageDescription}
      actions={
        <>
          {input.allowSkillEditing ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setSelection({ mode: "new", kind: "skill" })}
            >
              <Plus size={16} aria-hidden="true" />
              New skill
            </Button>
          ) : null}
          {input.allowAgentCreation ? (
            <Button type="button" onClick={() => setSelection({ mode: "new", kind: "agent" })}>
              <Plus size={16} aria-hidden="true" />
              New agent
            </Button>
          ) : null}
        </>
      }
    >
      {input.error ? <p className="text-sm text-destructive">{input.error}</p> : null}

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="grid min-w-0 content-start gap-4 overflow-hidden rounded-lg border bg-card p-3 shadow-xs sm:grid-cols-2 lg:sticky lg:top-0 lg:grid-cols-1">
          <AssetList
            label="Agents"
            icon={<Bot size={14} aria-hidden="true" />}
            names={agentNames}
            decorate={(name) =>
              name === defaultAgentName ? (
                <span
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-primary"
                  title="Default agent"
                  aria-label="Default agent"
                >
                  <Star size={13} aria-hidden="true" />
                </span>
              ) : null
            }
            selectedName={
              selection?.mode === "existing" && selection.kind === "agent"
                ? selection.name
                : undefined
            }
            creating={selection?.mode === "new" && selection.kind === "agent"}
            onSelect={(name) => setSelection({ mode: "existing", kind: "agent", name })}
          />
          <AssetList
            label="Skills"
            icon={<BookOpen size={14} aria-hidden="true" />}
            names={skillNames}
            decorate={() => null}
            selectedName={
              selection?.mode === "existing" && selection.kind === "skill"
                ? selection.name
                : undefined
            }
            creating={selection?.mode === "new" && selection.kind === "skill"}
            onSelect={(name) => setSelection({ mode: "existing", kind: "skill", name })}
          />
          {version !== undefined ? (
            <p className="border-t px-1 pt-3 text-xs leading-5 text-muted-foreground sm:col-span-2 lg:col-span-1">
              Also editable with the <code>catalyst</code> CLI.
            </p>
          ) : null}
        </aside>

        <div className="min-w-0 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xs">
        {selection === undefined ? (
          <div className="grid min-h-[28rem] place-items-center p-6 text-center">
            <div className="grid max-w-sm justify-items-center gap-3">
              <span className="inline-flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Bot size={18} aria-hidden="true" />
              </span>
              <div className="grid gap-1">
                <h2 className="text-base font-semibold">Select an agent or skill</h2>
                <p className="text-sm leading-6 text-muted-foreground">
                  Choose an item from the navigation to edit it. Changes apply to new conversations
                  immediately, without a deployment.
                </p>
              </div>
            </div>
          </div>
        ) : selection.kind === "agent" ? (
          <AgentEditor
            key={`${resetToken}:${selectionKey(selection)}`}
            initialForm={
              selection.mode === "existing" && selectedEntry
                ? agentConfigToForm(selectedEntry.config)
                : emptyAgentForm()
            }
            isNew={selection.mode === "new"}
            isDefault={selection.mode === "existing" && selection.name === defaultAgentName}
            references={input.overview?.references}
            editableAgentFields={input.editableAgentFields}
            skillNames={skillNames}
            mutating={input.mutating}
            onSave={(form) =>
              runMutation(() =>
                input
                  .onSaveAsset({
                    kind: "agent",
                    name: form.name.trim(),
                    config: agentFormToConfig(form),
                    baseVersion: version
                  })
                  .then(() => {
                    if (selection.mode === "new") {
                      setSelection({ mode: "existing", kind: "agent", name: form.name.trim() });
                    } else {
                      setResetToken((token) => token + 1);
                    }
                  })
              )
            }
            onDelete={
              selection.mode === "existing" && input.allowAgentDeletion
                ? () =>
                    runMutation(() =>
                      input
                        .onDeleteAsset({ kind: "agent", name: selection.name, baseVersion: version })
                        .then(() => setSelection(undefined))
                    )
                : undefined
            }
            onMakeDefault={
              selection.mode === "existing" &&
              selection.name !== defaultAgentName &&
              input.allowDefaultAgentChange
                ? () =>
                    runMutation(() =>
                      input.onSetDefaultAgent({ agentName: selection.name, baseVersion: version })
                    )
                : undefined
            }
            revisions={
              selection.mode === "existing" ? (
                <RevisionHistory
                  kind="agent"
                  name={selection.name}
                  mutating={input.mutating}
                  onLoadRevisions={input.onLoadRevisions}
                  onRevert={(revision) =>
                    runMutation(() =>
                      input
                        .onRevertAsset({
                          kind: "agent",
                          name: selection.name,
                          revision,
                          baseVersion: version
                        })
                        .then(() => setResetToken((token) => token + 1))
                    )
                  }
                />
              ) : null
            }
          />
        ) : (
          <SkillEditor
            key={`${resetToken}:${selectionKey(selection)}`}
            initialForm={
              selection.mode === "existing" && selectedEntry
                ? skillConfigToForm(selectedEntry.config)
                : emptySkillForm()
            }
            isNew={selection.mode === "new"}
            editable={input.allowSkillEditing}
            mutating={input.mutating}
            onSave={(form) =>
              runMutation(() =>
                input
                  .onSaveAsset({
                    kind: "skill",
                    name: form.name.trim(),
                    config: skillFormToConfig(form),
                    baseVersion: version
                  })
                  .then(() => {
                    if (selection.mode === "new") {
                      setSelection({ mode: "existing", kind: "skill", name: form.name.trim() });
                    } else {
                      setResetToken((token) => token + 1);
                    }
                  })
              )
            }
            onDelete={
              selection.mode === "existing" && input.allowSkillEditing
                ? () =>
                    runMutation(() =>
                      input
                        .onDeleteAsset({ kind: "skill", name: selection.name, baseVersion: version })
                        .then(() => setSelection(undefined))
                    )
                : undefined
            }
            revisions={
              selection.mode === "existing" && input.allowSkillEditing ? (
                <RevisionHistory
                  kind="skill"
                  name={selection.name}
                  mutating={input.mutating}
                  onLoadRevisions={input.onLoadRevisions}
                  onRevert={(revision) =>
                    runMutation(() =>
                      input
                        .onRevertAsset({
                          kind: "skill",
                          name: selection.name,
                          revision,
                          baseVersion: version
                        })
                        .then(() => setResetToken((token) => token + 1))
                    )
                  }
                />
              ) : null
            }
          />
        )}
        </div>
      </div>

      <Dialog
        open={conflictOpen}
        title="Configuration changed on the server"
        onClose={() => setConflictOpen(false)}
      >
        <div className="grid gap-4 p-5">
          <p className="text-sm text-muted-foreground">
            Someone else — or a CLI push — modified the configuration since you loaded it. Reload to
            continue from the latest version. Unsaved edits in this editor will be lost.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConflictOpen(false)}>
              Keep editing
            </Button>
            <Button onClick={() => void reloadAfterConflict()}>Reload latest</Button>
          </div>
        </div>
      </Dialog>
    </ControlPlanePage>
  );
}

function selectionKey(selection: PanelSelection): string {
  return selection.mode === "new" ? `new:${selection.kind}` : `${selection.kind}:${selection.name}`;
}

function AssetList({
  label,
  icon,
  names,
  decorate,
  selectedName,
  creating,
  onSelect
}: {
  label: string;
  icon: React.ReactNode;
  names: string[];
  decorate(name: string): React.ReactNode;
  selectedName: string | undefined;
  creating: boolean;
  onSelect(name: string): void;
}) {
  return (
    <section className="grid min-w-0 gap-1.5 overflow-hidden" aria-label={label}>
      <div className="flex min-h-7 items-center justify-between gap-2 px-1">
        <h2 className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {icon}
          {label}
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">{names.length}</span>
      </div>
      <ul className="grid min-w-0 gap-1 overflow-hidden">
        {names.map((name) => (
          <li key={name} className="min-w-0 overflow-hidden">
            <button
              type="button"
              className={cn(
                "flex h-9 w-full min-w-0 items-center justify-between gap-2 overflow-hidden rounded-md px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
                selectedName === name && "bg-primary/10 font-medium text-foreground hover:bg-primary/15"
              )}
              title={name}
              onClick={() => onSelect(name)}
            >
              <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs">
                {name}
              </span>
              {decorate(name)}
            </button>
          </li>
        ))}
        {creating ? (
          <li className="rounded-md bg-muted px-2 py-1.5 text-xs font-medium text-muted-foreground">
            New {label.toLowerCase().replace(/s$/u, "")}…
          </li>
        ) : null}
        {names.length === 0 && !creating ? (
          <li className="px-2 py-1 text-xs text-muted-foreground">None yet.</li>
        ) : null}
      </ul>
    </section>
  );
}

function AgentEditor({
  initialForm,
  isNew,
  isDefault,
  references,
  editableAgentFields,
  skillNames,
  mutating,
  onSave,
  onDelete,
  onMakeDefault,
  revisions
}: {
  initialForm: AgentFormState;
  isNew: boolean;
  isDefault: boolean;
  references: ConfigAssetsOverview["references"] | undefined;
  editableAgentFields: ConfigAssetsPanelInput["editableAgentFields"];
  skillNames: string[];
  mutating: boolean;
  onSave(form: AgentFormState): Promise<MutationOutcome>;
  onDelete?: () => Promise<MutationOutcome>;
  onMakeDefault?: () => Promise<MutationOutcome>;
  revisions: React.ReactNode;
}) {
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState<string | undefined>(undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const canEdit = (field: string) => editableAgentFields.includes(field);
  const canEditModel = canEdit("modelBindingId");
  const canEditReasoningEffort = canEdit("reasoningEffort");
  const canEditMaxSteps = canEdit("maxSteps");
  const modelBindings =
    references?.modelBindings ??
    references?.modelBindingIds.map((id) => ({ id, model: id })) ??
    [];

  const update = (patch: Partial<AgentFormState>) => setForm((value) => ({ ...value, ...patch }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError((await onSave(form)).error);
  };

  return (
    <form className="grid min-w-0 content-start" onSubmit={submit}>
      <EditorHeader
        eyebrow="Agent"
        title={
          isNew
            ? "New agent"
            : form.displayName.en.trim() || form.displayName.de.trim() || form.name
        }
        identifier={isNew ? undefined : form.name}
        badges={isDefault ? <Badge variant="secondary">Default agent</Badge> : null}
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
                Make default
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
                Delete
              </Button>
            ) : null}
          </>
        }
      />

      <EditorSection
        title="Identity and welcome"
        description="Names and messages shown to people when they start a conversation."
      >
        {isNew ? (
          <Field label="Name" hint="Stable identifier, letters/digits/underscores. Cannot be renamed later.">
            <Input
              value={form.name}
              required
              placeholder="workflow_assistant"
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
        ) : null}
        <LocalizedField
          label="Display name"
          required
          disabled={!canEdit("displayName")}
          value={form.displayName}
          onChange={(displayName) => update({ displayName })}
        />
        <LocalizedField
          label="Welcome message"
          disabled={!canEdit("welcomeMessage")}
          value={form.welcomeMessage}
          onChange={(welcomeMessage) => update({ welcomeMessage })}
        />
        <LocalizedField
          label="Welcome subtitle"
          disabled={!canEdit("welcomeSubtitle")}
          value={form.welcomeSubtitle}
          onChange={(welcomeSubtitle) => update({ welcomeSubtitle })}
        />
      </EditorSection>

      <EditorSection
        title="Behavior"
        description={
          canEditModel || canEditReasoningEffort || canEditMaxSteps
            ? "Core instructions and permitted runtime controls for this agent."
            : "Core instructions for this agent."
        }
      >
        <Field label="Instructions" hint="The agent's system prompt.">
          <EditorTextarea
            label="System prompt"
            value={form.instructions}
            required
            disabled={!canEdit("instructions")}
            className="min-h-72"
            onChange={(event) => update({ instructions: event.target.value })}
          />
        </Field>
        {canEditModel || canEditReasoningEffort || canEditMaxSteps ? (
          <div
            className={cn(
              "grid gap-5",
              [canEditModel, canEditReasoningEffort, canEditMaxSteps].filter(Boolean).length > 1 &&
                "sm:grid-cols-2"
            )}
          >
            {canEditModel ? (
              <Field
                label="Model"
                hint="Selects one of the model bindings approved in instance config."
              >
                <Select
                  value={form.modelBindingId}
                  onChange={(event) =>
                    update({ modelBindingId: event.target.value, modelProviderId: "" })
                  }
                >
                  <option value="">Instance default</option>
                  {modelBindings.length ? (
                    <optgroup label="Configured bindings">
                      {modelBindings.map((binding) => (
                        <option key={binding.id} value={binding.id}>
                          {modelBindingLabel(binding, modelBindings)}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </Select>
              </Field>
            ) : null}
            {canEditReasoningEffort ? (
              <Field label="Reasoning effort" hint="Overrides the selected binding's default effort.">
                <Select
                  value={form.reasoningEffort}
                  onChange={(event) => update({ reasoningEffort: event.target.value })}
                >
                  <option value="">Model default</option>
                  {(references?.reasoningEfforts ?? []).map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {canEditMaxSteps ? (
              <Field
                label="Max steps"
                hint="Maximum model and tool turns for one response. Empty uses release config."
              >
                <Input
                  type="number"
                  min={1}
                  value={form.maxSteps}
                  onChange={(event) => update({ maxSteps: event.target.value })}
                />
              </Field>
            ) : null}
          </div>
        ) : null}
      </EditorSection>

      <EditorSection
        title="Capabilities"
        description="Only tools enabled for this deployment can be assigned here."
      >
        <CheckboxGroup
          label="Tools"
          options={references?.enabledToolNames ?? []}
          selected={form.toolNames}
          disabled={!canEdit("toolNames")}
          emptyHint="No tools are enabled for this instance."
          onChange={(toolNames) => update({ toolNames })}
        />
        <CheckboxGroup
          label="Skills"
          options={skillNames}
          selected={form.skillNames}
          disabled={!canEdit("skillNames")}
          emptyHint="No skills defined yet."
          hint={
            form.skillNames.length > 0 && !form.toolNames.includes("read_skill")
              ? "Skills require the read_skill tool to be selected above."
              : undefined
          }
          onChange={(selected) => update({ skillNames: selected })}
        />
      </EditorSection>

      <EditorSection
        title="Starter prompts"
        description="Suggestion cards shown before the first message is sent."
      >
        <InitialPromptsEditor
          prompts={form.initialPrompts}
          disabled={!canEdit("initialPrompts")}
          onChange={(initialPrompts) => update({ initialPrompts })}
        />
      </EditorSection>

      {error ? <p className="px-5 py-3 text-sm text-destructive">{error}</p> : null}

      {revisions}

      <SaveBar
        label={isNew ? "Create agent" : "Save changes"}
        mutating={mutating}
        disabled={editableAgentFields.length === 0}
      />

      {onDelete ? (
        <DeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          subject={`agent '${form.name}'`}
          onConfirm={async () => {
            setDeleteOpen(false);
            setError((await onDelete()).error);
          }}
        />
      ) : null}
    </form>
  );
}

function modelBindingLabel(
  binding: { id: string; model: string },
  bindings: Array<{ id: string; model: string }>
): string {
  const duplicateModel = bindings.some(
    (candidate) => candidate.id !== binding.id && candidate.model === binding.model
  );
  return duplicateModel ? `${binding.model} (${binding.id})` : binding.model;
}

function SkillEditor({
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
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState<string | undefined>(undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const update = (patch: Partial<SkillFormState>) => setForm((value) => ({ ...value, ...patch }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError((await onSave(form)).error);
  };

  return (
    <form className="grid min-w-0 content-start" onSubmit={submit}>
      <EditorHeader
        eyebrow="Skill"
        title={isNew ? "New skill" : form.title.trim() || form.name}
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
              Delete
            </Button>
          ) : null
        }
      />

      <EditorSection
        title="Skill details"
        description="Metadata used to decide when this skill is relevant."
      >
        {isNew ? (
          <Field label="Name" hint="Stable identifier. Cannot be renamed later.">
            <Input
              value={form.name}
              disabled={!editable}
              required
              placeholder="generic_workflow_review"
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
        ) : null}
        <Field label="Title" hint="Shown to the model in the skill list.">
          <Input
            value={form.title}
            required
            disabled={!editable}
            onChange={(event) => update({ title: event.target.value })}
          />
        </Field>
        <Field label="Description" hint="Tells the model when to read this skill.">
          <Input
            value={form.description}
            required
            disabled={!editable}
            onChange={(event) => update({ description: event.target.value })}
          />
        </Field>
      </EditorSection>

      <EditorSection
        title="Instructions"
        description="Markdown content loaded when the agent reads this skill."
      >
        <Field label="Content" hint="Keep instructions focused on this skill's workflow.">
          <EditorTextarea
            label="Markdown"
            value={form.content}
            required
            disabled={!editable}
            className="min-h-96"
            onChange={(event) => update({ content: event.target.value })}
          />
        </Field>
      </EditorSection>

      {error ? <p className="px-5 py-3 text-sm text-destructive">{error}</p> : null}

      {revisions}

      <SaveBar
        label={isNew ? "Create skill" : "Save changes"}
        mutating={mutating}
        disabled={!editable}
      />

      {onDelete ? (
        <DeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          subject={`skill '${form.name}'`}
          onConfirm={async () => {
            setDeleteOpen(false);
            setError((await onDelete()).error);
          }}
        />
      ) : null}
    </form>
  );
}

function RevisionHistory({
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
  onRevert(revision: number): Promise<MutationOutcome>;
}) {
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
        setError(apiErrorMessage(loadError, "Could not load the revision history."));
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
        Revision history
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
            <p className="text-sm text-muted-foreground">No revisions yet.</p>
          ) : (
            <ul className="divide-y overflow-hidden rounded-lg border bg-background">
              {[...revisions].reverse().map((revision) => (
                <li
                  key={revision.revision}
                  className="grid min-w-0 items-center gap-2 px-3 py-2.5 text-xs sm:grid-cols-[auto_auto_minmax(0,1fr)_auto]"
                >
                  <span className="font-mono font-medium">#{revision.revision}</span>
                  <Badge variant="outline" className="w-fit capitalize">
                    {revision.operation}
                  </Badge>
                  <span className="min-w-0 text-muted-foreground">
                    {new Date(revision.createdAt).toLocaleString()}
                    {revision.actor ? ` · ${revision.actor.displayLabel}` : ""}
                  </span>
                  {revision.revision !== currentRevision && revision.config !== null ? (
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
                      Restore
                    </Button>
                  ) : (
                    <span className="text-right text-muted-foreground">Current</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
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
  children
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid min-w-0 gap-4 border-b px-5 py-6 xl:grid-cols-[11rem_minmax(0,1fr)] xl:gap-6">
      <div className="grid content-start gap-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="grid min-w-0 gap-5">{children}</div>
    </section>
  );
}

function EditorTextarea({
  label,
  className,
  ...props
}: React.ComponentProps<typeof Textarea> & { label: string }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/15 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
      <div className="flex h-9 items-center border-b bg-muted/20 px-3 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      <Textarea
        {...props}
        className={cn(
          "resize-y rounded-none border-0 bg-transparent p-4 font-mono text-[13px] leading-6 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:[color-scheme:dark]",
          className
        )}
      />
    </div>
  );
}

function SaveBar({
  label,
  mutating,
  disabled = false
}: {
  label: string;
  mutating: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 bg-muted/10 px-5 py-4">
      <Button type="submit" className="w-full sm:w-auto" disabled={mutating || disabled}>
        {mutating ? <Spinner className="size-4" /> : null}
        {label}
      </Button>
      <span className="text-xs text-muted-foreground">
        Applies to new conversations immediately.
      </span>
    </div>
  );
}
