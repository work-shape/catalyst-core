import { CircleHelp } from "lucide-react";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import {
  Avatar,
  Button,
  EmptyState,
  InlineError,
  List,
  ListRow,
  ScopeChip,
  SkeletonList
} from "@work-shape/catalyst-ui";
import type { InboxWorkspace } from "../approvals/approval-revision-host";
import { ApprovalStatusBadge } from "../approvals/approval-status-badge";
import { isInboxConfirmation } from "../approvals/operation-call-preview";
import { useTranslation } from "../../shared/i18n";
import { useInboxItemKindLookup } from "./inbox-item-kinds";
import { formatMomentShort } from "../../shared/locale-format";
import { formatInboxAge, inboxRowsAlike, inboxTabEmptyKeys, type InboxTab } from "./inbox-model";

/** How a list stands on the page. */
export type InboxListState =
  | { status: "loading" }
  | { status: "error"; onRetry(): void }
  | { status: "ready"; items: readonly ApprovalRequestView[] };

/**
 * One list of the Inbox. A row says what is asked, who asked through which agent and, where
 * the kind says so, where it lands, how it stands and how long ago. It opens the item; nothing is decided from the row.
 */
export function InboxList({
  tab,
  state,
  selectedItemId,
  now,
  agentDisplayName,
  workspaceOf,
  filtered = false,
  onOpenItem
}: {
  tab: InboxTab;
  state: InboxListState;
  selectedItemId?: string;
  /** The moment the ages are counted from. */
  now: Date;
  agentDisplayName?(agentName: string): string | undefined;
  /** The workspace an item comes from, where the reader belongs to it. */
  workspaceOf?(item: ApprovalRequestView): InboxWorkspace | undefined;
  /** The filter row narrows the list: an empty list says so, not that nothing waits. */
  filtered?: boolean;
  onOpenItem(itemId: string): void;
}) {
  const { locale, t } = useTranslation();
  const kindOf = useInboxItemKindLookup();

  if (state.status === "loading") {
    return <SkeletonList rows={3} />;
  }
  if (state.status === "error") {
    return (
      <InlineError>
        {t("inbox.loadFailed")}{" "}
        <Button variant="link" size="sm" className="px-0" onClick={state.onRetry}>
          {t("tryAgain")}
        </Button>
      </InlineError>
    );
  }
  if (state.items.length === 0) {
    return (
      <EmptyState data-testid="inbox-empty">
        {t(filtered ? "inbox.emptyFiltered" : inboxTabEmptyKeys[tab])}
      </EmptyState>
    );
  }

  const titleOf = (item: ApprovalRequestView) =>
    kindOf(item.kind)?.heading?.(item, t) ??
    (item.summary.trim() || t(kindOf(item.kind)?.label ?? "inbox.kindUnknown"));
  const alike = inboxRowsAlike(
    state.items.map((item) => ({
      id: item.id,
      title: titleOf(item),
      requesterId: item.requestedBy.id
    }))
  );

  return (
    <List data-testid="inbox-list" data-tab={tab}>
      {state.items.map((item) => {
        const kind = kindOf(item.kind);
        const KindIcon = kind?.itemIcon?.(item) ?? kind?.icon ?? CircleHelp;
        const agentName = item.origin?.agentName;
        const requester = item.requestedBy.displayLabel;
        const agentLabel = agentName ? (agentDisplayName?.(agentName) ?? agentName) : undefined;
        const asked =
          kind?.asked?.(item, t, agentLabel) ??
          (agentLabel ? `${requester} ${t("inbox.via", { agent: agentLabel })}` : requester);
        const detail = kind?.rowDetail?.(item, t);
        // Two requests alike in title and requester are told apart by when each was asked.
        const askedAt = alike.has(item.id) ? formatMomentShort(item.createdAt, locale) : undefined;
        const workspace = workspaceOf?.(item);
        return (
          <ListRow
            key={item.id}
            data-testid="inbox-row"
            data-item-id={item.id}
            leading={<KindIcon className="size-4 text-muted-foreground" aria-hidden="true" />}
            title={titleOf(item)}
            chips={
              <>
                {workspace ? (
                  <ScopeChip
                    scope="workspace"
                    size="sm"
                    name={workspace.name}
                    emoji={workspace.emoji}
                  />
                ) : null}
                {
                  // The decided list mixes outcomes, and a person's own list mixes all states.
                  // In To decide every row is pending, so the state would say nothing.
                  tab === "to_decide" ? null : (
                    <ApprovalStatusBadge
                      status={item.status}
                      applyResult={item.applyResult}
                      confirmation={isInboxConfirmation(item)}
                      notice={kind?.handled === true}
                      size="sm"
                    />
                  )
                }
              </>
            }
            descriptionLeading={<Avatar kind="person" name={requester} size="xs" />}
            description={[asked, detail, askedAt].filter(Boolean).join(" · ")}
            time={
              <time dateTime={tab === "decided" ? item.updatedAt : item.createdAt}>
                {formatInboxAge(tab === "decided" ? item.updatedAt : item.createdAt, locale, now)}
              </time>
            }
            selected={item.id === selectedItemId}
            onClick={() => onOpenItem(item.id)}
          />
        );
      })}
    </List>
  );
}
