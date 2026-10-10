import { List as ListIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EmptyState,
  Page,
  PageHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from "@vivd-catalyst/ui";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import {
  APPROVAL_AUTH_SCOPE,
  useApprovalPendingCountQuery,
  useApprovalRequestQuery
} from "../approvals/approval-request-api";
import { useApprovalRevisionHost } from "../approvals/approval-revision-host";
import { useTranslation } from "../i18n";
import { SurfaceSlot } from "../surface/surface-slot";
import { useInboxListQuery } from "./inbox-api";
import { useInboxItemKindLookup } from "./inbox-item-kinds";
import { inboxItemSurface } from "./inbox-item-surface";
import { InboxList, type InboxListState } from "./inbox-list";
import {
  inboxTabCount,
  inboxTabLabelKeys,
  inboxTabOfItem,
  inboxTabs,
  orderInboxItems,
  type InboxCounts,
  type InboxTab
} from "./inbox-model";

const INBOX_TABS: readonly InboxTab[] = ["to_decide", "mine", "decided"];

function isInboxTab(value: string): value is InboxTab {
  return INBOX_TABS.some((tab) => tab === value);
}

/**
 * The Inbox: what waits for this person's decision, what they asked for, and what was decided.
 * The lists stand on the main side and the open item in the surface slot, so the address of an
 * item shows the same on a wide and on a narrow window.
 */
export function InboxArea({
  itemId,
  onOpenItem,
  onCloseItem,
  onBesideWidthChange,
  onCoveringChange
}: {
  /** The item of the address, when it names one. */
  itemId?: string;
  onOpenItem(itemId: string): void;
  onCloseItem(): void;
  /** Told how much of the main area the item takes beside the lists; 0 otherwise. */
  onBesideWidthChange(width: number): void;
  /** Told whether the item covers the lists. */
  onCoveringChange(covering: boolean): void;
}) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const api = { apiBaseUrl, authScope: APPROVAL_AUTH_SCOPE, client };
  const counts = useApprovalPendingCountQuery({ ...api, enabled: true }).data;
  const itemQuery = useApprovalRequestQuery({
    ...api,
    requestId: itemId ?? "",
    enabled: itemId !== undefined
  });
  const host = useApprovalRevisionHost();
  const canReview = counts?.canReview ?? false;
  const tabs = inboxTabs(canReview);
  const [chosenTab, setChosenTab] = useState<InboxTab | undefined>();
  const tab: InboxTab =
    chosenTab !== undefined && tabs.includes(chosenTab)
      ? chosenTab
      : canReview
        ? "to_decide"
        : "mine";
  const listQuery = useInboxListQuery({ ...api, tab, enabled: counts !== undefined });
  const listItems = listQuery.data;
  const items = useMemo(() => (listItems ? orderInboxItems(tab, listItems) : []), [listItems, tab]);
  const [covering, setCovering] = useState(false);
  // The ages are counted from when the list last arrived.
  const now = useMemo(() => new Date(), [listItems]);

  // An item opened by its address brings up the list that holds it, once. Later the tabs are
  // the reader's: a decision moves the item to another list, not the reader.
  const placedItemRef = useRef<string | undefined>(undefined);
  const item = itemId !== undefined && itemQuery.data?.id === itemId ? itemQuery.data : undefined;
  const userId = host?.currentUserId;
  useEffect(() => {
    if (!item || counts === undefined || placedItemRef.current === item.id) {
      return;
    }
    placedItemRef.current = item.id;
    setChosenTab(inboxTabOfItem(item, { userId, canReview }));
  }, [canReview, counts, item, userId]);

  // The header's place and the lists' tab order follow the slot only while the Inbox is open.
  useEffect(
    () => () => {
      onBesideWidthChange(0);
      onCoveringChange(false);
    },
    [onBesideWidthChange, onCoveringChange]
  );

  const retry = () => {
    listQuery.refetch().catch(() => undefined);
  };
  const state: InboxListState =
    counts === undefined || listQuery.isPending
      ? listQuery.isError
        ? { status: "error", onRetry: retry }
        : { status: "loading" }
      : listQuery.isError && !listItems
        ? { status: "error", onRetry: retry }
        : { status: "ready", items };

  return (
    <InboxAreaView
      tabs={tabs}
      tab={tab}
      counts={counts}
      state={state}
      itemId={itemId}
      item={item}
      now={now}
      covered={covering && itemId !== undefined}
      agentDisplayName={host?.agentDisplayName}
      onTabChange={setChosenTab}
      onOpenItem={(nextItemId) => {
        // The reader chose it from a list, so the list stays.
        placedItemRef.current = nextItemId;
        onOpenItem(nextItemId);
      }}
      onCloseItem={onCloseItem}
      onBesideWidthChange={onBesideWidthChange}
      onCoveringChange={(next) => {
        setCovering(next);
        onCoveringChange(next);
      }}
    />
  );
}

