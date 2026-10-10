import { FolderInput, Lock, MoreHorizontal, Pencil, Search, SquarePen, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  ApiClient,
  CollaborationWorkspaceWithRole,
  ConversationListItem,
  LocaleCode
} from "@vivd-catalyst/api-client";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  FilterBar,
  IconButton,
  InlineError,
  Input,
  List,
  ListRow,
  Page,
  PageHeader,
  SkeletonList
} from "@vivd-catalyst/ui";
import { useConversationPagesQuery } from "../api/conversation-search-query";
import { collaborationWorkspaceDisplayName } from "../collaboration-workspace/collaboration-workspace-selector";
import { useTranslation } from "../i18n";
import { formatInboxAge } from "../inbox/inbox-model";
import { SEARCH_DELAY_MS, useDelayed } from "../workspace/conversation-palette";

/** The longest title a conversation takes, as the rail's rename field holds it. */
const CONVERSATION_TITLE_MAX_CHARS = 120;

/** How long ago an activity still reads as an age ("3 days ago"). An older one shows its date. */
const AGE_SHOWN_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/** When a conversation was last active: an age within a week, a date after it. */
export function formatLastActivity(value: string, locale: LocaleCode, now: Date): string {
  const then = new Date(value);
  if (Number.isNaN(then.getTime()) || now.getTime() - then.getTime() < AGE_SHOWN_FOR_MS) {
    return formatInboxAge(value, locale, now);
  }
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(then.getFullYear() === now.getFullYear() ? {} : { year: "numeric" })
  }).format(then);
}

/** How the list stands on the page. */
export type ConversationListState =
  | { status: "loading" }
  | { status: "failed"; onRetry(): void }
  | {
      status: "ready";
      conversations: readonly ConversationListItem[];
      /** The text the shown rows were searched with. Empty for the whole list. */
      searched: string;
      /** The server has older rows than the ones shown. */
      hasMore: boolean;
      loadingMore: boolean;
      /** The last request for older rows failed. The rows there are stay. */
      moreFailed: boolean;
      onShowMore(): void;
    };

interface ConversationListActions {
  /** Absent while the person belongs to a single workspace. */
  onMove?(conversation: ConversationListItem): void;
  onOpen(conversationId: string): void;
  onNewChat(): void;
  onRename(conversationId: string, title: string): Promise<void>;
  onDelete(conversationId: string): void;
}

/**
 * Every conversation of the active workspace, latest activity first, with a search by title.
 * It reads one page at a time and the older ones on request; the search is answered by the
 * server, so it reaches a conversation that no loaded page holds.
 */
export function ConversationListArea({
  apiBaseUrl,
  authScope,
  client,
  collaborationWorkspaceId,
  collaborationWorkspacesAvailable,
  searchedWorkspace,
  notice,
  deleting,
  ...actions
}: ConversationListActions & {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  collaborationWorkspaceId: string | undefined;
  collaborationWorkspacesAvailable: boolean;
  /** The workspace the list belongs to. A search without a match names it. */
  searchedWorkspace: Pick<CollaborationWorkspaceWithRole, "kind" | "name"> | undefined;
  /** What went wrong with the last change to a conversation, in the reader's language. */
  notice: string | undefined;
  deleting: boolean;
}) {
  const [query, setQuery] = useState("");
  const searched = useDelayed(query.trim(), SEARCH_DELAY_MS);
  const pages = useConversationPagesQuery({
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId,
    collaborationWorkspacesAvailable,
    titleQuery: searched
  });
  const conversations = useMemo(() => {
    // A conversation that moves up between two requests is in both pages; it shows once.
    const byId = new Map<string, ConversationListItem>();
    for (const page of pages.data?.pages ?? []) {
      for (const conversation of page.items) {
        if (!byId.has(conversation.id)) {
          byId.set(conversation.id, conversation);
        }
      }
    }
    return [...byId.values()];
  }, [pages.data]);

  const retry = () => {
    pages.refetch().catch(() => undefined);
  };
  const state: ConversationListState =
    pages.data === undefined
      ? pages.isError
        ? { status: "failed", onRetry: retry }
        : { status: "loading" }
      : // An answer to another text stays in view until the new one arrives; a failed one does not.
        pages.isError && pages.isPlaceholderData
        ? { status: "failed", onRetry: retry }
        : {
            status: "ready",
            conversations,
            // The rows of an earlier text are still the earlier text's.
            searched: pages.isPlaceholderData ? "" : searched,
            hasMore: pages.hasNextPage,
            loadingMore: pages.isFetchingNextPage,
            moreFailed: pages.isFetchNextPageError,
            onShowMore: () => {
              pages.fetchNextPage().catch(() => undefined);
            }
          };

  return (
    <ConversationListView
      state={state}
      query={query}
      workspaceName={searchedWorkspace}
      notice={notice}
      deleting={deleting}
      onQueryChange={setQuery}
      {...actions}
    />
  );
}

