import { useState, type ReactNode } from "react";
import { ApiError } from "@vivd-catalyst/api-client";
import { Banner, Button, ConfirmDialog, InlineError } from "@vivd-catalyst/ui";
import { instanceSentence, PendingApprovalError } from "../build-area/build-refusals";
import { useTranslation } from "../i18n";
import { useWorkflowDraftWrites } from "./workflow-data";
import { draftState, editOffered, type WorkflowDraftState } from "./workflow-model";
import type { WorkflowView } from "./workflow-views";
import { useWorkflowsHost } from "./workflows-host";

// The draft of a Workflow on its page: the conversation in which the agent changes it, and the
// bar that says the draft is not what is published, with the test run, the publish and the
// discard.

/** "Edit with the agent" as the head of a Workflow shows it. */
export interface WorkflowEdit {
  /** The conversation is being made. */
  busy: boolean;
  /** Why the instance made no conversation. */
  error: string | undefined;
  start(): void;
  dismissError(): void;
}

/**
 * The start of a conversation about a Workflow, for a reader who may write it. Nothing for
 * everybody else, and nothing where no conversation can be started.
 */
export function useEditWithAgent(
  workflow: string,
  view: Pick<WorkflowView, "draft"> | undefined
): WorkflowEdit | undefined {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const editWithAgent = host?.editWithAgent;
  if (host === undefined || editWithAgent === undefined || !editOffered(host.rights, view)) {
    return undefined;
  }
  return {
    busy,
    error,
    start() {
      setBusy(true);
      setError(undefined);
      // The page is left once the conversation opens: only a refusal comes back here.
      editWithAgent(workflow)
        .catch((failure: unknown) => {
          setError(
            // A Workflow the reader may not read and one that is gone are refused alike.
            failure instanceof ApiError && (failure.status === 403 || failure.status === 404)
              ? t("workflows.edit.refused")
              : (instanceSentence(failure) ?? t("workflows.edit.failed"))
          );
        })
        .finally(() => setBusy(false));
    },
    dismissError: () => setError(undefined)
  };
}

/** Says that the instance made no conversation about the Workflow. */
export function EditRefusedBanner({
  edit
}: {
  edit: Pick<WorkflowEdit, "error" | "dismissError">;
}) {
  return edit.error === undefined ? null : (
    <Banner
      tone="danger"
      layout="page"
      className="shrink-0"
      data-edit-refused=""
      onDismiss={edit.dismissError}
    >
      {edit.error}
    </Banner>
  );
}

/** The bar of a draft as the page of a Workflow shows it. */
export interface WorkflowDraftBarState {
  state: WorkflowDraftState;
  /** Absent for a reader who may not write the Workflow. */
  onTest?: () => void;
  /** Absent for a reader who may not publish Workflows. */
  onPublish?: () => void;
  /** Absent where there is nothing to go back to, and for a reader who may not write. */
  onDiscard?: () => void;
}

/**
 * Says that what the page draws is a draft that is not the published revision, and offers to
 * test it, publish it or discard it to whoever may. A draft of a Workflow that was never
 * published is said as that: there is no published revision it could differ from.
 */
export function WorkflowDraftBar({ state, onTest, onPublish, onDiscard }: WorkflowDraftBarState) {
  const { t } = useTranslation();
  return (
    <Banner
      tone="info"
      layout="page"
      className="shrink-0"
      data-workflow-draft={state}
      title={t(state === "ahead" ? "workflows.draft.ahead" : "workflows.draft.unpublished")}
      action={
        onTest === undefined && onPublish === undefined && onDiscard === undefined ? undefined : (
          <>
            {onTest === undefined ? null : (
              <Button variant="outline" size="sm" onClick={onTest}>
                {t("workflows.test.button")}
              </Button>
            )}
            {onPublish === undefined ? null : (
              <Button variant="outline" size="sm" onClick={onPublish}>
                {t("workflows.draft.publish")}
              </Button>
            )}
            {onDiscard === undefined ? null : (
              <Button variant="ghost" size="sm" onClick={onDiscard}>
                {t("workflows.draft.discard")}
              </Button>
            )}
          </>
        )
      }
    >
      {t(state === "ahead" ? "workflows.draft.aheadBody" : "workflows.draft.unpublishedBody")}
    </Banner>
  );
}

