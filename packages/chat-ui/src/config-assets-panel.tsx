import { Bot, BookOpen, History, Plus, Star, Trash2 } from "lucide-react";
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
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Loading configuration…
      </div>
    );
  }

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      {input.error ? (
        <p className="col-span-full text-sm text-destructive">{input.error}</p>
      ) : null}

      <aside className="grid content-start gap-4">
        <AssetList
          label="Agents"
          icon={<Bot size={14} aria-hidden="true" />}
          names={agentNames}
          decorate={(name) =>
            name === defaultAgentName ? (
              <Badge variant="secondary" className="gap-1 px-1.5 text-[10px]">
                <Star size={10} aria-hidden="true" />
                Default
              </Badge>
            ) : null
          }
          selectedName={selection?.mode === "existing" && selection.kind === "agent" ? selection.name : undefined}
          creating={selection?.mode === "new" && selection.kind === "agent"}
          onSelect={(name) => setSelection({ mode: "existing", kind: "agent", name })}
          onCreate={() => setSelection({ mode: "new", kind: "agent" })}
        />
        <AssetList
          label="Skills"
          icon={<BookOpen size={14} aria-hidden="true" />}
          names={skillNames}
          decorate={() => null}
          selectedName={selection?.mode === "existing" && selection.kind === "skill" ? selection.name : undefined}
          creating={selection?.mode === "new" && selection.kind === "skill"}
          onSelect={(name) => setSelection({ mode: "existing", kind: "skill", name })}
          onCreate={() => setSelection({ mode: "new", kind: "skill" })}
        />
        {version !== undefined ? (
          <p className="px-1 text-xs text-muted-foreground">
            Config version {version}. Also editable with the <code>catalyst</code> CLI.
          </p>
        ) : null}
      </aside>

      <div className="min-w-0">
        {selection === undefined ? (
          <p className="pt-1 text-sm text-muted-foreground">
            Select an agent or skill to edit it, or create a new one. Changes apply to new
            conversations immediately — no deployment needed.
          </p>
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
              selection.mode === "existing"
                ? () =>
                    runMutation(() =>
                      input
                        .onDeleteAsset({ kind: "agent", name: selection.name, baseVersion: version })
                        .then(() => setSelection(undefined))
                    )
                : undefined
            }
            onMakeDefault={
              selection.mode === "existing" && selection.name !== defaultAgentName
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
              selection.mode === "existing"
                ? () =>
                    runMutation(() =>
                      input
                        .onDeleteAsset({ kind: "skill", name: selection.name, baseVersion: version })
                        .then(() => setSelection(undefined))
                    )
                : undefined
            }
            revisions={
              selection.mode === "existing" ? (
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
    </div>
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
  onSelect,
  onCreate
}: {
  label: string;
  icon: React.ReactNode;
  names: string[];
  decorate(name: string): React.ReactNode;
  selectedName: string | undefined;
  creating: boolean;
  onSelect(name: string): void;
  onCreate(): void;
}) {
  return (
    <section className="grid gap-1" aria-label={label}>
      <div className="flex items-center justify-between px-1">
        <h2 className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase">
          {icon}
          {label}
        </h2>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          onClick={onCreate}
        >
          <Plus size={13} aria-hidden="true" />
          New
        </button>
      </div>
      <ul className="grid gap-0.5">
        {names.map((name) => (
          <li key={name}>
            <button
              type="button"
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60",
                selectedName === name && "bg-muted font-medium"
              )}
              onClick={() => onSelect(name)}
            >
              <span className="truncate font-mono text-xs">{name}</span>
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

  const update = (patch: Partial<AgentFormState>) => setForm((value) => ({ ...value, ...patch }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError((await onSave(form)).error);
  };

  return (
    <form className="grid max-w-3xl content-start gap-5" onSubmit={submit}>
      <EditorHeader
        title={isNew ? "New agent" : form.name}
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
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
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
        value={form.displayName}
        onChange={(displayName) => update({ displayName })}
      />
      <LocalizedField
        label="Welcome message"
        value={form.welcomeMessage}
        onChange={(welcomeMessage) => update({ welcomeMessage })}
      />
      <LocalizedField
        label="Welcome subtitle"
        value={form.welcomeSubtitle}
        onChange={(welcomeSubtitle) => update({ welcomeSubtitle })}
      />

      <Field label="Instructions" hint="The agent's system prompt.">
        <Textarea
          value={form.instructions}
          required
          rows={10}
          className="font-mono text-xs leading-5"
          onChange={(event) => update({ instructions: event.target.value })}
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Model">
          <Select value={form.model} onChange={(event) => update({ model: event.target.value })}>
            <option value="">Instance default</option>
            {references?.modelProviderIds.length ? (
              <optgroup label="Providers">
                {references.modelProviderIds.map((id) => (
                  <option key={id} value={`provider:${id}`}>
                    {id}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {references?.modelBindingIds.length ? (
              <optgroup label="Bindings">
                {references.modelBindingIds.map((id) => (
                  <option key={id} value={`binding:${id}`}>
                    {id}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
        </Field>
        <Field label="Max steps" hint="Empty uses the instance default.">
          <Input
            type="number"
            min={1}
            value={form.maxSteps}
            onChange={(event) => update({ maxSteps: event.target.value })}
          />
        </Field>
      </div>

      <CheckboxGroup
        label="Tools"
        options={references?.enabledToolNames ?? []}
        selected={form.toolNames}
        emptyHint="No tools are enabled for this instance."
        onChange={(toolNames) => update({ toolNames })}
      />
      <CheckboxGroup
        label="Skills"
        options={skillNames}
        selected={form.skillNames}
        emptyHint="No skills defined yet."
        hint={
          form.skillNames.length > 0 && !form.toolNames.includes("read_skill")
            ? "Skills require the read_skill tool to be selected above."
            : undefined
        }
        onChange={(selected) => update({ skillNames: selected })}
      />

      <InitialPromptsEditor
        prompts={form.initialPrompts}
        onChange={(initialPrompts) => update({ initialPrompts })}
      />

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={mutating}>
          {mutating ? <Spinner className="size-4" /> : null}
          {isNew ? "Create agent" : "Save changes"}
        </Button>
        <span className="text-xs text-muted-foreground">Applies to new conversations immediately.</span>
      </div>

      {revisions}

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

function SkillEditor({
  initialForm,
  isNew,
  mutating,
  onSave,
  onDelete,
  revisions
}: {
  initialForm: SkillFormState;
  isNew: boolean;
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
    <form className="grid max-w-3xl content-start gap-5" onSubmit={submit}>
      <EditorHeader
        title={isNew ? "New skill" : form.name}
        badges={null}
        actions={
          onDelete ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={mutating}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 size={14} aria-hidden="true" />
              Delete
            </Button>
          ) : null
        }
      />

      {isNew ? (
        <Field label="Name" hint="Stable identifier. Cannot be renamed later.">
          <Input
            value={form.name}
            required
            placeholder="generic_workflow_review"
            onChange={(event) => update({ name: event.target.value })}
          />
        </Field>
      ) : null}

      <Field label="Title" hint="Shown to the model in the skill list.">
        <Input value={form.title} required onChange={(event) => update({ title: event.target.value })} />
      </Field>
      <Field label="Description" hint="Tells the model when to read this skill.">
        <Input
          value={form.description}
          required
          onChange={(event) => update({ description: event.target.value })}
        />
      </Field>
      <Field label="Content" hint="Markdown instructions the model reads on demand.">
        <Textarea
          value={form.content}
          required
          rows={16}
          className="font-mono text-xs leading-5"
          onChange={(event) => update({ content: event.target.value })}
        />
      </Field>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={mutating}>
          {mutating ? <Spinner className="size-4" /> : null}
          {isNew ? "Create skill" : "Save changes"}
        </Button>
        <span className="text-xs text-muted-foreground">Applies to new conversations immediately.</span>
      </div>

      {revisions}

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
    <section className="grid gap-2 border-t pt-4">
      <button
        type="button"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={open}
        onClick={toggle}
      >
        <History size={14} aria-hidden="true" />
        Revision history
      </button>
      {open ? (
        error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : revisions === undefined ? (
          <Spinner className="size-4" />
        ) : (
          <ul className="grid gap-1">
            {[...revisions].reverse().map((revision) => (
              <li
                key={revision.revision}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-1.5 text-xs"
              >
                <span className="font-mono">#{revision.revision}</span>
                <Badge variant="outline" className="capitalize">
                  {revision.operation}
                </Badge>
                <span className="text-muted-foreground">
                  {new Date(revision.createdAt).toLocaleString()}
                </span>
                {revision.actor ? (
                  <span className="text-muted-foreground">{revision.actor.displayLabel}</span>
                ) : null}
                {revision.revision !== currentRevision && revision.config !== null ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="ml-auto h-6 px-2 text-xs"
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
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

function EditorHeader({
  title,
  badges,
  actions
}: {
  title: string;
  badges: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="font-mono text-base font-semibold">{title}</h2>
      {badges}
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </div>
  );
}
