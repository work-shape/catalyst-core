import { CircleAlert, TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { ApprovalRequestView, DraftAttachment } from "@vivd-catalyst/api-client";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { useAttachmentContentContext } from "../attachment-content";
import { useToolDisplayActions } from "../domain-ui-widgets";
import { useTranslation, type TranslationKey } from "../i18n";
import { useToolDisplayPanel } from "../tool-display-panel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { cn } from "../ui/cn";
import { Textarea } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { useWorkspaceDraftController } from "../workspace/workspace-drafts";
import {
  APPROVAL_AUTH_SCOPE,
  isApprovalRequestNotFound,
  useApprovalRequestActions,
  useApprovalRequestQuery,
  type ApprovalActionFailure,
  type ApprovalDecisionInput
} from "./approval-request-api";
import { ApprovalRequestBody, approvalRequestSubject } from "./approval-request-bodies";
import {
  approvalRevisionHintKey,
  approvalRevisionPlan,
  approvalStatusPresentation,
  canRevertApprovalRequest,
  formatApprovalDate,
  offersApprovalWithdraw,
  readApprovalReversion,
  shouldSendApprovalFollowUp,
  visibleApprovalChecks,
  type ApprovalStatusTone
} from "./approval-request-model";
import { useApprovalRevisionHost } from "./approval-revision-host";
import { buildApprovalRevisionMessage } from "./approval-revision-message";

export type ApprovalRequestCardState =
  | { status: "loading" }
  /** Missing, or not visible to this user: the server does not tell the two apart. */
  | { status: "not-found" }
  | { status: "error"; onRetry(): void }
  | { status: "ready"; request: ApprovalRequestView };

export interface ApprovalRequestCardActions {
  pending: boolean;
  failure?: ApprovalActionFailure;
  onDecide(decision: ApprovalDecisionInput): void;
  onWithdraw(): void;
  /** Absent while the API client has no rollback operation. */
  onRevert?(): void;
  /** What requesting changes sets off, for the form. Absent when nothing follows. */
  revisionHintKey?: TranslationKey;
}

/**
 * Card for the thread: fetches the request's live state by id and stays
 * compact. The proposal itself opens in the display panel.
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
  const actions = useApprovalRequestCardActions(requestId, query.data);
  const displayPanel = useToolDisplayPanel();
  const request = query.data;

  return (
    <ApprovalRequestCardView
      variant="compact"
      state={approvalRequestCardState(query)}
      actions={actions}
      onShowDetails={
        request && displayPanel.available
          ? () =>
              displayPanel.show({
                key: `approval-request:${request.id}`,
                title: request.summary.trim() || t("approvalFallbackTitle"),
                subtitle: approvalRequestSubject(request, t),
                node: <ApprovalRequestDetailsPanel requestId={request.id} />
              })
          : undefined
      }
    />
  );
}

/** Card for the review queue: the list already carries the request's current state. */
export function ListedApprovalRequestCard({ request }: { request: ApprovalRequestView }) {
  const actions = useApprovalRequestCardActions(request.id, request);

  return <ApprovalRequestCardView state={{ status: "ready", request }} actions={actions} />;
}

/**
 * Display panel content for a card in the thread. It follows the request's live
 * state and decides through the same actions as the card, so a decision made
 * here sets off exactly what it would there.
 */
export function ApprovalRequestDetailsPanel({ requestId }: { requestId: string }) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const query = useApprovalRequestQuery({
    apiBaseUrl,
    authScope: APPROVAL_AUTH_SCOPE,
    client,
    requestId
  });
  const actions = useApprovalRequestCardActions(requestId, query.data);

  return <ApprovalRequestDetailsView state={approvalRequestCardState(query)} actions={actions} />;
}

