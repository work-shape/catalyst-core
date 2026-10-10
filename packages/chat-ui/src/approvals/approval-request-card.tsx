import { TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { ApprovalRequestView } from "@vivd-catalyst/api-client";
import {
  Button,
  Card,
  InlineError,
  Spinner,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@vivd-catalyst/ui";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { useTranslation } from "../i18n";
import { useInboxItemActions, type InboxItemActions } from "../inbox/inbox-item-actions";
import { useInboxItemKindLookup } from "../inbox/inbox-item-kinds";
import { inboxItemSurface } from "../inbox/inbox-item-surface";
import { useToolDisplayPanel } from "../tool-display-panel";
import {
  APPROVAL_AUTH_SCOPE,
  approvalRequestState,
  useApprovalRequestQuery,
  type ApprovalRequestState
} from "./approval-request-api";
import {
  approvalActionFailureText,
  offersApprovalWithdraw,
  visibleApprovalChecks
} from "./approval-request-model";
import { ApprovalStatusBadge } from "./approval-status-badge";

/**
 * Card for the thread: fetches the request's live state by id and stays compact. The proposal
 * itself opens as an Inbox item beside the conversation.
 */
export function ApprovalRequestCard({ requestId }: { requestId: string }) {
  const { t } = useTranslation();
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const query = useApprovalRequestQuery({
    apiBaseUrl,
    authScope: APPROVAL_AUTH_SCOPE,
    client,
    requestId
  });
  const actions = useInboxItemActions(requestId, query.data);
  const displayPanel = useToolDisplayPanel();
  const kindOf = useInboxItemKindLookup();
  const request = query.data;

  return (
    <ApprovalRequestCardView
      state={approvalRequestState(query)}
      actions={actions}
      onShowDetails={
        request && displayPanel.available
          ? () => displayPanel.show(inboxItemSurface(request.id, request, kindOf, t))
          : undefined
      }
    />
  );
}

/** The compact card of a request in the thread: summary, subject, state and what can be done. */
export function ApprovalRequestCardView({
  state,
  actions,
  onShowDetails
}: {
  state: ApprovalRequestState;
  actions: InboxItemActions;
  /** Opens the proposal next to the thread. */
  onShowDetails?(): void;
}) {
  const { t } = useTranslation();
  const kindOf = useInboxItemKindLookup();

  if (state.status !== "ready") {
    return (
      <Card
        className="flex min-w-0 flex-wrap items-center gap-2 px-4 py-3 text-body text-muted-foreground"
        data-testid="approval-request-card"
        role="status"
      >
        <ApprovalRequestUnavailable state={state} />
      </Card>
    );
  }

  const { request } = state;
  const hasActions = request.canDecide || offersApprovalWithdraw(request) || request.canRevert;
  const subject = kindOf(request.kind)?.subject?.(request, t);
  const detailsButton = onShowDetails ? (
    <Button type="button" size="sm" variant="ghost" onClick={onShowDetails}>
      {t("approvalDetails")}
    </Button>
  ) : null;

  return (
    <Card
      className="grid min-w-0 gap-2 px-4 py-3 text-body"
      data-testid="approval-request-card"
      data-variant="compact"
      aria-label={t("approvalFallbackTitle")}
      role="group"
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="line-clamp-2 min-w-0 font-medium text-foreground">
            {request.summary.trim() || t("approvalFallbackTitle")}
          </p>
          {subject ? (
            <p className="truncate text-caption text-muted-foreground">{subject}</p>
          ) : null}
        </div>
        <ApprovalCheckIndicator checks={visibleApprovalChecks(request.checks)} />
        <ApprovalStatusBadge status={request.status} />
        {hasActions ? null : detailsButton}
      </div>
      {hasActions ? (
        <ApprovalRequestActions
          // A refetched request in another status starts with a clean form.
          key={request.status}
          request={request}
          actions={actions}
          trailing={detailsButton}
        />
      ) : null}
    </Card>
  );
}

function ApprovalRequestUnavailable({
  state
}: {
  state: Exclude<ApprovalRequestState, { status: "ready" }>;
}) {
  const { t } = useTranslation();

  if (state.status === "loading") {
    return (
      <span className="flex items-center gap-2">
        <Spinner size="sm" />
        <span>{t("approvalLoading")}</span>
      </span>
    );
  }
  if (state.status === "not-found") {
    return <span>{t("approvalNotFound")}</span>;
  }
  return (
    <InlineError className="flex flex-wrap items-center gap-2">
      {t("approvalLoadFailed")}
      <Button type="button" size="sm" variant="outline" onClick={state.onRetry}>
        {t("tryAgain")}
      </Button>
    </InlineError>
  );
}

type ApprovalCheck = ApprovalRequestView["checks"][number];

/** The runner stores no message for a check it could not evaluate. */
function approvalCheckText(check: ApprovalCheck, t: ReturnType<typeof useTranslation>["t"]) {
  return check.message || (check.status === "warned" ? t("approvalCheckUnevaluated") : "");
}

/** The compact card's stand-in for the check list: one icon that names what the checks found. */
function ApprovalCheckIndicator({ checks }: { checks: ApprovalCheck[] }) {
  const { t } = useTranslation();
  if (checks.length === 0) {
    return null;
  }
  const blocked = checks.some((check) => check.status === "blocked");
  const lines = checks.map(
    (check) =>
      `${t(check.status === "blocked" ? "approvalCheckBlocked" : "approvalCheckWarned")}: ${approvalCheckText(check, t)}`
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={lines.join(" ")}
          className="mt-0.5 inline-flex shrink-0 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          data-testid="approval-check-indicator"
        >
          <TriangleAlert
            size={15}
            className={blocked ? "text-destructive" : "text-warning"}
            aria-hidden="true"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent className="whitespace-pre-wrap">{lines.join("\n")}</TooltipContent>
    </Tooltip>
  );
}

type ActionStep = "idle" | "request_changes" | "reject" | "revert";

function ApprovalRequestActions({
  request,
  actions,
  trailing
}: {
  request: ApprovalRequestView;
  actions: InboxItemActions;
  /** Sits at the end of the idle row, after the request's own actions. */
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const commentId = useId();
  const [step, setStep] = useState<ActionStep>("idle");
  const [comment, setComment] = useState("");
  const trimmedComment = comment.trim();

  function openStep(nextStep: ActionStep) {
    setComment("");
    setStep(nextStep);
  }

  function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === "request_changes" && trimmedComment) {
      actions.decide({ decision: "request_changes", comment: trimmedComment });
    }
    if (step === "reject") {
      actions.decide({
        decision: "reject",
        ...(trimmedComment ? { comment: trimmedComment } : {})
      });
    }
  }

  const failure = actions.failure ? (
    <p role="alert" className="text-caption text-destructive">
      {approvalActionFailureText(actions.failure, request, t)}
    </p>
  ) : null;

  const frameClassName = "grid min-w-0 gap-2";

  if (step === "request_changes" || step === "reject") {
    const requiresComment = step === "request_changes";
    return (
      <form className={frameClassName} onSubmit={submitComment}>
        <label htmlFor={commentId} className="text-caption font-medium text-muted-foreground">
          {t(requiresComment ? "approvalRequestChangesLabel" : "approvalRejectLabel")}
        </label>
        <Textarea
          id={commentId}
          autoFocus
          rows={3}
          required={requiresComment}
          value={comment}
          disabled={actions.pending}
          onChange={(event) => setComment(event.target.value)}
        />
        {requiresComment && actions.revisionHintKey ? (
          <p className="text-caption text-muted-foreground" data-testid="approval-revision-hint">
            {t(actions.revisionHintKey)}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            size="sm"
            variant={requiresComment ? "primary" : "danger"}
            disabled={actions.pending || (requiresComment && !trimmedComment)}
          >
            {t(requiresComment ? "approvalRequestChanges" : "approvalReject")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={actions.pending}
            onClick={() => openStep("idle")}
          >
            {t("cancel")}
          </Button>
        </div>
        {failure}
      </form>
    );
  }

  if (step === "revert") {
    return (
      <div className={frameClassName}>
        <p className="text-foreground">{t("approvalRevertConfirm")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="danger"
            autoFocus
            disabled={actions.pending}
            onClick={actions.revert}
          >
            {t("approvalRevert")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={actions.pending}
            onClick={() => openStep("idle")}
          >
            {t("cancel")}
          </Button>
        </div>
        {failure}
      </div>
    );
  }

  return (
    <div className={frameClassName}>
      <div className="flex flex-wrap items-center gap-2">
        {request.canDecide ? (
          <>
            <Button
              type="button"
              size="sm"
              disabled={actions.pending}
              onClick={() => actions.decide({ decision: "approve" })}
            >
              {t("approvalAccept")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={actions.pending}
              onClick={() => openStep("request_changes")}
            >
              {t("approvalRequestChanges")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={actions.pending}
              onClick={() => openStep("reject")}
            >
              {t("approvalReject")}
            </Button>
          </>
        ) : null}
        {offersApprovalWithdraw(request) ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            disabled={actions.pending}
            onClick={actions.withdraw}
          >
            {t("approvalWithdraw")}
          </Button>
        ) : null}
        {request.canRevert ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={actions.pending}
            onClick={() => openStep("revert")}
          >
            {t("approvalRevert")}
          </Button>
        ) : null}
        {trailing ? <span className="ml-auto">{trailing}</span> : null}
      </div>
      {failure}
    </div>
  );
}
