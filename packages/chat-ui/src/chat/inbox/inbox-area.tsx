import { useQueryClient } from "@tanstack/react-query";
import { List as ListIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import {
  EmptyState,
  FilterBar,
  Page,
  PageHeader,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from "@work-shape/catalyst-ui";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import {
  APPROVAL_AUTH_SCOPE,
  approvalRequestQueryKeys,
  useApprovalPendingCountQuery,
  useApprovalRequestQuery
} from "../../shared/api/approval-request-api";
import { useApprovalRevisionHost, type InboxWorkspace } from "../approvals/approval-revision-host";
import { useTranslation } from "../../shared/i18n";
import { SurfaceSlot } from "../surface/surface-slot";
import { useInboxListQuery } from "./inbox-api";
import { useInboxItemKindLookup } from "./inbox-item-kinds";
import { inboxItemSurface } from "./inbox-item-surface";
import { InboxList, type InboxListState } from "./inbox-list";
import { inboxItemWorkspaceId } from "./inbox-places";
import {
  filterInboxItems,
  inboxFilterActive,
  inboxFilterOptions,
  inboxListOutdatesItem,
  inboxTabCount,
  inboxTabLabelKeys,
  inboxTabOfItem,
  inboxTabs,
  NO_INBOX_FILTER,
  orderInboxItems,
  type InboxCounts,
  type InboxFilter,
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
  const { t } = useTranslation();
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
  // One filter for every list: switching tabs keeps what the reader narrowed to.
  const [filter, setFilter] = useState<InboxFilter>(NO_INBOX_FILTER);
  const places = host?.places;
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

  // A list that arrives with other news of the open item has the item asked for again.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (item && listItems && inboxListOutdatesItem(tab, listItems, item)) {
      queryClient
        .invalidateQueries({
          queryKey: approvalRequestQueryKeys.request(apiBaseUrl, APPROVAL_AUTH_SCOPE, item.id)
        })
        .catch(() => undefined);
    }
  }, [apiBaseUrl, item, listItems, queryClient, tab]);

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
      {...(places ? { workspace: (workspaceId) => places.workspace(workspaceId, t) } : {})}
      filter={filter}
      onFilterChange={setFilter}
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
  workspace,
  filter,
  onFilterChange,
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
  /** A workspace of the reader's by its id. */
  workspace?(workspaceId: string): InboxWorkspace | undefined;
  filter: InboxFilter;
  onFilterChange(filter: InboxFilter): void;
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
  // Only the reader's own workspaces are named and filtered by; another stays unnamed.
  const workspaceIdOf = (entry: ApprovalRequestView) => {
    const workspaceId = inboxItemWorkspaceId(entry);
    return workspaceId !== undefined && workspace?.(workspaceId) ? workspaceId : undefined;
  };
  const agentOf = (entry: ApprovalRequestView) => kindOf(entry.kind)?.agentOf?.(entry);
  const filtered = inboxFilterActive(filter);
  const shown: InboxListState =
    state.status === "ready"
      ? { status: "ready", items: filterInboxItems(state.items, filter, workspaceIdOf, agentOf) }
      : state;
  const filters =
    state.status === "ready" ? (
      <InboxFilters
        options={inboxFilterOptions(state.items, filter, workspaceIdOf, agentOf)}
        filter={filter}
        workspace={workspace}
        onChange={onFilterChange}
      />
    ) : null;
  const list = (
    <div className="grid min-w-0 gap-3">
      {filters}
      <InboxList
        tab={tab}
        state={shown}
        selectedItemId={itemId}
        now={now}
        agentDisplayName={agentDisplayName}
        workspaceOf={(entry) => {
          const workspaceId = workspaceIdOf(entry);
          return workspaceId === undefined ? undefined : workspace?.(workspaceId);
        }}
        filtered={filtered}
        onOpenItem={onOpenItem}
      />
    </div>
  );
  const hasRows = shown.status === "ready" && shown.items.length > 0;

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
      <div className="grid h-full min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)]" inert={covered}>
        <div
          ref={titleRef}
          // Below `md` the button that opens the sidebar floats over the page, which starts below it.
          className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [container-type:size] max-md:[--layout-page-inset:var(--layout-header)]"
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
                  {tabs.map((entry) => {
                    const count = inboxTabCount(entry, counts);
                    return (
                      <TabsTrigger
                        key={entry}
                        value={entry}
                        count={count?.count}
                        countTone={count?.tone}
                      >
                        {t(inboxTabLabelKeys[entry])}
                      </TabsTrigger>
                    );
                  })}
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
        // The reading side keeps its place whether the list has rows or not, so the title and
        // the tabs stand still from one tab to the next. It invites to choose only where there
        // is something to choose.
        idle={{
          kind: "inbox_item",
          content: hasRows ? <EmptyState>{t("inbox.emptyItem")}</EmptyState> : null
        }}
        onBesideWidthChange={onBesideWidthChange}
        onCoveringChange={onCoveringChange}
      />
    </section>
  );
}