type DraftChange = "publish" | "discard";

/**
 * The bar of a Workflow's draft and the question before each change of it. The publish names
 * the revision the page read, never "whatever the draft is now"; the discard names it as the
 * revision it expects. A refusal is answered in the question.
 */
export function useWorkflowDraft(
  workflow: string,
  view: Pick<WorkflowView, "name" | "draft"> | undefined
): { bar: WorkflowDraftBarState | undefined; dialog: ReactNode } {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  const writes = useWorkflowDraftWrites();
  const [asking, setAsking] = useState<DraftChange>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The publish was sent and waits for an approver: the live revision stays until then.
  const [waits, setWaits] = useState(false);
  const state = draftState(view);
  const draft = view?.draft;
  if (host === undefined || view === undefined || draft === undefined || state === undefined) {
    return { bar: undefined, dialog: null };
  }
  const ask = (change: DraftChange) => () => {
    setError(undefined);
    setWaits(false);
    setAsking(change);
  };
  const run = async (change: DraftChange) => {
    setBusy(true);
    setError(undefined);
    setWaits(false);
    try {
      await (change === "publish"
        ? writes?.publish(workflow, draft.revision)
        : writes?.discard(workflow, draft.revision));
      setAsking(undefined);
    } catch (failure) {
      if (failure instanceof PendingApprovalError) {
        setWaits(true);
        return;
      }
      setError(
        instanceSentence(failure) ??
          t(change === "publish" ? "workflows.draft.publishFailed" : "workflows.draft.discardFailed")
      );
    } finally {
      setBusy(false);
    }
  };
  return {
    bar: {
      state,
      ...(writes !== undefined && host.rights.publish ? { onPublish: ask("publish") } : {}),
      ...(writes !== undefined && host.rights.write && state === "ahead"
        ? { onDiscard: ask("discard") }
        : {})
    },
    dialog:
      asking === undefined ? null : (
        <DraftChangeDialog
          change={asking}
          name={view.name}
          revision={draft.revision}
          publishedRevision={draft.publishedRevision}
          loading={busy}
          error={error}
          waits={waits}
          onConfirm={() => {
            run(asking).catch(() => undefined);
          }}
          onClose={() => setAsking(undefined)}
        />
      )
  };
}

/** Asks once before a draft is published or discarded, and answers a refusal in place. */
export function DraftChangeDialog({
  change,
  name,
  revision,
  publishedRevision,
  loading,
  error,
  waits = false,
  onConfirm,
  onClose
}: {
  change: DraftChange;
  name: string;
  /** The draft the page read: the revision a publish names. */
  revision: number;
  publishedRevision: number | undefined;
  loading: boolean;
  error: string | undefined;
  /** The publish was sent and waits for an approver. */
  waits?: boolean;
  onConfirm(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const publish = change === "publish";
  return (
    <ConfirmDialog
      open
      tone={publish ? "primary" : "danger"}
      title={t(publish ? "workflows.draft.publishTitle" : "workflows.draft.discardTitle", { name })}
      confirmLabel={t(publish ? "workflows.draft.publish" : "workflows.draft.discard")}
      loading={loading}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {publish
        ? t("workflows.draft.publishBody", { number: revision })
        : t("workflows.draft.discardBody", { number: publishedRevision ?? revision })}
      {error ? <InlineError className="mt-3">{error}</InlineError> : null}
      {waits ? (
        <Banner layout="line" role="status" className="mt-3" data-testid="workflow-publish-waits">
          {t("workflows.draft.pending")}
        </Banner>
      ) : null}
    </ConfirmDialog>
  );
}
