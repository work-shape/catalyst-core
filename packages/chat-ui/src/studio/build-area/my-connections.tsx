import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { PersonalConnections } from "@work-shape/catalyst-api-client";
import {
  Button,
  Card,
  EmptyState,
  InlineError,
  Section,
  ServiceMark,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { usePersonalConnectionsQuery } from "../../shared/api/personal-connections";
import { useTranslation } from "../../shared/i18n";
import { useSettingsPage } from "../../shared/settings-page-context";
import {
  PersonalStateBadge,
  useOwnConnectionControls,
  usePersonalSignInFacts
} from "./connection-people";
import type { SignInBrowser } from "./connection-sign-in";
import { offerText } from "./connection-typed-model";
import { markArt, myConnectionCards } from "./my-connections-model";
import { ownServerAddedMessage, type OwnServerEntry } from "./own-server-model";
import {
  takeOwnServerAdd,
  useRequestedOwnServerAdd,
  type OwnServerAddRequest
} from "./own-server-request";
import { OwnServerAddDialog, OwnServerCard, type OwnServerAdded } from "./own-servers";

type PersonalRow = PersonalConnections["connections"][number];

/** What the add screen opens with: nothing, a service's tile, or an agent's proposal. */
interface Adding {
  key: number;
  initial?: { url?: string; title?: string; entry?: string };
  from?: OwnServerAddRequest["from"];
}

/**
 * "Meine Verbindungen" (CONN-IA): everything one person connects with their own account, as one
 * list of cards on Studio > Connections and on Settings > You > Connections. A card is an
 * account the instance asks each person for, with "Connected as …" and Disconnect or the one
 * Connect button; a server the person added; or a service they could still connect, whose
 * Connect opens the add screen at that service. Nobody else sees or uses what is connected here.
 */
export function MyConnectionsSection({
  title,
  description,
  untitled = false,
  browser
}: {
  /** Under a tab that already says "My connections": no title of its own. */
  untitled?: boolean;
  /** The section's title, where the page's head already says "My connections". */
  title?: string;
  /** The sentence under it. Without a `title` of its own the section says its own. */
  description?: string;
  browser?: SignInBrowser;
}) {
  const { apiBaseUrl, authScope, client, tellConversation } = useSettingsPage();
  const { locale, t } = useTranslation();
  const query = usePersonalConnectionsQuery({ apiBaseUrl, authScope, client });
  const mayAdd = query.data?.ownServers?.mayAdd === true;
  const entries = (mayAdd ? query.data?.ownServers?.entries : undefined) ?? [];
  const [adding, setAdding] = useState<Adding>();
  const openAdd = (start: Omit<Adding, "key"> = {}) =>
    setAdding((current) => ({ ...start, key: (current?.key ?? 0) + 1 }));
  // An agent's proposal from a chat (PMCP-CHAT) opens the add screen filled, once, where the
  // person may add a server; nothing is saved before they press Connect.
  const requested = useRequestedOwnServerAdd();
  const read = query.data !== undefined;
  useEffect(() => {
    if (requested === undefined || !read) return;
    takeOwnServerAdd(requested);
    if (!mayAdd) return;
    setAdding((current) => ({
      key: (current?.key ?? 0) + 1,
      initial: {
        url: requested.url,
        title: requested.title,
        ...(requested.entry === undefined ? {} : { entry: requested.entry })
      },
      ...(requested.from === undefined ? {} : { from: requested.from })
    }));
  }, [requested, mayAdd, read]);

  const cards = myConnectionCards({ connections: query.data?.connections ?? [], entries });
  const from = adding?.from;
  const addOwn = mayAdd ? (
    <Button size="sm" variant="outline" data-own-server-add="" onClick={() => openAdd()}>
      <Plus aria-hidden="true" />
      {t("myConnections.addOwn")}
    </Button>
  ) : undefined;
  const content = (
    <>
      {query.isPending ? (
        <SkeletonList rows={3} />
      ) : query.isError ? (
        <InlineError className="flex flex-wrap items-center justify-between gap-2">
          <span>{t("personalConnections.loadFailed")}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              query.refetch().catch(() => undefined);
            }}
          >
            {t("tryAgain")}
          </Button>
        </InlineError>
      ) : cards.length === 0 ? (
        <EmptyState layout="inline" data-my-connections-empty="">
          {t(mayAdd ? "myConnections.emptyMayAdd" : "myConnections.empty")}
        </EmptyState>
      ) : (
        <ul className="grid min-w-0 gap-3" aria-label={t("myConnections.title")}>
          {cards.map((card) => (
            <li
              key={card.kind === "offer" ? `offer:${card.entry.id}` : card.row.name}
              className="min-w-0"
            >
              {card.kind === "account" ? (
                <AccountCard connection={card.row} {...(browser ? { browser } : {})} />
              ) : card.kind === "own" ? (
                <OwnServerCard
                  row={card.row}
                  entry={card.entry}
                  {...(browser ? { browser } : {})}
                />
              ) : (
                <OfferCard
                  entry={card.entry}
                  onConnect={() =>
                    openAdd({
                      initial: {
                        url: card.entry.url,
                        title: offerText(card.entry.title, locale),
                        entry: card.entry.id
                      }
                    })
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <OwnServerAddDialog
          key={adding.key}
          onClose={() => setAdding(undefined)}
          entries={entries}
          {...(adding.initial ? { initial: adding.initial } : {})}
          {...(from && tellConversation
            ? {
                // The conversation whose agent proposed the server hears once that it is added.
                onAdded: (added: OwnServerAdded) => {
                  tellConversation(from, ownServerAddedMessage(added, t)).catch(() => undefined);
                }
              }
            : {})}
          {...(browser ? { browser } : {})}
        />
      ) : null}
    </>
  );
  if (untitled) {
    return (
      <div className="grid min-w-0 gap-4" data-my-connections="">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="min-w-0 text-caption text-muted-foreground">
            {t("myConnections.description")}
          </p>
          {addOwn}
        </div>
        <div className="grid min-w-0 gap-5">{content}</div>
      </div>
    );
  }
  return (
    <Section
      layout="stacked"
      title={title ?? t("myConnections.title")}
      description={title === undefined ? t("myConnections.description") : description}
      action={addOwn}
      data-my-connections=""
    >
      {content}
    </Section>
  );
}

/**
 * An account the instance asks each person for: the service's mark, the Connection's name,
 * whether the reader's own account is connected and as whom, which agents work with it, and
 * Connect or Disconnect.
 */
function AccountCard({
  connection,
  browser
}: {
  connection: PersonalRow;
  browser?: SignInBrowser;
}) {
  const { locale, t } = useTranslation();
  const title = connection.title.trim() || connection.name;
  const service =
    connection.serviceTitle === undefined ? undefined : offerText(connection.serviceTitle, locale);
  const facts = usePersonalSignInFacts()(connection);
  const controls = useOwnConnectionControls({ ...connection, title }, browser);
  const agents = connection.usedBy ?? [];
  return (
    <Card
      padding="md"
      className="grid min-w-0 gap-3 p-3"
      data-personal-connection={connection.name}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <ServiceMark
          name={service ?? title}
          size="lg"
          showName={false}
          {...markArt(connection.mark)}
        />
        <div className="grid min-w-0 flex-1 basis-56 gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-label wrap-anywhere">{title}</span>
            <PersonalStateBadge signIn={connection} token={connection.token !== undefined} />
          </span>
          {facts ? <span className="text-caption text-muted-foreground">{facts}</span> : null}
          <span
            className="text-caption text-muted-foreground wrap-anywhere"
            data-personal-connection-used-by={agents.length}
          >
            {agents.length === 0
              ? t("myConnections.usedByNone")
              : t("myConnections.usedBy", {
                  agents: new Intl.ListFormat(locale, { type: "conjunction" }).format(agents)
                })}
          </span>
        </div>
        {controls.buttons}
      </div>
      {controls.below}
    </Card>
  );
}

/** A service the person could connect themselves: its mark, one sentence, and Connect. */
function OfferCard({ entry, onConnect }: { entry: OwnServerEntry; onConnect(): void }) {
  const { locale, t } = useTranslation();
  const title = offerText(entry.title, locale);
  return (
    <Card padding="md" className="grid min-w-0 gap-3 p-3" data-my-connection-offer={entry.id}>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <ServiceMark name={title} size="lg" showName={false} {...markArt(entry.mark)} />
        <div className="grid min-w-0 flex-1 basis-48 gap-1">
          <span className="text-label wrap-anywhere">{title}</span>
          <span className="text-caption text-muted-foreground">
            {offerText(entry.description, locale)}
          </span>
        </div>
        <Button
          size="sm"
          variant="primary"
          aria-label={t("myConnections.connectLabel", { title })}
          data-my-connection-connect=""
          onClick={onConnect}
        >
          {t("personalConnections.connect")}
        </Button>
      </div>
    </Card>
  );
}
