import { FileText, ScrollText } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ProjectFilesView, ProjectView } from "@work-shape/catalyst-api-client";
import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  Field,
  FormNotice,
  InlineError,
  SkeletonList,
  Textarea,
  cn
} from "@work-shape/catalyst-ui";
import {
  useConversationProjectInstructionsQuery,
  useProjectFilesQuery,
  useProjectFileTextQuery,
  useProjectFileWrites
} from "../../shared/api/project-files";
import { useTranslation } from "../../shared/i18n";
import { StoredFileView } from "../../shared/stored-file-view";
import { apiErrorCode } from "../../shared/workspace-utils";
import { useOpenConversationProject } from "./add-from-project";
import { ProjectFileVersions } from "./project-file-panel";
import {
  instructionsChange,
  instructionsTruncated,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  PROJECT_INSTRUCTIONS_PATH,
  proposedInstructions
} from "./project-instructions-model";

// The instructions of a project (PRJ-3): `AGENTS.md` at the root of its folder. Every run in
// the project takes them after its agent's own. People edit them on the project's page; the
// agent proposes a change, which a person allows on a card that shows it.

/** The project's instructions as its files list them now; nothing where there are none. */
function instructionsFile(files: ProjectFilesView | undefined) {
  return files?.items.find((file) => file.path === PROJECT_INSTRUCTIONS_PATH);
}

// --- What changes ------------------------------------------------------------------------------

/** A text as it is written, in a block: the agent reads the source, so a person does too. */
function TextBlock({ text, tone }: { text: string; tone: "before" | "after" | "plain" }) {
  return (
    <pre
      className={cn(
        "max-h-72 overflow-auto rounded-md border px-3 py-2 font-sans text-body whitespace-pre-wrap wrap-anywhere",
        tone === "before"
          ? "border-border bg-muted text-muted-foreground"
          : tone === "after"
            ? "border-primary/40 bg-card text-foreground"
            : "border-border bg-card text-foreground"
      )}
    >
      {text}
    </pre>
  );
}

/** What changes between two texts of the instructions, as "Before" and "New" paragraphs. */
function InstructionsChangeView({ before, after }: { before: string; after: string }) {
  const { t } = useTranslation();
  const change = instructionsChange(before, after);
  if (!change) {
    return (
      <p className="text-caption text-muted-foreground">{t("projectInstructions.noChange")}</p>
    );
  }
  if (before.trim() === "") {
    return (
      <div className="grid min-w-0 gap-1.5" data-testid="project-instructions-change">
        <p className="text-caption text-muted-foreground">{t("projectInstructions.decisionNew")}</p>
        <TextBlock text={change.after} tone="plain" />
      </div>
    );
  }
  return (
    <div className="grid min-w-0 gap-3" data-testid="project-instructions-change">
      {change.before ? (
        <div className="grid min-w-0 gap-1.5" data-side="before">
          <p className="text-caption font-medium text-muted-foreground">
            {t(change.after ? "projectInstructions.before" : "projectInstructions.removed")}
          </p>
          <TextBlock text={change.before} tone="before" />
        </div>
      ) : null}
      {change.after ? (
        <div className="grid min-w-0 gap-1.5" data-side="after">
          <p className="text-caption font-medium text-foreground">
            {t("projectInstructions.after")}
          </p>
          <TextBlock text={change.after} tone="after" />
        </div>
      ) : null}
    </div>
  );
}

// --- The panel beside the project's page --------------------------------------------------------

/** The project has no instructions yet, or only an empty `AGENTS.md`. */
export function projectInstructionsEmpty(files: ProjectFilesView | undefined): boolean {
  const file = instructionsFile(files);
  return file === undefined || file.byteSize === 0;
}

/**
 * `AGENTS.md` in the surface beside the project's page: its text, a note where a chat takes only
 * its start, an editor, and its versions. A save names the version it replaces, so a change made
 * meanwhile is never overwritten unseen.
 */
