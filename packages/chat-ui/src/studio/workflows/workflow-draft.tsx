import { useState, type ReactNode } from "react";
import { ApiError } from "@work-shape/catalyst-api-client";
import { Banner, Button, ConfirmDialog, InlineError } from "@work-shape/catalyst-ui";
import type { DraftDecision } from "../build-area/build-data";
import { instanceSentence, PendingApprovalError } from "../build-area/build-refusals";
import { useOfferDockPageChat } from "../../shared/dock-page-chat";
import { useTranslation } from "../../shared/i18n";
import {
  narrativeHolds,
  PublishDetails,
  PublishNarrativeReadLead,
  usePublishNarrative,
  type PublishNarrativeRead
} from "../../shared/publish-narrative";
import { useWorkflowDraftWrites } from "./workflow-data";
import {
  draftState,
  editOffered,
  workflowRightsOn,
  type WorkflowDraftState
} from "./workflow-model";
import type { WorkflowPublishStoreView, WorkflowStepView, WorkflowView } from "./workflow-views";
import { useWorkflowsHost } from "./workflows-host";
import { WorkflowPublishRights } from "./workflow-publish-rights";
import { workflowPublishRefusal } from "./workflow-publish-rights-model";
import { useWorkflowsSource } from "./workflow-source";

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
  /** Starts it with this text in its composer, such as what to fix after a failed run. */
  startWith(prompt: string): void;
  dismissError(): void;
}

/**
 * The start of a conversation about a Workflow, for a reader who may write it. Nothing for
 * everybody else, and nothing where no conversation can be started.
 */