/** The list as it stands for given rows: the page, the search field, the rows and their menus. */
export function ConversationListView({
  state,
  query,
  workspaceName,
  notice,
  deleting,
  now,
  onQueryChange,
  onOpen,
  onNewChat,
  onRename,
  onMove,
  onDelete
}: ConversationListActions & {
  state: ConversationListState;
  query: string;
  workspaceName?: Pick<CollaborationWorkspaceWithRole, "kind" | "name">;
  notice?: string;
  deleting: boolean;
  /** The moment the ages are counted from. Without it, the moment the rows arrived. */
  now?: Date;
  onQueryChange(query: string): void;
}) {
  const { locale, t } = useTranslation();
  const titleRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<ConversationListItem | undefined>();
  const [confirmingDelete, setConfirmingDelete] = useState<ConversationListItem | undefined>();
  const rows = state.status === "ready" ? state.conversations : undefined;
  const arrived = useMemo(() => new Date(), [rows]);
  const countedFrom = now ?? arrived;

  // The area's title takes the focus when the area opens, as on every full page.
  useEffect(() => {
    const title = titleRef.current?.querySelector("h1");
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }, []);

  let list;
  if (state.status === "loading") {
    list = <SkeletonList rows={6} data-testid="conversation-list-loading" />;
  } else if (state.status === "failed") {
    list = (
      <InlineError data-testid="conversation-list-failed">
        {t("nav.recentLoadFailed")}{" "}
        <Button variant="link" size="sm" className="px-0" onClick={state.onRetry}>
          {t("tryAgain")}
        </Button>
      </InlineError>
    );
  } else if (state.conversations.length === 0) {
    list =
      state.searched === "" ? (
        <EmptyState
          data-testid="conversation-list-empty"
          action={
            <Button onClick={onNewChat}>
              <SquarePen aria-hidden="true" />
              {t("nav.newChat")}
            </Button>
          }
        >
          {t("noConversations")}
        </EmptyState>
      ) : (
        <EmptyState data-testid="conversation-list-no-match">
          {workspaceName
            ? t("nav.paletteNoMatchInWorkspace", {
                query: state.searched,
                workspace: collaborationWorkspaceDisplayName(workspaceName, t)
              })
            : t("nav.paletteNoMatch", { query: state.searched })}
        </EmptyState>
      );
  } else {
    list = (
      <>
        <List data-testid="conversation-list" aria-label={t("nav.conversations")}>
          {state.conversations.map((conversation) => (
            <ListRow
              key={conversation.id}
              size="compact"
              data-testid="conversation-list-row"
              data-conversation-id={conversation.id}
              title={conversation.title}
              chips={
                conversation.visibility === "private" ? (
                  <span
                    className="flex shrink-0 text-muted-foreground"
                    role="img"
                    aria-label={t("conversationPrivate")}
                    title={t("conversationPrivate")}
                  >
                    <Lock className="size-3" aria-hidden="true" />
                  </span>
                ) : undefined
              }
              time={
                <time dateTime={conversation.updatedAt}>
                  {formatLastActivity(conversation.updatedAt, locale, countedFrom)}
                </time>
              }
              actions={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild disabled={deleting}>
                    <IconButton
                      size="sm"
                      label={t("conversationOptions", { title: conversation.title })}
                    >
                      <MoreHorizontal aria-hidden="true" />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      icon={<Pencil aria-hidden="true" />}
                      onSelect={() => setRenaming(conversation)}
                    >
                      {t("renameConversationMenuItem")}
                    </DropdownMenuItem>
                    {onMove ? (
                      <DropdownMenuItem
                        icon={<FolderInput aria-hidden="true" />}
                        onSelect={() => onMove(conversation)}
                      >
                        {t("moveConversationMenuItem")}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      tone="danger"
                      icon={<Trash2 aria-hidden="true" />}
                      onSelect={() => setConfirmingDelete(conversation)}
                    >
                      {t("deleteConversationMenuItem")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
              onClick={() => onOpen(conversation.id)}
            />
          ))}
        </List>
        {state.moreFailed ? (
          <InlineError className="mt-3">{t("conversationListMoreFailed")}</InlineError>
        ) : null}
        {state.hasMore ? (
          <div className="flex justify-center pt-4">
            <Button
              variant="outline"
              size="sm"
              loading={state.loadingMore}
              onClick={state.onShowMore}
            >
              {t(state.moreFailed ? "tryAgain" : "conversationListShowMore")}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <section
      aria-label={t("nav.conversations")}
      className="h-full min-h-0 min-w-0 bg-background pt-(--layout-header)"
      data-testid="conversation-list-area"
    >
      <div
        ref={titleRef}
        className="chat-scrollbar h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto"
      >
        <Page>
          <PageHeader title={t("nav.conversations")} />
          <FilterBar
            className="pb-4"
            search={
              <Input
                type="search"
                value={query}
                leadingIcon={<Search />}
                placeholder={t("conversationListSearch")}
                aria-label={t("conversationListSearch")}
                onChange={(event) => onQueryChange(event.currentTarget.value)}
              />
            }
          />
          {notice ? <InlineError className="mb-3">{notice}</InlineError> : null}
          {list}
        </Page>
      </div>
      <RenameConversationDialog
        conversation={renaming}
        onClose={() => setRenaming(undefined)}
        onRename={onRename}
      />
      <ConfirmDialog
        open={confirmingDelete !== undefined}
        title={t("deleteConversationDialogTitle")}
        confirmLabel={t("confirmDeleteConversation")}
        onClose={() => setConfirmingDelete(undefined)}
        onConfirm={() => {
          if (confirmingDelete) {
            onDelete(confirmingDelete.id);
          }
          setConfirmingDelete(undefined);
        }}
      >
        {t("deleteConversationDialogDescription", { title: confirmingDelete?.title ?? "" })}
      </ConfirmDialog>
    </section>
  );
}

/** Asks for the new title of a conversation. A failed rename is reported by the page. */
function RenameConversationDialog({
  conversation,
  onClose,
  onRename
}: {
  conversation: ConversationListItem | undefined;
  onClose(): void;
  onRename(conversationId: string, title: string): Promise<void>;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const formId = "rename-conversation-form";

  useEffect(() => {
    setTitle(conversation?.title ?? "");
  }, [conversation]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const next = title.trim();
    if (!conversation || next === "") {
      return;
    }
    onClose();
    if (next !== conversation.title) {
      // The page shows the reason when the server refuses the title.
      onRename(conversation.id, next).catch(() => undefined);
    }
  }

  return (
    <Dialog
      open={conversation !== undefined}
      size="sm"
      title={t("renameConversationMenuItem")}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={title.trim() === ""}>
            {t("renameConversationConfirm")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <Field label={t("renameConversationField")}>
          <Input
            value={title}
            maxLength={CONVERSATION_TITLE_MAX_CHARS}
            autoFocus
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
