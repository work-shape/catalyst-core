import { ChevronDown, History, Star, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  ConfigAssetKind,
  ConfigAssetRevision,
  ConfigAssetsOverview
} from "@vivd-catalyst/api-client";
import {
  CheckboxGroup,
  DeleteDialog,
  Field,
  InitialPromptsEditor,
  LocalizedField
} from "./config-asset-form-fields";
import type { AgentFormState, SkillFormState } from "./config-assets-model";
import { useTranslation } from "../i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Input, Textarea } from "../ui/input";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
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
  editableAgentFields: string[];
  skillNames: string[];
  mutating: boolean;
  onSave(form: AgentFormState): Promise<MutationOutcome>;
  onDelete?: () => Promise<MutationOutcome>;
  onMakeDefault?: () => Promise<MutationOutcome>;
  revisions: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState<string | undefined>(undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const canEdit = (field: string) => editableAgentFields.includes(field);
  const canEditModel = canEdit("modelBindingId");
  const canEditReasoningEffort = canEdit("reasoningEffort");
  const canEditMaxSteps = canEdit("maxSteps");
  const modelBindings =
    references?.modelBindings ?? references?.modelBindingIds.map((id) => ({ id, model: id })) ?? [];

  const update = (patch: Partial<AgentFormState>) => setForm((value) => ({ ...value, ...patch }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError((await onSave(form)).error);
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
              placeholder="workflow_assistant"
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
          canEditModel || canEditReasoningEffort || canEditMaxSteps
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
        {canEditModel || canEditReasoningEffort || canEditMaxSteps ? (
          <div
            className={cn(
              "grid gap-5",
              [canEditModel, canEditReasoningEffort, canEditMaxSteps].filter(Boolean).length > 1 &&
                "sm:grid-cols-2"
            )}
          >
            {canEditModel ? (
              <Field label={t("configModel")} hint={t("configModelHint")}>
                <Select
                  value={form.modelBindingId}
                  onChange={(event) =>
                    update({ modelBindingId: event.target.value, modelProviderId: "" })
                  }
                >
                  <option value="">{t("configInstanceDefault")}</option>
                  {modelBindings.length ? (
                    <optgroup label={t("configConfiguredBindings")}>
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
              <Field label={t("configReasoningEffort")} hint={t("configReasoningEffortHint")}>
                <Select
                  value={form.reasoningEffort}
                  onChange={(event) => update({ reasoningEffort: event.target.value })}
                >
                  <option value="">{t("configModelDefault")}</option>
                  {(references?.reasoningEfforts ?? []).map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {canEditMaxSteps ? (
              <Field label={t("configMaxSteps")} hint={t("configMaxStepsHint")}>
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

      {error ? <p className="px-5 py-3 text-sm text-destructive">{error}</p> : null}

      {revisions}

      <SaveBar
        label={isNew ? t("configCreateAgent") : t("configSaveChanges")}
        mutating={mutating}
        disabled={editableAgentFields.length === 0}
      />

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

function modelBindingLabel(
  binding: { id: string; model: string },
  bindings: Array<{ id: string; model: string }>
): string {
  const duplicateModel = bindings.some(
    (candidate) => candidate.id !== binding.id && candidate.model === binding.model
  );
  return duplicateModel ? `${binding.model} (${binding.id})` : binding.model;
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

  const update = (patch: Partial<SkillFormState>) => setForm((value) => ({ ...value, ...patch }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError((await onSave(form)).error);
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
              placeholder="generic_workflow_review"
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
      >
        <Field label={t("configContent")} hint={t("configSkillContentHint")}>
          <EditorTextarea
            label={t("configMarkdown")}
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
        label={isNew ? t("configCreateSkill") : t("configSaveChanges")}
        mutating={mutating}
        disabled={!editable}
      />

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
  onRevert(revision: number): Promise<MutationOutcome>;
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
              {[...revisions].reverse().map((revision) => (
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
                      {t("configRestore")}
                    </Button>
                  ) : (
                    <span className="text-right text-muted-foreground">{t("configCurrent")}</span>
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
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-3 bg-muted/10 px-5 py-4">
      <Button type="submit" className="w-full sm:w-auto" disabled={mutating || disabled}>
        {mutating ? <Spinner className="size-4" /> : null}
        {label}
      </Button>
      <span className="text-xs text-muted-foreground">{t("configAppliesImmediately")}</span>
    </div>
  );
}
