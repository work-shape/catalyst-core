import { Building2, Search, Users } from "lucide-react";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import {
  Avatar,
  AvatarStack,
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  Dialog,
  FormNotice,
  Input,
  ListRow,
  nextSuggestion,
  SuggestionList,
  suggestionOptionId,
  type SuggestionListOption
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { useChatShare, useShareCandidates, type ChatReader } from "./chat-share";
import { candidateOption, SEARCH_DELAY_MS, useDebounced } from "./share-menu";
import { listNames, noMatchWords, shareRefusal } from "./share-words";

// Who reads the open chat (CHAT-SHARE-2): a row of avatars in the chat's head and, for its
// creator, a Share button. Both open the panel "Who can see this chat": the creator, each person
// named with Remove or Leave, and for the creator "Add person" with the same people the @ menu
// offers. A reader from outside the chat's workspace sees the workspace's name on a chip before
// the avatars (CHAT-SHARE-6), and nothing else of it.

/** The chat head's people, at its end. Nothing on a chat no one else reads and no one shares. */
export function ChatPeopleHead() {
  const share = useChatShare();
  const { t } = useTranslation();
  if (!share) return null;
  const shared = share.readers.length > 1;
  if (!shared && !share.canAdd) return null;
  const others = share.readers.filter((reader) => !reader.you).map((reader) => reader.label);
  const workspace = share.chat.workspaceName;
  return (
    <>
      {share.chat.outside ? (
        <span
          className="inline-flex min-w-0 max-w-48"
          data-testid="chat-outside-workspace"
          title={t("chatShare.outsideChipLabel", { workspace })}
        >
          <Chip size="sm" leading={<Building2 aria-hidden="true" />}>
            <span className="sr-only">{t("chatShare.outsideChipLabel", { workspace })}</span>
            <span aria-hidden="true">{workspace}</span>
          </Chip>
        </span>
      ) : null}
      {shared ? (
        <Button
          variant="ghost"
          size="sm"
          className="px-1.5"
          aria-label={t("chatShare.peopleLabel", { names: listNames(others, t) })}
          data-testid="chat-people"
          onClick={() => share.setPanelOpen(true)}
        >
          <AvatarStack
            people={share.readers.map((reader) => ({ id: reader.userId, name: reader.label }))}
            size="xs"
          />
        </Button>
      ) : null}
      {share.canAdd ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("chatShare.shareLabel")}
          data-testid="chat-share-button"
          onClick={() => share.setPanelOpen(true)}
        >
          <Users aria-hidden="true" />
          {/* In a narrow window the head keeps the icon alone; the button's name stays. */}
          <span className="max-md:hidden">{t("chatShare.share")}</span>
        </Button>
      ) : null}
      <ChatPeoplePanel />
    </>
  );
}