export function useEditWithAgent(
  workflow: string,
  view: Pick<WorkflowView, "draft" | "allowed" | "ownerWorkspaceId"> | undefined
): WorkflowEdit | undefined {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const editWithAgent = host?.editWithAgent;
  const offered =
    host !== undefined && editWithAgent !== undefined && editOffered(host.rights, view);
  // The page head's "Chat" starts the conversation about the Workflow.
  useOfferDockPageChat(offered ? (options) => begin(undefined, options) : undefined);
  if (!offered) {
    return undefined;
  }
  function begin(prompt: string | undefined, options?: { fresh: boolean }): Promise<void> {
    if (editWithAgent === undefined) return Promise.resolve();
    setBusy(true);
    setError(undefined);
    // The conversation opens in the dock beside the Workflow's page; a refusal is said here.
    return editWithAgent(workflow, prompt, options)
      .catch((failure: unknown) => {
        setError(
          // A Workflow the reader may not read and one that is gone are refused alike.
          failure instanceof ApiError && (failure.status === 403 || failure.status === 404)
            ? t("workflows.edit.refused")
            : (instanceSentence(failure, t) ?? t("workflows.edit.failed"))
        );
      })
      .finally(() => setBusy(false));
  }
  return {
    busy,
    error,
    // A button passes its click to what it calls: the click is no prompt.
    start: () => {
      begin(undefined).catch(() => undefined);
    },
    startWith: (prompt) => {
      begin(prompt).catch(() => undefined);
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

type DraftChange = DraftDecision;

/**
 * The bar of a Workflow's draft and the question before each change of it. The publish names
 * the revision the page read, never "whatever the draft is now"; the discard names it as the
 * revision it expects. A refusal is answered in the question.
 */
export function useWorkflowDraft(
  workflow: string,
  view: Pick<WorkflowView, "name" | "draft" | "allowed" | "ownerWorkspaceId" | "steps"> | undefined
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
  const narrative = useWorkflowPublishNarrative(
    workflow,
    asking === "publish" ? draft?.revision : undefined
  );
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
      // The stores the question named are published first, at the revisions it showed (LIVE-2).
      await (change === "publish"
        ? writes?.publish(
            workflow,
            draft.revision,
            draft.handoverConfirmation,
            draft.publishDataStores?.map(({ name, revision }) => ({ name, revision }))
          )
        : writes?.discard(workflow, draft.revision));
      setAsking(undefined);
    } catch (failure) {
      if (failure instanceof PendingApprovalError) {
        setWaits(true);
        return;
      }
      setError(
        (change === "publish" ? workflowPublishRefusal(failure, t) : undefined) ??
          instanceSentence(failure, t) ??
          t(
            change === "publish" ? "workflows.draft.publishFailed" : "workflows.draft.discardFailed"
          )
      );
    } finally {
      setBusy(false);
    }
  };
  // What this Workflow lets the reader do, as its record says.
  const rights = workflowRightsOn(host.rights, view);
  // The page shows the draft's steps: what starts the revision that is published.
  const starts = view.steps.find((step) => step.kind === "trigger")?.starts;
  return {
    bar: {
      state,
      ...(writes !== undefined && rights.publish ? { onPublish: ask("publish") } : {}),
      ...(writes !== undefined && rights.write && state === "ahead"
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
          {...(starts === undefined ? {} : { starts })}
          {...(draft.publishQuestion ? { question: draft.publishQuestion } : {})}
          {...(draft.publishDataStores ? { stores: draft.publishDataStores } : {})}
          rights={<WorkflowPublishRights workflow={workflow} />}
          narrative={narrative}
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

/** A question asked without the instance's sentence, as in a sample. */
const NO_NARRATIVE: PublishNarrativeRead = { status: "none" };

/**
 * The instance's sentence on publishing one revision of a Workflow, read while the question
 * about it is open: nothing is read for another question or where the source words none.
 */
function useWorkflowPublishNarrative(
  workflow: string,
  revision: number | undefined
): PublishNarrativeRead {
  const source = useWorkflowsSource();
  const read = source.publishNarrative?.read;
  return usePublishNarrative(
    [source.key, "workflow", workflow, revision],
    read === undefined || revision === undefined
      ? undefined
      : (signal) => read(workflow, revision, signal)
  );
}

/** Asks once before a draft is published or discarded, and answers a refusal in place. */
export function DraftChangeDialog({
  change,
  name,
  revision,
  publishedRevision,
  starts,
  question = [],
  stores = [],
  rights,
  narrative = NO_NARRATIVE,
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
  /** What starts the revision, as its trigger says. Absent: the body names no way it starts. */
  starts?: Pick<NonNullable<WorkflowStepView["starts"]>, "byHand" | "onSchedule">;
  /** The instance's sentences on what a publish raises, each limit above its default. */
  question?: readonly string[];
  /** The Data Stores the publish publishes first, with the changes to their tables (LIVE-2). */
  stores?: readonly WorkflowPublishStoreView[];
  /** What the technical accounts of the publish lack, and the step that gives it. */
  rights?: ReactNode;
  /** The instance's sentence on the publish, read for `revision`. */
  narrative?: PublishNarrativeRead;
  loading: boolean;
  error: string | undefined;
  /** The publish was sent and waits for an approver. */
  waits?: boolean;
  onConfirm(): void;
  onClose(): void;
}) {
  const { locale, t } = useTranslation();
  const publish = change === "publish";
  const body = t(publishBodyKey(starts), { number: revision });
  // The stores lead the lines: they are published and migrated before anything else (LIVE-2).
  const lines = [...stores.map((store) => storeLine(store, locale, t)), ...question];
  const details = (
    <>
      {narrative.status === "none" ? null : (
        <p className="text-body text-muted-foreground" data-testid="workflow-publish-body">
          {body}
        </p>
      )}
      {lines.length > 0 ? (
        <ul
          aria-label={t("workflows.draft.publishRaises")}
          className="mt-3 grid gap-1 text-body text-foreground"
          data-testid="workflow-publish-question"
        >
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {rights}
    </>
  );
  return (
    <ConfirmDialog
      open
      tone={publish ? "primary" : "danger"}
      title={t(publish ? "workflows.draft.publishTitle" : "workflows.draft.discardTitle", { name })}
      confirmLabel={t(publish ? "workflows.draft.publish" : "workflows.draft.discard")}
      loading={loading}
      confirmDisabled={publish && narrativeHolds(narrative)}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {publish ? null : t("workflows.draft.discardBody", { number: publishedRevision ?? revision })}
      {publish && narrative.status === "none" ? body : null}
      {publish && narrative.status !== "none" ? (
        // The sentence leads; which revision goes live is a detail of it.
        <div className="grid gap-3 text-foreground">
          <PublishNarrativeReadLead read={narrative} />
          <PublishDetails>{details}</PublishDetails>
        </div>
      ) : null}
      {publish && narrative.status === "none" ? details : null}
      {error ? <InlineError className="mt-3">{error}</InlineError> : null}
      {waits ? (
        <Banner layout="line" role="status" className="mt-3" data-testid="workflow-publish-waits">
          {t("workflows.draft.pending")}
        </Banner>
      ) : null}
    </ConfirmDialog>
  );
}

/** One store the publish publishes first: its title and the changes to its tables, by name. */
function storeLine(
  store: WorkflowPublishStoreView,
  locale: string,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  const count = store.pendingMigrations.length;
  if (count === 0) return t("workflows.draft.publishStore", { title: store.title });
  return t(
    count === 1
      ? "workflows.draft.publishStoreMigrationOne"
      : "workflows.draft.publishStoreMigrations",
    {
      title: store.title,
      count: new Intl.NumberFormat(locale).format(count),
      migrations: new Intl.ListFormat(locale, { type: "conjunction" }).format(
        store.pendingMigrations
      )
    }
  );
}

/** The publish body for how the revision starts: never a schedule it does not have (C3). */
function publishBodyKey(
  starts: Pick<NonNullable<WorkflowStepView["starts"]>, "byHand" | "onSchedule"> | undefined
) {
  if (starts?.byHand === true && starts.onSchedule) return "workflows.draft.publishBodyBoth";
  if (starts?.byHand === true) return "workflows.draft.publishBodyByHand";
  if (starts?.onSchedule === true) return "workflows.draft.publishBodySchedule";
  return "workflows.draft.publishBody";
}
