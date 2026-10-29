import { Library } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  ProjectKnowledgeBaseChoiceView,
  ProjectSetupView,
  ProjectView
} from "@work-shape/catalyst-api-client";
import { PROJECT_KNOWLEDGE_BASES_MAX } from "@work-shape/catalyst-core";
import {
  Banner,
  Button,
  Chip,
  Drawer,
  FormNotice,
  InlineError,
  Picker,
  PickerButton,
  SkeletonList,
  cn,
  type PickerOption
} from "@work-shape/catalyst-ui";
import { useProjectSetupQuery, useSetProjectSetupMutation } from "../../shared/api/projects";
import type { BuildWorkspace } from "../../shared/build-rights";
import { useTranslation } from "../../shared/i18n";
import { apiErrorCode } from "../../shared/workspace-utils";
import { PICKER_WIDTH, useProjectChoiceShare, type ProjectSetupWorkspace } from "./project-setup";

// A project's Knowledge Bases (PRJ-8), beside its skills and agent. Every chat in the project
// searches them beside its agent's own; attaching grants nothing. Only what everyone who reads
// the project may search can be attached: the person's own is greyed in a project others read,
// with the share into the workspace, and one not available in the workspace is greyed with the
// reason. One that stops applying stays listed as not applying and is searched by no chat.

/** A Knowledge Base every chat of the project searches now. */
function applies(choice: ProjectKnowledgeBaseChoiceView | undefined) {
  return choice !== undefined && choice.refusal === undefined && choice.unpublished !== true;
}

/** The attached Knowledge Bases that apply now, and the titles of those that no longer do. */
function attachedKnowledge(setup: ProjectSetupView) {
  const byName = new Map((setup.knowledgeBaseChoices ?? []).map((entry) => [entry.name, entry]));
  const applied: ProjectKnowledgeBaseChoiceView[] = [];
  const unavailable: string[] = [];
  for (const name of setup.knowledgeBases) {
    const choice = byName.get(name);
    if (choice && applies(choice)) applied.push(choice);
    else unavailable.push(choice?.title || name);
  }
  return { applied, unavailable };
}

/** A Knowledge Base attached to the project no longer applies to its chats. */
export function projectKnowledgeUnavailable(setup: ProjectSetupView): boolean {
  return attachedKnowledge(setup).unavailable.length > 0;
}

/**
 * The Knowledge Bases of the project, opened from its page's "…" menu. The menu offers them only
 * where the module `knowledge` is on: the server then lists the choices.
 */
export function ProjectKnowledgeDrawer({
  project,
  workspace,
  workspaces,
  open,
  onClose
}: {
  project: ProjectView;
  workspace: ProjectSetupWorkspace;
  workspaces: readonly BuildWorkspace[];
  open: boolean;
  onClose(): void;
}) {
  const setup = useProjectSetupQuery(project.id);
  return (
    <ProjectKnowledgePanel
      project={project}
      workspace={workspace}
      workspaces={workspaces}
      open={open}
      setup={setup.data}
      failed={setup.isError}
      onClose={onClose}
    />
  );
}