/**
 * The filter row above a list: by kind and by workspace. The kind control shows where its list
 * has two kinds or one is chosen; the workspace control wherever a known workspace is listed.
 */
function InboxFilters({
  options,
  filter,
  workspace,
  onChange
}: {
  options: {
    kinds: readonly string[];
    workspaceIds: readonly string[];
    agents: readonly { name: string; label: string }[];
  };
  filter: InboxFilter;
  workspace?(workspaceId: string): InboxWorkspace | undefined;
  onChange(filter: InboxFilter): void;
}) {
  const { t } = useTranslation();
  const kindOf = useInboxItemKindLookup();
  const offersKinds = options.kinds.length > 1 || filter.kind !== undefined;
  // One workspace is still a choice: it narrows away the items of the instance.
  const offersWorkspaces = options.workspaceIds.length > 0;
  // Feedback is read agent by agent: the control shows wherever an item names an agent.
  const offersAgents = options.agents.length > 0;
  if (!offersKinds && !offersWorkspaces && !offersAgents) {
    return null;
  }
  return (
    <FilterBar
      data-testid="inbox-filters"
      filters={
        <>
          {offersKinds ? (
            <Select
              className="w-full font-medium sm:w-52"
              aria-label={t("inbox.filterKind")}
              value={filter.kind ?? ""}
              onChange={(event) => onChange({ ...filter, kind: event.target.value || undefined })}
            >
              <option value="">{t("inbox.allKinds")}</option>
              {options.kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {t(kindOf(kind)?.label ?? "inbox.kindUnknown")}
                </option>
              ))}
            </Select>
          ) : null}
          {offersWorkspaces ? (
            <Select
              className="w-full font-medium sm:w-52"
              aria-label={t("inbox.filterWorkspace")}
              value={filter.workspaceId ?? ""}
              onChange={(event) =>
                onChange({ ...filter, workspaceId: event.target.value || undefined })
              }
            >
              <option value="">{t("inbox.allWorkspaces")}</option>
              {options.workspaceIds.map((workspaceId) => (
                <option key={workspaceId} value={workspaceId}>
                  {workspace?.(workspaceId)?.name}
                </option>
              ))}
            </Select>
          ) : null}
          {offersAgents ? (
            <Select
              className="w-full font-medium sm:w-52"
              aria-label={t("inbox.filterAgent")}
              value={filter.agentName ?? ""}
              onChange={(event) =>
                onChange({ ...filter, agentName: event.target.value || undefined })
              }
            >
              <option value="">{t("inbox.allAgents")}</option>
              {options.agents.map((agent) => (
                <option key={agent.name} value={agent.name}>
                  {agent.label}
                </option>
              ))}
            </Select>
          ) : null}
        </>
      }
    />
  );
}