export function ApprovalRequestDetailsView({
  state,
  actions
}: {
  state: ApprovalRequestCardState;
  actions: ApprovalRequestCardActions;
}) {
  const { t } = useTranslation();

  if (state.status !== "ready") {
    return <ApprovalRequestUnavailable state={state} />;
  }
  const { request } = state;
  const status = approvalStatusPresentation(request.status);
  const canRevert = Boolean(actions.onRevert) && canRevertApprovalRequest(request);

  return (
    <div className="grid min-w-0 gap-3 text-sm" data-testid="approval-request-details">
      <ApprovalStatusBadge tone={status.tone}>{t(status.labelKey)}</ApprovalStatusBadge>
      <ApprovalRequestDetails request={request} />
      {hasApprovalActions(request, canRevert) ? (
        // Stays at the panel's lower edge while a long proposal scrolls
        // behind it; the negative margins span the panel's own padding.
        <div
          className="sticky bottom-0 -mx-4 -mb-4 border-t bg-background px-4 py-3 lg:-mx-5 lg:-mb-5 lg:px-5"
          data-testid="approval-request-details-actions"
        >
          <ApprovalRequestActions
            // A refetched request in another status starts with a clean form.
            key={request.status}
            request={request}
            actions={actions}
            canRevert={canRevert}
            compact
          />
        </div>
      ) : null}
    </div>
  );
}

function hasApprovalActions(request: ApprovalRequestView, canRevert: boolean): boolean {
  return request.canDecide || offersApprovalWithdraw(request) || canRevert;
}

function approvalRequestCardState(
  query: Pick<ReturnType<typeof useApprovalRequestQuery>, "data" | "error" | "isError" | "refetch">
): ApprovalRequestCardState {
  return query.data
    ? { status: "ready", request: query.data }
    : isApprovalRequestNotFound(query.error)
      ? { status: "not-found" }
      : query.isError
        ? { status: "error", onRetry: () => void query.refetch() }
        : { status: "loading" };
}

/**
 * The request's actions plus what follows "request changes". The reviewer who
 * asks for a revision is also the one who gets it: in the conversation on
 * screen, in their own origin conversation, or in a new one.
 */
function useApprovalRequestCardActions(
  requestId: string,
  request: ApprovalRequestView | undefined
): ApprovalRequestCardActions {
  const { t } = useTranslation();
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const originConversationId = request?.origin?.conversationId;
  const openConversationId = useAttachmentContentContext()?.selectedConversationId;
  // Absent while the open conversation cannot take a message, a running run included.
  const sendMessage = useToolDisplayActions()?.sendMessage;
  const revisionHost = useApprovalRevisionHost();
  const queryClient = useQueryClient();
  const composerDraftText = useWorkspaceDraftController().draftFor({
    authScope: APPROVAL_AUTH_SCOPE,
    conversationId: openConversationId
  });
  const revisionPlan = request
    ? approvalRevisionPlan({
        originConversationId,
        openConversationId,
        requestedById: request.requestedBy.id,
        currentUserId: revisionHost?.currentUserId
      })
    : undefined;
  const actions = useApprovalRequestActions({
    apiBaseUrl,
    authScope: APPROVAL_AUTH_SCOPE,
    client,
    requestId,
    originConversationId,
    onDecided(decision) {
      if (decision.decision !== "request_changes" || !request || !revisionPlan) {
        return false;
      }
      if (revisionPlan.kind !== "open_conversation") {
        const proposingAgentName = request.origin?.agentName;
        revisionHost?.startRevision({
          ...(revisionPlan.kind === "origin_conversation"
            ? {
                origin: {
                  conversationId: revisionPlan.conversationId,
                  agentName: proposingAgentName,
                  // The comment is in the decision the agent reads there.
                  text: t("approvalFollowUpMessage")
                }
              }
            : {}),
          newConversation: {
            agentName: revisionHost.personalWorkspaceAgentName(proposingAgentName),
            text: buildApprovalRevisionMessage({ request, comment: decision.comment, t })
          },
          failureNotice: t("approvalRevisionStartFailed")
        });
        return false;
      }
      const followUp = shouldSendApprovalFollowUp({
        decision: decision.decision,
        originConversationId,
        openConversationId,
        canSendMessage: Boolean(sendMessage),
        composerDraftText,
        // The composer's own list, in every state. A file still uploading is
        // not in it yet, but blocks sending and so leaves `sendMessage` absent.
        draftAttachmentCount:
          queryClient.getQueryData<DraftAttachment[]>(
            workspaceQueryKeys.draftAttachments(apiBaseUrl, APPROVAL_AUTH_SCOPE, openConversationId)
          )?.length ?? 0
      });
      if (followUp) {
        // The comment is in the decision the agent reads; this only starts the run.
        sendMessage?.(t("approvalFollowUpMessage"));
      }
      return followUp;
    }
  });

  return {
    pending: actions.pending,
    failure: actions.failure,
    onDecide: actions.decide,
    onWithdraw: actions.withdraw,
    onRevert: actions.revert,
    revisionHintKey:
      revisionPlan && (revisionPlan.kind === "open_conversation" || revisionHost)
        ? approvalRevisionHintKey(revisionPlan)
        : undefined
  };
}