export function ProjectInstructionsPanel({
  project
}: {
  project: Pick<ProjectView, "id" | "title">;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const files = useProjectFilesQuery(project.id);
  const file = instructionsFile(files.data);
  const text = useProjectFileTextQuery(project.id, PROJECT_INSTRUCTIONS_PATH, file?.version);
  const writes = useProjectFileWrites(project.id, t("projectFiles.held"));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const current = file ? text.data : "";

  function startEditing() {
    setDraft(current ?? "");
    setError(undefined);
    setEditing(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await writes.upload({
        file: new File([draft], PROJECT_INSTRUCTIONS_PATH, { type: "text/markdown" }),
        path: PROJECT_INSTRUCTIONS_PATH,
        ...(file ? { replaces: file.version } : {})
      });
      setEditing(false);
    } catch (failure) {
      setError(
        apiErrorCode(failure) === "CONFLICT"
          ? t("projectInstructions.changedMeanwhile")
          : failure instanceof Error && failure.message === t("projectFiles.held")
            ? t("projectFiles.held")
            : t("projectInstructions.saveFailed")
      );
    } finally {
      setPending(false);
    }
  }

  const actions = editing ? (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" form={formId} size="sm" loading={pending}>
        {t("projectInstructions.save")}
      </Button>
      <Button variant="outline" size="sm" disabled={pending} onClick={() => setEditing(false)}>
        {t("projectInstructions.cancel")}
      </Button>
    </div>
  ) : (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant={file ? "outline" : "primary"}
        disabled={file !== undefined && current === undefined}
        data-testid="project-instructions-edit"
        onClick={startEditing}
      >
        {t(file ? "projectInstructions.edit" : "projectInstructions.write")}
      </Button>
    </div>
  );

  return (
    <div className="grid gap-5" data-testid="project-instructions-panel">
      <p className="text-body text-muted-foreground">
        {t("projectInstructions.panelLead", { project: project.title })}
      </p>
      {error ? <FormNotice tone="error">{error}</FormNotice> : null}
      {editing ? (
        <form
          id={formId}
          className="grid gap-3"
          onSubmit={(event) => {
            save(event).catch(() => undefined);
          }}
        >
          <Field label={t("projectInstructions.field")} hint={t("projectInstructions.fieldHint")}>
            <Textarea
              autoFocus
              rows={14}
              value={draft}
              data-testid="project-instructions-field"
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </Field>
          {instructionsTruncated(draft) ? (
            <Banner layout="line" tone="warning">
              {t("projectInstructions.truncated", {
                max: PROJECT_INSTRUCTIONS_MAX_CHARS.toLocaleString()
              })}
            </Banner>
          ) : null}
          {actions}
        </form>
      ) : files.isPending ? (
        <SkeletonList rows={3} />
      ) : !file ? (
        <>
          <EmptyState icon={<FileText aria-hidden="true" />}>
            {t("projectInstructions.tileEmpty")}
          </EmptyState>
          {actions}
        </>
      ) : text.isError ? (
        <InlineError>{t("projectInstructions.loadFailed")}</InlineError>
      ) : current === undefined ? (
        <SkeletonList rows={3} />
      ) : (
        <>
          {instructionsTruncated(current) ? (
            <Banner layout="line" tone="warning" data-testid="project-instructions-truncated">
              {t("projectInstructions.truncated", {
                max: PROJECT_INSTRUCTIONS_MAX_CHARS.toLocaleString()
              })}
            </Banner>
          ) : null}
          <StoredFileView
            path={PROJECT_INSTRUCTIONS_PATH}
            text={current}
            className="max-h-[50dvh]"
          />
          {actions}
        </>
      )}
      {file && !editing ? (
        <section className="grid gap-2">
          <h3 className="text-label font-medium">{t("projectInstructions.versions")}</h3>
          <ProjectFileVersions
            projectId={project.id}
            path={PROJECT_INSTRUCTIONS_PATH}
            onFailed={setError}
          />
        </section>
      ) : null}
    </div>
  );
}

// --- The agent's change, on the card the person allows it on -----------------------------------

/**
 * What a held write or edit of `project/AGENTS.md` changes, against the instructions as they are
 * now, and that everyone in the project follows it. Shown on the confirmation the person allows
 * or denies; the call's raw input stays under its details.
 */
export function ProjectInstructionsDecision({
  call
}: {
  call: { operationId: string; inputPreview: unknown };
}) {
  const { t } = useTranslation();
  const chat = useOpenConversationProject();
  const instructions = useConversationProjectInstructionsQuery(chat?.conversationId);
  const projectId = instructions.data?.projectId;
  const currentVersion = instructions.data?.currentVersion;
  const text = useProjectFileTextQuery(projectId, PROJECT_INSTRUCTIONS_PATH, currentVersion);
  const current = currentVersion === undefined ? "" : text.data;
  const ready = instructions.isSuccess && current !== undefined;
  const after = ready ? proposedInstructions(call, current) : undefined;
  return (
    <div className="grid min-w-0 gap-3" data-testid="project-instructions-decision">
      <Banner layout="line" tone="info">
        {t("projectInstructions.decisionAudience", {
          project: instructions.data?.projectTitle ?? "…"
        })}
      </Banner>
      {!chat || instructions.isError || text.isError ? (
        <p className="text-caption text-muted-foreground">
          {t("projectInstructions.decisionUnreadable")}
        </p>
      ) : !ready ? (
        <SkeletonList rows={2} />
      ) : after === undefined ? (
        <p className="text-caption text-muted-foreground">
          {t("projectInstructions.decisionUnreadable")}
        </p>
      ) : (
        <InstructionsChangeView before={current} after={after} />
      )}
    </div>
  );
}

// --- The line in a chat whose project's instructions changed -----------------------------------

/**
 * One line above the composer of a chat in a project, where the project's instructions changed
 * since the chat's last run took them and the change came from elsewhere: "The project's
 * instructions changed. Show changes." It is read again whenever a run of the chat ends.
 */
export function ProjectInstructionsNotice({ running }: { running: boolean }) {
  const chat = useOpenConversationProject();
  if (!chat?.projectId) return null;
  return <ProjectInstructionsChangedLine conversationId={chat.conversationId} running={running} />;
}

function ProjectInstructionsChangedLine({
  conversationId,
  running
}: {
  conversationId: string;
  running: boolean;
}) {
  const { t } = useTranslation();
  const instructions = useConversationProjectInstructionsQuery(conversationId);
  const [open, setOpen] = useState(false);
  const wasRunning = useRef(running);
  const { refetch } = instructions;
  useEffect(() => {
    if (wasRunning.current && !running) refetch().catch(() => undefined);
    wasRunning.current = running;
  }, [running, refetch]);
  const data = instructions.data;
  if (!data?.changed || !data.projectId) return null;
  return (
    <>
      <Banner
        layout="line"
        tone="info"
        icon={<ScrollText aria-hidden="true" />}
        className="mb-2 px-1"
        data-testid="project-instructions-changed"
        action={
          <Button variant="link" size="sm" onClick={() => setOpen(true)}>
            {t("projectInstructions.showChanges")}
          </Button>
        }
      >
        {t("projectInstructions.changedNotice")}
      </Banner>
      {open ? (
        <InstructionsChangesDialog
          projectId={data.projectId}
          from={data.usedVersion}
          to={data.currentVersion}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** The change between the version the chat's last run took and the current one. */
function InstructionsChangesDialog({
  projectId,
  from,
  to,
  onClose
}: {
  projectId: string;
  from: number | undefined;
  to: number | undefined;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const before = useProjectFileTextQuery(projectId, PROJECT_INSTRUCTIONS_PATH, from);
  const after = useProjectFileTextQuery(projectId, PROJECT_INSTRUCTIONS_PATH, to);
  const beforeText = from === undefined ? "" : before.data;
  const afterText = to === undefined ? "" : after.data;
  const lead =
    from !== undefined && to !== undefined
      ? t("projectInstructions.changesLead", { from, to })
      : to !== undefined
        ? t("projectInstructions.changesLeadNew")
        : t("projectInstructions.changesLeadRemoved");
  return (
    <Dialog
      open
      title={t("projectInstructions.changesTitle")}
      onClose={onClose}
      footer={
        <Button variant="outline" onClick={onClose}>
          {t("projectInstructions.close")}
        </Button>
      }
    >
      <div className="grid gap-3" data-testid="project-instructions-changes">
        <p className="text-body text-muted-foreground">{lead}</p>
        {before.isError || after.isError ? (
          <InlineError>{t("projectInstructions.loadFailed")}</InlineError>
        ) : beforeText === undefined || afterText === undefined ? (
          <SkeletonList rows={3} />
        ) : (
          <InstructionsChangeView before={beforeText} after={afterText} />
        )}
      </div>
    </Dialog>
  );
}
