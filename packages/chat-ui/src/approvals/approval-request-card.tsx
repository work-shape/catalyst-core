import { CircleAlert, TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type { ApprovalRequestView, LocaleCode } from "@vivd-catalyst/api-client";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { useTranslation } from "../i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { cn } from "../ui/cn";
import { Textarea } from "../ui/input";
import { Spinner } from "../ui/spinner";
import {
  APPROVAL_AUTH_SCOPE,
  isApprovalRequestNotFound,
  useApprovalRequestActions,
  useApprovalRequestQuery,
  type ApprovalActionFailure,
  type ApprovalDecisionInput
} from "./approval-request-api";
import { ApprovalRequestBody } from "./approval-request-bodies";
import {
  approvalStatusPresentation,
  canRevertApprovalRequest,
  readApprovalReversion,
  visibleApprovalChecks,
  type ApprovalStatusTone
} from "./approval-request-model";

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
}

/** Card for the thread: fetches the request's live state by id. */
export function ApprovalRequestCard({ requestId }: { requestId: string }) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const api = { apiBaseUrl, authScope: APPROVAL_AUTH_SCOPE, client };
  const query = useApprovalRequestQuery({ ...api, requestId });
  const actions = useApprovalRequestActions({ ...api, requestId });

  const state: ApprovalRequestCardState = query.data
    ? { status: "ready", request: query.data }
    : isApprovalRequestNotFound(query.error)
      ? { status: "not-found" }
      : query.isError
        ? { status: "error", onRetry: () => void query.refetch() }
        : { status: "loading" };

  return <ApprovalRequestCardView state={state} actions={cardActions(actions)} />;
}

/** Card for the review queue: the list already carries the request's current state. */
export function ListedApprovalRequestCard({ request }: { request: ApprovalRequestView }) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const actions = useApprovalRequestActions({
    apiBaseUrl,
    authScope: APPROVAL_AUTH_SCOPE,
    client,
    requestId: request.id
  });

  return (
    <ApprovalRequestCardView state={{ status: "ready", request }} actions={cardActions(actions)} />
  );
}

function cardActions(
  actions: ReturnType<typeof useApprovalRequestActions>
): ApprovalRequestCardActions {
  return {
    pending: actions.pending,
    failure: actions.failure,
    onDecide: actions.decide,
    onWithdraw: actions.withdraw,
    onRevert: actions.revert
  };
}

export function ApprovalRequestCardView({
  state,
  actions
}: {
  state: ApprovalRequestCardState;
  actions: ApprovalRequestCardActions;
}) {
  const { locale, t } = useTranslation();

  if (state.status !== "ready") {
    return (
      <Card
        className="flex min-w-0 flex-wrap items-center gap-2 p-4 text-sm text-muted-foreground"
        data-testid="approval-request-card"
        role="status"
      >
        {state.status === "loading" ? (
          <>
            <Spinner size="sm" />
            <span>{t("approvalLoading")}</span>
          </>
        ) : state.status === "not-found" ? (
          <span>{t("approvalNotFound")}</span>
        ) : (
          <>
            <CircleAlert size={15} className="shrink-0 text-destructive" aria-hidden="true" />
            <span>{t("approvalLoadFailed")}</span>
            <Button type="button" size="sm" variant="outline" onClick={state.onRetry}>
              {t("tryAgain")}
            </Button>
          </>
        )}
      </Card>
    );
  }

  const { request } = state;
  const status = approvalStatusPresentation(request.status);
  const checks = visibleApprovalChecks(request.checks);
  const decision = request.decision;
  const reversion = readApprovalReversion(request);
  const canRevert = Boolean(actions.onRevert) && canRevertApprovalRequest(request);
  const hasActions = request.canDecide || request.canWithdraw || canRevert;

  return (
    <Card
      className="grid min-w-0 gap-3 p-4 text-sm"
      data-testid="approval-request-card"
      aria-label={t("approvalFallbackTitle")}
      role="group"
    >
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
          <p className="min-w-0 flex-1 basis-56 font-medium text-foreground">
            {request.summary.trim() || t("approvalFallbackTitle")}
          </p>
          <Badge
            variant={STATUS_BADGE_VARIANT[status.tone]}
            className={STATUS_BADGE_CLASS[status.tone]}
          >
            {t(status.labelKey)}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("approvalRequestedBy", {
            name: request.requestedBy.displayLabel,
            date: formatApprovalDate(request.createdAt, locale)
          })}
        </p>
      </div>

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
                {check.message}
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

type ActionStep = "idle" | "request_changes" | "reject" | "revert";

function ApprovalRequestActions({
  request,
  actions,
  canRevert
}: {
  request: ApprovalRequestView;
  actions: ApprovalRequestCardActions;
  canRevert: boolean;
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

  if (step === "request_changes" || step === "reject") {
    const requiresComment = step === "request_changes";
    return (
      <form className="grid min-w-0 gap-2 border-t pt-3" onSubmit={submitComment}>
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
      <div className="grid min-w-0 gap-2 border-t pt-3">
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
    <div className="grid min-w-0 gap-2 border-t pt-3">
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
        {request.canWithdraw ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn("text-muted-foreground", request.canDecide && "ml-auto")}
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

function formatApprovalDate(value: string, locale: LocaleCode): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