export function ApprovalRequestCardView({
  state,
  actions,
  variant = "full",
  onShowDetails
}: {
  state: ApprovalRequestCardState;
  actions: ApprovalRequestCardActions;
  /** `compact` is the card in the thread; the review queue shows the full one. */
  variant?: "full" | "compact";
  /** Compact only: opens the proposal next to the thread. */
  onShowDetails?(): void;
}) {
  const { t } = useTranslation();

  if (state.status !== "ready") {
    return (
      <Card
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground",
          variant === "compact" ? "px-4 py-3" : "p-4"
        )}
        data-testid="approval-request-card"
        role="status"
      >
        <ApprovalRequestUnavailable state={state} />
      </Card>
    );
  }

  const { request } = state;
  const status = approvalStatusPresentation(request.status);
  const canRevert = Boolean(actions.onRevert) && canRevertApprovalRequest(request);
  const hasActions = hasApprovalActions(request, canRevert);
  const summary = request.summary.trim() || t("approvalFallbackTitle");
  const badge = <ApprovalStatusBadge tone={status.tone}>{t(status.labelKey)}</ApprovalStatusBadge>;

  if (variant === "compact") {
    const subject = approvalRequestSubject(request, t);
    const detailsButton = onShowDetails ? (
      <Button type="button" size="sm" variant="ghost" onClick={onShowDetails}>
        {t("approvalDetails")}
      </Button>
    ) : null;
    return (
      <Card
        className="grid min-w-0 gap-2 px-4 py-3 text-sm"
        data-testid="approval-request-card"
        data-variant="compact"
        aria-label={t("approvalFallbackTitle")}
        role="group"
      >
        <div className="flex min-w-0 items-start gap-2">
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="line-clamp-2 min-w-0 font-medium text-foreground">{summary}</p>
            {subject ? <p className="truncate text-xs text-muted-foreground">{subject}</p> : null}
          </div>
          <ApprovalCheckIndicator checks={visibleApprovalChecks(request.checks)} />
          {badge}
          {hasActions ? null : detailsButton}
        </div>
        {hasActions ? (
          <ApprovalRequestActions
            // A refetched request in another status starts with a clean form.
            key={request.status}
            request={request}
            actions={actions}
            canRevert={canRevert}
            compact
            trailing={detailsButton}
          />
        ) : null}
      </Card>
    );
  }

  return (
    <Card
      className="grid min-w-0 gap-3 p-4 text-sm"
      data-testid="approval-request-card"
      aria-label={t("approvalFallbackTitle")}
      role="group"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <p className="min-w-0 flex-1 basis-56 font-medium text-foreground">{summary}</p>
        {badge}
      </div>

      <ApprovalRequestDetails request={request} />

      {hasActions ? (
        <ApprovalRequestActions
          // A refetched request in another status starts with a clean form.
          key={request.status}
          request={request}
          actions={actions}
          canRevert={canRevert}
        />
      ) : null}
    </Card>
  );
}

function ApprovalRequestUnavailable({
  state
}: {
  state: Exclude<ApprovalRequestCardState, { status: "ready" }>;
}) {
  const { t } = useTranslation();

  if (state.status === "loading") {
    return (
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner size="sm" />
        <span>{t("approvalLoading")}</span>
      </span>
    );
  }
  if (state.status === "not-found") {
    return <span className="text-sm text-muted-foreground">{t("approvalNotFound")}</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <CircleAlert size={15} className="shrink-0 text-destructive" aria-hidden="true" />
      <span>{t("approvalLoadFailed")}</span>
      <Button type="button" size="sm" variant="outline" onClick={state.onRetry}>
        {t("tryAgain")}
      </Button>
    </span>
  );
}