/** The Knowledge Bases in the drawer beside the page, saved on their own. */
function ProjectKnowledgePanel({
  project,
  workspace,
  workspaces,
  open,
  setup,
  failed,
  onClose
}: {
  project: ProjectView;
  workspace: ProjectSetupWorkspace;
  workspaces: readonly BuildWorkspace[];
  open: boolean;
  setup: ProjectSetupView | undefined;
  failed: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const save = useSetProjectSetupMutation(project.id, t("projectFiles.held"));
  const share = useProjectChoiceShare(project, workspace, workspaces);
  // What the person changed since opening; until then the project as it is now.
  const [draft, setDraft] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const chosen = draft ?? setup?.knowledgeBases ?? [];
  const max = PROJECT_KNOWLEDGE_BASES_MAX;

  // Each opening starts from the project as it is now.
  useEffect(() => {
    if (open) return;
    setDraft(undefined);
    setError(undefined);
    setSaved(false);
  }, [open]);

  const choices = setup?.knowledgeBaseChoices ?? [];
  const byName = new Map(choices.map((entry) => [entry.name, entry]));
  const reasonOf = (entry: ProjectKnowledgeBaseChoiceView) =>
    entry.refusal === "not_everyone_may_use"
      ? t("projectKnowledge.notEveryone", { team: workspace.name })
      : t("projectKnowledge.ownInSharedProject");
  const unavailable = chosen.filter((name) => !applies(byName.get(name)));

  async function submit() {
    setError(undefined);
    setSaved(false);
    try {
      await save.mutateAsync({ knowledgeBases: chosen });
      setSaved(true);
    } catch (failure) {
      const code = apiErrorCode(failure);
      setError(
        code === "VALIDATION_FAILED"
          ? t("projectSetup.refused")
          : code === "CONFLICT"
            ? t("projectSetup.changedMeanwhile")
            : t("projectSetup.saveFailed")
      );
    }
  }

  const descriptionOf = (entry: ProjectKnowledgeBaseChoiceView) =>
    [
      entry.unpublished ? t("projectKnowledge.unpublished") : undefined,
      entry.own ? t("projectKnowledge.ownHint") : entry.description
    ]
      .filter(Boolean)
      .join(" · ");
  const options: PickerOption[] = [
    ...choices
      .filter((entry) => entry.refusal === undefined)
      .map((entry) => {
        const description = descriptionOf(entry);
        return {
          value: entry.name,
          label: entry.title || entry.name,
          ...(description ? { description } : {}),
          keywords: entry.name,
          leading: <Library aria-hidden="true" />
        };
      }),
    ...choices
      .filter((entry) => entry.refusal !== undefined)
      .map((entry) => {
        const action =
          entry.refusal === "own_in_shared_project"
            ? share.action("knowledge_base", entry, entry.title || entry.name)
            : undefined;
        return {
          value: entry.name,
          label: entry.title || entry.name,
          disabled: true,
          disabledReason: reasonOf(entry),
          ...(action ? { disabledAction: action } : {}),
          keywords: entry.name,
          leading: <Library aria-hidden="true" />
        };
      })
  ];

  const footer = (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        loading={save.isPending}
        disabled={!setup}
        data-testid="project-knowledge-save"
        onClick={() => {
          submit().catch(() => undefined);
        }}
      >
        {t("projectSetup.save")}
      </Button>
      <Button variant="outline" size="sm" disabled={save.isPending} onClick={onClose}>
        {t("projectSetup.cancel")}
      </Button>
    </div>
  );

  return (
    <Drawer
      open={open}
      title={t("projectKnowledge.title")}
      description={project.title}
      onClose={onClose}
      className="w-[min(40rem,100vw)]"
      footer={footer}
    >
      <div className="grid gap-6" data-testid="project-knowledge-panel">
        <p className="text-body text-muted-foreground">
          {t("projectKnowledge.panelLead", { project: project.title })}
        </p>
        {error ? <FormNotice tone="error">{error}</FormNotice> : null}
        {saved ? <FormNotice tone="success">{t("projectSetup.saved")}</FormNotice> : null}
        {failed ? (
          <InlineError>{t("projectKnowledge.loadFailed")}</InlineError>
        ) : !setup ? (
          <SkeletonList rows={3} />
        ) : (
          <section className="grid gap-3" aria-labelledby="project-knowledge-field">
            <div className="grid gap-1">
              <h3 id="project-knowledge-field" className="text-label font-medium">
                {t("projectKnowledge.field")}
              </h3>
              <p className="text-caption text-muted-foreground">
                {t("projectKnowledge.hint", { max })}
              </p>
            </div>
            {chosen.length === 0 ? (
              <p className="text-body text-muted-foreground">{t("projectKnowledge.none")}</p>
            ) : (
              <ul
                aria-label={t("projectKnowledge.field")}
                className="flex flex-wrap gap-2"
                data-testid="project-knowledge-list"
              >
                {chosen.map((name) => {
                  const entry = byName.get(name);
                  const title = entry?.title || name;
                  const live = applies(entry);
                  return (
                    <li key={name} data-state={live ? "applies" : "unavailable"}>
                      <Chip
                        leading={<Library aria-hidden="true" />}
                        className={cn(!live && "text-muted-foreground line-through")}
                        onRemove={() => setDraft(chosen.filter((entry) => entry !== name))}
                      >
                        {live ? title : t("projectKnowledge.unavailableChip", { name: title })}
                      </Chip>
                    </li>
                  );
                })}
              </ul>
            )}
            {unavailable.length > 0 ? (
              <Banner layout="line" tone="warning" data-testid="project-knowledge-unavailable">
                {t("projectKnowledge.unavailable", {
                  names: unavailable.map((name) => byName.get(name)?.title || name).join(", ")
                })}
              </Banner>
            ) : null}
            <div>
              <Picker
                multiple
                search
                wrapDescriptions
                className={PICKER_WIDTH}
                label={t("projectKnowledge.choose")}
                options={options}
                value={chosen}
                onValueChange={(next) => setDraft(next.slice(0, max))}
              >
                <PickerButton
                  label={t("projectKnowledge.field")}
                  placeholder={t("projectKnowledge.choose")}
                  data-testid="project-knowledge-add"
                  value={undefined}
                />
              </Picker>
            </div>
          </section>
        )}
      </div>
      {share.dialog}
    </Drawer>
  );
}