/** The panel "Who can see this chat", open while the share says so. */
function ChatPeoplePanel() {
  const share = useChatShare();
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  if (!share) return null;
  const { readers, isCreator, canAdd } = share;
  const creator = readers.find((reader) => reader.creator);
  const close = () => {
    setError(undefined);
    share.setPanelOpen(false);
  };
  const remove = async (reader: ChatReader) => {
    setBusy(reader.userId);
    setError(undefined);
    const refused = await share.remove({ userId: reader.userId, label: reader.label });
    setBusy(undefined);
    if (refused) setError(refused.message);
    return refused === undefined;
  };

  return (
    <>
      <Dialog
        open={share.panelOpen}
        title={t("chatShare.panelTitle")}
        description={canAdd ? t("chatShare.addNote") : undefined}
        size="sm"
        onClose={close}
        footer={
          <Button variant="secondary" onClick={close}>
            {t("chatShare.close")}
          </Button>
        }
      >
        <div className="grid gap-4" data-testid="chat-people-panel">
          <ul className="grid">
            {readers.map((reader) => (
              <ListRow
                key={reader.userId}
                data-testid="chat-reader"
                data-deactivated={reader.deactivated ? "true" : undefined}
                leading={<Avatar kind="person" size="sm" name={reader.label} />}
                title={
                  reader.deactivated ? (
                    // Muted: they read nothing while they cannot sign in.
                    <span className="text-muted-foreground">{reader.label}</span>
                  ) : reader.you ? (
                    t("chatShare.you", { name: reader.label })
                  ) : (
                    reader.label
                  )
                }
                description={
                  reader.creator
                    ? t("chatShare.startedChat")
                    : reader.deactivated
                      ? t("chatShare.deactivated")
                      : t("chatShare.named")
                }
                actionsVisible
                actions={
                  reader.creator ? undefined : isCreator ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("chatShare.removeLabel", { name: reader.label })}
                      disabled={busy !== undefined}
                      onClick={() => {
                        remove(reader).catch(() => undefined);
                      }}
                    >
                      {t("chatShare.remove")}
                    </Button>
                  ) : reader.you ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== undefined}
                      onClick={() => setLeaving(true)}
                    >
                      {t("chatShare.leave")}
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </ul>
          {readers.length === 1 && isCreator ? (
            <p className="text-body text-muted-foreground">{t("chatShare.panelOnlyYou")}</p>
          ) : null}
          {error ? (
            <FormNotice tone="error" data-testid="chat-people-error">
              {error}
            </FormNotice>
          ) : null}
          {canAdd ? <AddPerson onError={setError} /> : null}
          {!isCreator && creator ? (
            <p className="text-caption text-muted-foreground">
              {t("chatShare.deletedWithAccount", { name: creator.label })}
            </p>
          ) : null}
        </div>
      </Dialog>
      <ConfirmDialog
        open={leaving}
        title={t("chatShare.leaveTitle")}
        confirmLabel={t("chatShare.leaveConfirm")}
        loading={busy !== undefined}
        onClose={() => setLeaving(false)}
        onConfirm={() => {
          const self = readers.find((reader) => reader.you && !reader.creator);
          if (!self) return;
          // A refused leave says why in the panel under the question.
          remove(self)
            .catch(() => false)
            .finally(() => setLeaving(false));
        }}
      >
        {t("chatShare.leaveBody", { title: share.chat.conversation.title })}
      </ConfirmDialog>
    </>
  );
}

/** "Add person": the people the @ menu offers, a search among them, and a share on a pick. */
function AddPerson({ onError }: { onError(message: string | undefined): void }) {
  const share = useChatShare();
  const { t } = useTranslation();
  const listId = useId();
  const fieldId = useId();
  const [text, setText] = useState("");
  const [activeId, setActiveId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const query = useDebounced(text, SEARCH_DELAY_MS);
  // The panel's dialog stays mounted while closed: the people are asked for once it opens.
  const candidates = useShareCandidates({
    chat: share?.chat,
    query,
    enabled: share?.panelOpen === true
  });
  const searching = query.trim() !== "";
  const options = useMemo(
    (): SuggestionListOption[] =>
      (candidates.data?.candidates ?? [])
        // Before a search the list offers only people who cannot read the chat yet.
        .filter((candidate) => searching || !candidate.hasAccess)
        .map((candidate) =>
          candidateOption(
            candidate,
            share?.chat.workspaceName ?? "",
            t,
            candidate.hasAccess || adding
          )
        ),
    [adding, candidates.data, searching, share?.chat.workspaceName, t]
  );
  if (!share) return null;
  const refusal = candidates.error ? shareRefusal(candidates.error, t) : undefined;
  const active =
    activeId !== undefined && options.some((option) => option.id === activeId && !option.disabled)
      ? activeId
      : nextSuggestion(options, undefined, 1);
  const workspace = share.chat.workspaceName;

  const choose = async (id: string) => {
    const option = options.find((candidate) => candidate.id === id);
    if (!option || option.disabled) return;
    setAdding(true);
    onError(undefined);
    const refused = await share.add({ userId: option.id, label: option.label });
    setAdding(false);
    if (refused) onError(refused.message);
    else setText("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveId(nextSuggestion(options, active, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter" && active !== undefined) {
      event.preventDefault();
      choose(active).catch(() => undefined);
    }
  };

  if (refusal) {
    return (
      <Banner
        tone="info"
        data-testid="chat-share-refusal"
        action={
          refusal.reason === "personal_workspace_conversation" && share.chat.onMove ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                share.setPanelOpen(false);
                share.chat.onMove?.();
              }}
            >
              {t("moveConversationMenuItem")}
            </Button>
          ) : undefined
        }
      >
        {refusal.message}
      </Banner>
    );
  }

  return (
    <div className="grid gap-2">
      <label htmlFor={fieldId} className="text-label">
        {t("chatShare.addPerson")}
      </label>
      <Input
        id={fieldId}
        size="sm"
        value={text}
        placeholder={t("chatShare.search")}
        leadingIcon={<Search aria-hidden="true" />}
        role="combobox"
        aria-controls={listId}
        aria-expanded={options.length > 0}
        aria-autocomplete="list"
        {...(active === undefined
          ? {}
          : { "aria-activedescendant": suggestionOptionId(listId, active) })}
        autoComplete="off"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <SuggestionList
        id={listId}
        label={t("chatShare.menuLabel")}
        surface="inline"
        options={options}
        activeId={active}
        onActiveChange={setActiveId}
        onSelect={(id) => {
          choose(id).catch(() => undefined);
        }}
        loading={candidates.isFetching || adding}
        // Nobody left to add says nothing; a search that finds nobody says so.
        empty={
          !searching || (candidates.isFetching && options.length === 0)
            ? undefined
            : noMatchWords(query, workspace, t)
        }
      />
    </div>
  );
}