/** Everything about a request except its title, status and actions. */
function ApprovalRequestDetails({ request }: { request: ApprovalRequestView }) {
  const { locale, t } = useTranslation();
  const checks = visibleApprovalChecks(request.checks);
  const decision = request.decision;
  const reversion = readApprovalReversion(request);

  return (
    <>
      <p className="text-xs text-muted-foreground">
        {t("approvalRequestedBy", {
          name: request.requestedBy.displayLabel,
          date: formatApprovalDate(request.createdAt, locale)
        })}
      </p>

      {checks.length > 0 ? (
        <ul className="grid min-w-0 gap-1.5">
          {checks.map((check) => (
            <li
              key={check.id}
              className={cn(
                "flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-foreground",
                check.status === "blocked"
                  ? "border-destructive/40 bg-destructive/5"
                  : "border-warning/40 bg-warning/10"
              )}
            >
              <TriangleAlert
                size={15}
                className={cn(
                  "mt-0.5 shrink-0",
                  check.status === "blocked" ? "text-destructive" : "text-warning"
                )}
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="sr-only">
                  {t(check.status === "blocked" ? "approvalCheckBlocked" : "approvalCheckWarned")}
                  {": "}
                </span>
                {approvalCheckText(check, t)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <ApprovalRequestBody request={request} />

      {decision || reversion ? (
        <div className="grid min-w-0 gap-1.5 border-t pt-3">
          {decision ? (
            <p className="text-xs text-muted-foreground">
              {t("approvalDecidedBy", {
                name: decision.decidedByLabel,
                date: formatApprovalDate(decision.decidedAt, locale)
              })}
            </p>
          ) : null}
          {decision?.comment ? (
            <blockquote className="min-w-0 whitespace-pre-wrap border-l-2 border-border pl-3 text-foreground">
              {decision.comment}
            </blockquote>
          ) : null}
          {reversion ? (
            <p className="text-xs text-muted-foreground">
              {t("approvalRevertedBy", {
                name: reversion.revertedByLabel,
                date: formatApprovalDate(reversion.revertedAt, locale)
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
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

function ApprovalStatusBadge({
  tone,
  children
}: {
  tone: ApprovalStatusTone;
  children: ReactNode;
}) {
  return (
    <Badge variant={STATUS_BADGE_VARIANT[tone]} className={STATUS_BADGE_CLASS[tone]}>
      {children}
    </Badge>
  );
}

type ActionStep = "idle" | "request_changes" | "reject" | "revert";

function ApprovalRequestActions({
  request,
  actions,
  canRevert,
  compact = false,
  trailing
}: {
  request: ApprovalRequestView;
  actions: ApprovalRequestCardActions;
  canRevert: boolean;
  /** The compact card has nothing above the actions to rule off. */
  compact?: boolean;
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
      actions.onDecide({ decision: "request_changes", comment: trimmedComment });
    }
    if (step === "reject") {
      actions.onDecide({
        decision: "reject",
        ...(trimmedComment ? { comment: trimmedComment } : {})
      });
    }
  }

  const failure = actions.failure ? (
    <p role="alert" className="text-xs text-destructive">
      {t(actions.failure === "revert_conflict" ? "approvalRevertConflict" : "approvalActionFailed")}
    </p>
  ) : null;

  const frameClassName = cn("grid min-w-0 gap-2", !compact && "border-t pt-3");

  if (step === "request_changes" || step === "reject") {
    const requiresComment = step === "request_changes";
    return (
      <form className={frameClassName} onSubmit={submitComment}>
        <label htmlFor={commentId} className="text-xs font-medium text-muted-foreground">
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
          <p className="text-xs text-muted-foreground" data-testid="approval-revision-hint">
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
            onClick={() => actions.onRevert?.()}
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
              onClick={() => actions.onDecide({ decision: "approve" })}
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
            onClick={actions.onWithdraw}
          >
            {t("approvalWithdraw")}
          </Button>
        ) : null}
        {canRevert ? (
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

const STATUS_BADGE_VARIANT = {
  pending: "secondary",
  positive: "success",
  negative: "outline",
  neutral: "outline"
} as const satisfies Record<ApprovalStatusTone, string>;

const STATUS_BADGE_CLASS: Record<ApprovalStatusTone, string | undefined> = {
  pending: undefined,
  positive: undefined,
  negative: "border-destructive/40 text-destructive",
  neutral: "text-muted-foreground"
};
