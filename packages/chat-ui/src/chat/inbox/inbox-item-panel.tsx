import { CircleHelp, MessageSquare } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import {
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  InlineError,
  SkeletonPage,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@work-shape/catalyst-ui";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import {
  APPROVAL_AUTH_SCOPE,
  approvalRequestState,
  useApprovalRequestQuery,
  type ApprovalRequestState
} from "../../shared/api/approval-request-api";
import {
  approvalActionFailureText,
  formatApprovalDate,
  offersApprovalWithdraw,
  visibleApprovalChecks
} from "../approvals/approval-request-model";
import { refusalAskingInstanceAdmin } from "../../admin/settings/ask-instance-admin";
import { useApprovalRevisionHost } from "../approvals/approval-revision-host";
import { ApprovalRefreshButton, ApprovalStatusBadge } from "../approvals/approval-status-badge";
import { isInboxConfirmation } from "../approvals/operation-call-preview";
import { useAttachmentContentContext } from "../files/attachment-content";
import { useTranslation } from "../../shared/i18n";
import { RouteLink } from "../../studio/route-link";
import { INBOX_REFETCH_MS } from "./inbox-api";
import { useInboxItemActions, type InboxItemActions } from "./inbox-item-actions";
import {
  inboxDecisionsOf,
  useInboxItemKindLookup,
  type InboxDecision,
  type InboxDecisionEntries,
  type InboxItemKind
} from "./inbox-item-kinds";
import { inboxItemPlaces } from "./inbox-places";
import { personName } from "../../shared/person-name";

/**
 * One item of the Inbox in the surface slot. It follows the item's live state, so it shows the
 * same beside the list and beside the conversation the item came from, and a decision made here
 * sets off exactly what it would anywhere else.
 */
export function InboxItemPanel({ itemId }: { itemId: string }) {
  // Another item starts clean: no comment and no refusal carried over from the one before.
  return <InboxItemLive key={itemId} itemId={itemId} />;
}

function InboxItemLive({ itemId }: { itemId: string }) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const query = useApprovalRequestQuery({
    apiBaseUrl,
    authScope: APPROVAL_AUTH_SCOPE,
    client,
    requestId: itemId,
    // The open item is what a person decides on, so it keeps up like the lists do.
    refetchIntervalMs: INBOX_REFETCH_MS
  });
  const actions = useInboxItemActions(itemId, query.data);

  return <InboxItemView state={approvalRequestState(query)} actions={actions} />;
}

/**
 * The frame of an item, the same for every kind. Head: what it is, its state, who asked. Then
 * what the checks found, the kind's body, and the foot with what this person can do.
 */
export function InboxItemView({
  state,
  actions
}: {
  state: ApprovalRequestState;
  actions: InboxItemActions;
}) {
  const { locale, t } = useTranslation();
  const kindOf = useInboxItemKindLookup();
  const host = useApprovalRevisionHost();
  // Held above the foot, which starts over when the item changes state: a comment written for
  // a decision that was refused is still there to copy.
  const [comment, setComment] = useState("");

  if (state.status === "loading") {
    return <SkeletonPage sections={1} />;
  }
  if (state.status === "not-found") {
    // The person may not see it: they are told whom to ask, never sent to a page.
    return (
      <EmptyState layout="inline" data-testid="inbox-item-not-found">
        {refusalAskingInstanceAdmin(t("approvalNotFound"), t, host?.instanceAdminName)}
      </EmptyState>
    );
  }
  if (state.status === "error") {
    return (
      <InlineError>
        {t("approvalLoadFailed")}{" "}
        <Button variant="link" size="sm" className="px-0" onClick={state.onRetry}>
          {t("tryAgain")}
        </Button>
      </InlineError>
    );
  }

  const item = state.request;
  const kind = kindOf(item.kind);
  const KindIcon = kind?.itemIcon?.(item) ?? kind?.icon ?? CircleHelp;
  const agentName = item.origin?.agentName;
  const agentLabel = agentName ? (host?.agentDisplayName(agentName) ?? agentName) : undefined;
  const checks = visibleApprovalChecks(item.checks);
  const date = formatApprovalDate(item.createdAt, locale);
  // A kind that says who asked on the reader's behalf says it in its own words.
  const asked = kind?.asked?.(item, t, agentLabel);

  return (
    <article className="grid min-w-0 gap-4 text-body" data-testid="inbox-item">
      <header className="grid min-w-0 gap-1.5">
        <div className="flex min-w-0 items-start gap-2">
          <KindIcon className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h3 className="min-w-0 flex-1 text-heading break-words">
            {kind?.heading?.(item, t) ?? (item.summary.trim() || t("approvalFallbackTitle"))}
          </h3>
          <ApprovalStatusBadge
            status={item.status}
            applyResult={item.applyResult}
            confirmation={isInboxConfirmation(item)}
            notice={kind?.handled === true}
          />
          {state.onRefresh ? <ApprovalRefreshButton onRefresh={state.onRefresh} /> : null}
        </div>
        <p className="text-caption text-muted-foreground" data-testid="inbox-item-asked">
          {asked ? (
            t("inbox.askedAt", { asked, date })
          ) : (
            <>
              {t("approvalRequestedBy", {
                name: personName(item.requestedBy.displayLabel, t),
                date
              })}
              {agentLabel ? ` · ${t("inbox.via", { agent: agentLabel })}` : null}
            </>
          )}
        </p>
      </header>

      {checks.map((check) => (
        <Banner
          key={check.id}
          tone={check.status === "blocked" ? "danger" : "warning"}
          // A check is a finding to read, not an event to announce over the page.
          role="note"
          title={t(check.status === "blocked" ? "approvalCheckBlocked" : "approvalCheckWarned")}
        >
          {check.message || t("approvalCheckUnevaluated")}
        </Banner>
      ))}

      {kind ? (
        <kind.Body item={item} />
      ) : (
        <EmptyState layout="inline" data-testid="inbox-item-unknown-kind">
          {t("inbox.unknownKind")}
        </EmptyState>
      )}

      <InboxItemOutcome item={item} />

      <InboxItemFoot
        // A refetched item in another state starts with a clean foot.
        key={item.status}
        item={item}
        kind={kind}
        actions={actions}
        comment={comment}
        onCommentChange={setComment}
      />
    </article>
  );
}