/** The Inbox as it stands for given lists: the page, the tabs, the list and the slot. */
export function InboxAreaView({
  tabs,
  tab,
  counts,
  state,
  itemId,
  item,
  now,
  covered = false,
  agentDisplayName,
  onTabChange,
  onOpenItem,
  onCloseItem,
  onBesideWidthChange,
  onCoveringChange
}: {
  tabs: readonly InboxTab[];
  tab: InboxTab;
  counts: InboxCounts | undefined;
  state: InboxListState;
  itemId?: string;
  /** The open item once it has arrived: it names the surface. */
  item?: Parameters<typeof inboxItemSurface>[1];
  now: Date;
  /** The open item covers the lists, so they leave the tab order. */
  covered?: boolean;
  agentDisplayName?(agentName: string): string | undefined;
  onTabChange(tab: InboxTab): void;
  onOpenItem(itemId: string): void;
  onCloseItem(): void;
  onBesideWidthChange?(width: number): void;
  onCoveringChange?(covering: boolean): void;
}) {
  const { t } = useTranslation();
  const kindOf = useInboxItemKindLookup();
  const titleRef = useRef<HTMLDivElement>(null);
  const surface = itemId === undefined ? undefined : inboxItemSurface(itemId, item, kindOf, t);
  const list = (
    <InboxList
      tab={tab}
      state={state}
      selectedItemId={itemId}
      now={now}
      agentDisplayName={agentDisplayName}
      onOpenItem={onOpenItem}
    />
  );
  const hasRows = state.status === "ready" && state.items.length > 0;

  // The area's title takes the focus when the area opens, as on every full page.
  useEffect(() => {
    const title = titleRef.current?.querySelector("h1");
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }, []);

  return (
    <section
      aria-label={t("nav.inbox")}
      className="relative flex h-full min-h-0 min-w-0 bg-background"
      data-testid="inbox-area"
    >
      <div
        className="grid h-full min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)] pt-(--layout-header)"
        inert={covered}
      >
        <div
          ref={titleRef}
          className="chat-scrollbar min-h-0 min-w-0 overflow-x-hidden overflow-y-auto"
        >
          <Page>
            <PageHeader title={t("nav.inbox")} />
            {tabs.length > 1 ? (
              <Tabs
                value={tab}
                onValueChange={(value) => {
                  if (isInboxTab(value)) {
                    onTabChange(value);
                  }
                }}
              >
                <TabsList label={t("inbox.tabs")}>
                  {tabs.map((entry) => (
                    <TabsTrigger
                      key={entry}
                      value={entry}
                      count={inboxTabCount(entry, counts) || undefined}
                    >
                      {t(inboxTabLabelKeys[entry])}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <TabsContent value={tab} className="pt-3">
                  {list}
                </TabsContent>
              </Tabs>
            ) : (
              list
            )}
          </Page>
        </div>
      </div>
      <SurfaceSlot
        source={{ surface, close: onCloseItem }}
        under={{ label: t("inbox.showList"), icon: <ListIcon aria-hidden="true" /> }}
        idle={
          hasRows
            ? {
                kind: "inbox_item",
                content: <EmptyState>{t("inbox.emptyItem")}</EmptyState>
              }
            : undefined
        }
        onBesideWidthChange={onBesideWidthChange}
        onCoveringChange={onCoveringChange}
      />
    </section>
  );
}
