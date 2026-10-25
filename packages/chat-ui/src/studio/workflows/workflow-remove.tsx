import { useState } from "react";
import {
  ConfirmDialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  InlineError,
  List,
  ListRow,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { instanceSentence } from "../build-area/build-refusals";
import { useWorkflowRemoval } from "./workflow-data";
import type { WorkflowRemovalView } from "./source-shapes";
import { useWorkflowsSource } from "./workflow-source";

// KBW-2c: the question before a Workflow is deleted. Its delete also ends what it put into
// Knowledge Bases: the question names each one the reader may open with how many documents
// it holds there, and counts the rest. The delete waits until that answer is there.

/** "Delete" in a Workflow's menu, where the source deletes Workflows. The menu mounts it only
 * when opened, so the source is read only there. */
export function WorkflowRemoveItem({
  separated,
  onSelect
}: {
  separated: boolean;
  onSelect(): void;
}) {
  const { t } = useTranslation();
  if (useWorkflowsSource().removal === undefined) return null;
  return (
    <>
      {separated ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem tone="danger" onSelect={onSelect}>
        {t("workflows.remove.menu")}
      </DropdownMenuItem>
    </>
  );
}

export function WorkflowRemoveDialog({
  workflow,
  name,
  onRemoved,
  onClose
}: {
  workflow: string;
  name: string;
  onRemoved(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { question, remove } = useWorkflowRemoval(workflow, true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const answer = question.data;
  return (
    <ConfirmDialog
      open
      tone="danger"
      title={t("workflows.remove.title", { name })}
      confirmLabel={t("workflows.remove.confirm")}
      loading={busy}
      confirmDisabled={answer === undefined}
      onConfirm={() => {
        if (answer === undefined) return;
        setBusy(true);
        setError(undefined);
        remove(answer.revision)
          .then(onRemoved)
          .catch((failure: unknown) => {
            setError(instanceSentence(failure) ?? t("workflows.remove.failed"));
          })
          .finally(() => setBusy(false));
      }}
      onClose={onClose}
    >
      <p>{t("workflows.remove.body")}</p>
      {question.isPending ? (
        <SkeletonList className="mt-3" rows={2} />
      ) : question.isError ? (
        <InlineError className="mt-3">{t("workflows.remove.readFailed")}</InlineError>
      ) : answer ? (
        <WorkflowRemoveKnowledge view={answer} />
      ) : null}
      {error ? <InlineError className="mt-3">{error}</InlineError> : null}
    </ConfirmDialog>
  );
}

/**
 * What the delete ends in Knowledge Bases: each one the reader may open by its title with its
 * documents, the rest counted. Nothing where the Workflow fed none.
 */
export function WorkflowRemoveKnowledge({
  view
}: {
  view: Pick<WorkflowRemovalView, "knowledgeBases" | "hidden">;
}) {
  const { t } = useTranslation();
  if (view.knowledgeBases.length === 0 && view.hidden.knowledgeBases === 0) return null;
  const documents = (count: number) =>
    count === 1
      ? t("workflows.remove.document")
      : t("workflows.remove.documents", { count: String(count) });
  return (
    <div className="mt-3" data-workflow-remove-knowledge="">
      <p>{t("workflows.remove.knowledgeLead")}</p>
      <List className="mt-2" aria-label={t("workflows.remove.knowledgeLabel")}>
        {view.knowledgeBases.map((base) => (
          <ListRow
            key={base.name}
            title={base.title}
            description={documents(base.documents)}
            data-workflow-remove-knowledge-base={base.name}
          />
        ))}
        {view.hidden.knowledgeBases > 0 ? (
          <ListRow
            title={
              view.hidden.knowledgeBases === 1
                ? t("workflows.remove.hiddenOne")
                : t("workflows.remove.hiddenMany", { count: String(view.hidden.knowledgeBases) })
            }
            description={documents(view.hidden.documents)}
          />
        ) : null}
      </List>
    </div>
  );
}