/** Once decided: who decided, when, their comment, and who undid it. */
function InboxItemOutcome({ item }: { item: ApprovalRequestView }) {
  const { locale, t } = useTranslation();
  const { decision, reversion } = item;
  if (!decision && !reversion) {
    return null;
  }
  return (
    <div className="grid min-w-0 gap-1.5 border-t pt-3" data-testid="inbox-item-outcome">
      {decision ? (
        <p className="text-caption text-muted-foreground">
          {t("approvalDecidedBy", {
            name: personName(decision.decidedByLabel, t),
            date: formatApprovalDate(decision.decidedAt, locale)
          })}
        </p>
      ) : null}
      {decision?.comment ? (
        <blockquote className="min-w-0 border-l-2 pl-3 whitespace-pre-wrap">
          {decision.comment}
        </blockquote>
      ) : null}
      {reversion ? (
        <p className="text-caption text-muted-foreground">
          {t("approvalRevertedBy", {
            name: personName(reversion.revertedByLabel, t),
            date: formatApprovalDate(reversion.revertedAt, locale)
          })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What this person can do to the item. The server says who may: `canDecide`, `canWithdraw` and
 * `canRevert` on the item. The frame holds no rule about roles or kinds. A kind without an
 * entry gets no decision: the frame does not know what deciding it would mean.
 */
function InboxItemFoot({
  item,
  kind,
  actions,
  comment,
  onCommentChange
}: {
  item: ApprovalRequestView;
  kind: InboxItemKind | undefined;
  actions: InboxItemActions;
  comment: string;
  onCommentChange(comment: string): void;
}) {
  const { t } = useTranslation();
  const host = useApprovalRevisionHost();
  const openConversationId = useAttachmentContentContext()?.selectedConversationId;
  const [confirmingRevert, setConfirmingRevert] = useState(false);
  const canDecide = item.canDecide && kind !== undefined;
  const canWithdraw = offersApprovalWithdraw(item);
  const canRevert = item.canRevert && kind !== undefined;
  // The origin conversation is private to the person who asked, so only they are led there,
  // and not from the conversation itself.
  const originConversationId =
    host && item.requestedBy.id === host.currentUserId ? item.origin?.conversationId : undefined;
  const opensConversation =
    originConversationId !== undefined && originConversationId !== openConversationId;
  // Where what is asked can be read in full, for a reader who may open it there.
  const place = inboxItemPlaces(item).flatMap(({ target, label }) => {
    const route = host?.places?.route(target);
    return route ? [{ route, label }] : [];
  })[0];
  const leads = opensConversation || place !== undefined;

  if (!canDecide && !canWithdraw && !canRevert && !leads && !actions.failure) {
    return null;
  }

  const KindFoot = kind?.Foot;
  const ApproveHold = kind?.ApproveHold;
  return (
    // Stays at the surface's lower edge while a long proposal scrolls behind it; the negative
    // margins span the surface's own padding.
    <footer
      className="sticky bottom-0 -mx-4 -mb-4 grid min-w-0 gap-3 border-t bg-background px-4 py-3"
      data-testid="inbox-item-foot"
    >
      {actions.failure ? (
        <Banner tone="danger">{approvalActionFailureText(actions.failure, item, t)}</Banner>
      ) : null}
      {canDecide ? (
        KindFoot ? (
          <KindFoot item={item} actions={actions} />
        ) : ApproveHold ? (
          <ApproveHold item={item}>
            {(held) => (
              <InboxDecisionForm
                decisions={inboxDecisionsOf(kind, item)}
                actions={actions}
                comment={comment}
                onCommentChange={onCommentChange}
                approveHeld={held}
              />
            )}
          </ApproveHold>
        ) : (
          <InboxDecisionForm
            decisions={inboxDecisionsOf(kind, item)}
            actions={actions}
            comment={comment}
            onCommentChange={onCommentChange}
          />
        )
      ) : actions.failure === "already_decided" && comment.trim() ? (
        // Nothing is left to decide, but what was written is not thrown away.
        <Field label={t("inbox.comment")}>
          <Textarea rows={2} value={comment} readOnly data-testid="inbox-item-kept-comment" />
        </Field>
      ) : null}
      {canWithdraw || canRevert || leads ? (
        <div className="flex flex-wrap items-center gap-2">
          {canWithdraw ? (
            <Button
              size="sm"
              variant="outline"
              disabled={actions.pending}
              onClick={actions.withdraw}
            >
              {t("approvalWithdraw")}
            </Button>
          ) : null}
          {canRevert ? (
            <Button
              size="sm"
              variant="outline"
              disabled={actions.pending}
              onClick={() => setConfirmingRevert(true)}
            >
              {t("approvalRevert")}
            </Button>
          ) : null}
          {place ? (
            <RouteLink
              route={place.route}
              variant="link"
              className="ml-auto px-0"
              data-testid="inbox-item-place"
              onOpen={(route) => host?.openRoute?.(route)}
            >
              {t(place.label)}
            </RouteLink>
          ) : null}
          {opensConversation ? (
            <Button
              size="sm"
              variant="ghost"
              className={place ? undefined : "ml-auto"}
              onClick={() => host?.openConversation(originConversationId)}
            >
              <MessageSquare aria-hidden="true" />
              {t("inbox.openConversation")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {canRevert ? (
        <ConfirmDialog
          open={confirmingRevert}
          title={t("inbox.revertTitle")}
          confirmLabel={t("approvalRevert")}
          onConfirm={() => {
            setConfirmingRevert(false);
            actions.revert();
          }}
          onClose={() => setConfirmingRevert(false)}
        >
          {t("approvalRevertConfirm")}
        </ConfirmDialog>
      ) : null}
    </footer>
  );
}

/**
 * The comment and the decisions. The comment is optional for accepting and rejecting; a request
 * for changes without one would tell the agent nothing, so it asks for one.
 */
function InboxDecisionForm({
  decisions,
  actions,
  comment,
  onCommentChange,
  approveHeld = false
}: {
  decisions: InboxDecisionEntries;
  actions: InboxItemActions;
  comment: string;
  onCommentChange(comment: string): void;
  /** The kind holds Approve until the item has read what the approver must see. */
  approveHeld?: boolean;
}) {
  const { t } = useTranslation();
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const [commentMissing, setCommentMissing] = useState(false);

  function decide(decision: InboxDecision, alwaysAllow = false) {
    const trimmed = comment.trim();
    if (decision === "request_changes") {
      if (!trimmed) {
        setCommentMissing(true);
        commentRef.current?.focus();
        return;
      }
      actions.decide({ decision, comment: trimmed });
      return;
    }
    if (decision === "approve") {
      actions.decide({
        decision,
        ...(trimmed ? { comment: trimmed } : {}),
        ...(alwaysAllow ? { alwaysAllow: true as const } : {})
      });
      return;
    }
    actions.decide({ decision, ...(trimmed ? { comment: trimmed } : {}) });
  }
  // Accepting stands apart at the row's end: the first of its buttons takes the space before.
  const firstApproval = decisions.findIndex((entry) => entry.decision === "approve");
  const offersAlwaysAllow = decisions.some((entry) => entry.alwaysAllow);

  const button = (entry: (typeof decisions)[number], index: number): ReactNode => {
    const approves = entry.decision === "approve";
    const key = entry.alwaysAllow ? "always_allow" : entry.decision;
    const decisionButton = (
      <Button
        key={key}
        size="sm"
        variant={approves && !entry.alwaysAllow ? "primary" : "outline"}
        // Accepting stands apart at the row's end, so it is never hit in passing.
        className={index === firstApproval ? "ml-auto" : undefined}
        disabled={actions.pending || (approves && approveHeld)}
        data-decision={entry.decision}
        {...(entry.alwaysAllow ? { "data-always-allow": "" } : {})}
        onClick={() => decide(entry.decision, entry.alwaysAllow === true)}
      >
        {t(entry.label)}
      </Button>
    );
    return entry.decision === "request_changes" && actions.revisionHintKey ? (
      <Tooltip key={entry.decision}>
        <TooltipTrigger asChild>{decisionButton}</TooltipTrigger>
        <TooltipContent>{t(actions.revisionHintKey)}</TooltipContent>
      </Tooltip>
    ) : (
      decisionButton
    );
  };

  return (
    <div className="grid min-w-0 gap-3">
      <Field
        label={t("inbox.comment")}
        optional
        error={commentMissing ? t("inbox.commentRequired") : undefined}
      >
        <Textarea
          ref={commentRef}
          rows={2}
          value={comment}
          disabled={actions.pending}
          onChange={(event) => {
            onCommentChange(event.target.value);
            setCommentMissing(false);
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">{decisions.map(button)}</div>
      {offersAlwaysAllow ? (
        <p className="text-caption text-muted-foreground">{t("confirm.alwaysAllowHint")}</p>
      ) : null}
    </div>
  );
}
