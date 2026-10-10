import { CircleHelp } from "lucide-react";
import type { ApprovalRequestView } from "@vivd-catalyst/api-client";
import {
  Avatar,
  Button,
  EmptyState,
  InlineError,
  List,
  ListRow,
  SkeletonList
} from "@vivd-catalyst/ui";
import { ApprovalStatusBadge } from "../approvals/approval-status-badge";
import { useTranslation } from "../i18n";
import { useInboxItemKindLookup } from "./inbox-item-kinds";
import { formatInboxAge, inboxTabEmptyKeys, type InboxTab } from "./inbox-model";

/** How a list stands on the page. */
export type InboxListState =
  | { status: "loading" }
  | { status: "error"; onRetry(): void }
  | { status: "ready"; items: readonly ApprovalRequestView[] };

/**
 * One list of the Inbox. A row says what is asked, who asked through which agent, how it
 * stands and how long ago. It opens the item; nothing is decided from the row.
 */
export function InboxList({
  tab,
  state,
  selectedItemId,
  now,
  agentDisplayName,
  onOpenItem
}: {
  tab: InboxTab;
  state: InboxListState;
  selectedItemId?: string;
  /** The moment the ages are counted from. */
  now: Date;
  agentDisplayName?(agentName: string): string | undefined;
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
    return <EmptyState data-testid="inbox-empty">{t(inboxTabEmptyKeys[tab])}</EmptyState>;
  }

  return (
    <List data-testid="inbox-list" data-tab={tab}>
      {state.items.map((item) => {
        const kind = kindOf(item.kind);
        const KindIcon = kind?.icon ?? CircleHelp;
        const agentName = item.origin?.agentName;
        const requester = item.requestedBy.displayLabel;
        return (
          <ListRow
            key={item.id}
            data-testid="inbox-row"
            data-item-id={item.id}
            leading={<KindIcon className="size-4 text-muted-foreground" aria-hidden="true" />}
            title={item.summary.trim() || t(kind?.label ?? "inbox.kindUnknown")}
            // The decided list mixes outcomes, and a person's own list mixes all states. In
            // To decide every row is pending, so the state would say nothing.
            chips={
              tab === "to_decide" ? undefined : (
                <ApprovalStatusBadge status={item.status} size="sm" />
              )
            }
            descriptionLeading={<Avatar kind="person" name={requester} size="xs" />}
            description={
              agentName
                ? `${requester} ${t("inbox.via", { agent: agentDisplayName?.(agentName) ?? agentName })}`
                : requester
            }
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
