import type { MouseEvent } from "react";
import {
  Badge,
  Button,
  Card,
  CardTarget,
  Chip,
  Section,
  ServiceMark,
  cn
} from "@work-shape/catalyst-ui";
import { usePersonalConnectionsQuery } from "../../shared/api/personal-connections";
import { useOptionalBuildNavigation } from "../../shared/build-route";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { workspaceRoutePath } from "../../shared/routes";
import { useOptionalSettingsPage, useSettingsPage } from "../../shared/settings-page-context";
import type { BuildListHeadProps } from "./build-asset-kind";
import { useConnectionSource } from "./connection-source";
import {
  serviceCards,
  type ServiceCard,
  type ServiceCardAction,
  type ServiceCardStatus
} from "./connection-services-model";
import { offerText } from "./connection-typed-model";
import { OWN_SERVERS_ROUTE } from "./own-server-model";
import { requestOwnServerAdd } from "./own-server-request";

/** What a part, or a person's own server, is called on a card. */
const PART_LABELS: Record<ServiceCard["parts"][number], TranslationKey> = {
  tools: "connectionCatalogue.partTools",
  source: "connectionCatalogue.partSource",
  own: "connectionCatalogue.partOwn"
};

/** What a card says of its entry, in the reader's words. */
const STATUS_LABELS: Record<ServiceCardStatus, TranslationKey> = {
  connected: "connectionCatalogue.statusConnected",
  "set-up": "connectionCatalogue.statusSetUp",
  start: "connectionCatalogue.statusStart",
  "not-offered": "connectionCatalogue.notOffered"
};

/**
 * "Dienste" at the top of the Connections page (CAT-PAGE): one card per catalogue entry the
 * reader can act on, with the service's mark, one sentence, what it brings and what is true of
 * it here. A card set up here opens its Connection, one the reader connected opens where they
 * manage it, and one not yet set up starts its install or add. An entry the operator has not
 * named is greyed, says to ask, and opens nothing.
 */
export function CatalogueServices({
  cards,
  hrefOf,
  onAct
}: {
  cards: readonly ServiceCard[];
  /** The address a card that opens a page links to. */
  hrefOf(action: ServiceCardAction): string | undefined;
  onAct(action: ServiceCardAction): void;
}) {
  const { locale, t } = useTranslation();
  return (
    <Section
      layout="stacked"
      title={t("connectionCatalogue.services")}
      description={t("connectionCatalogue.servicesText")}
      data-connection-services=""
    >
      <ul
        className="grid min-w-0 grid-cols-1 gap-3 @xl:grid-cols-2 @5xl:grid-cols-3"
        aria-label={t("connectionCatalogue.services")}
      >
        {cards.map((card) => {
          const title = offerText(card.title, locale);
          const status = t(STATUS_LABELS[card.status]);
          const href = card.action ? hrefOf(card.action) : undefined;
          return (
            <li key={card.id} className="flex min-w-0">
              <Card
                padding="md"
                className={cn(
                  "flex w-full min-w-0 flex-col gap-3 p-4",
                  card.status === "not-offered" && "opacity-60"
                )}
                data-catalogue-entry={card.id}
                data-catalogue-status={card.status}
                data-catalogue-offered={card.status === "not-offered" ? "false" : "true"}
                aria-disabled={card.status === "not-offered" ? true : undefined}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <ServiceMark
                    name={title}
                    size="lg"
                    showName={false}
                    {...(card.mark.logo === undefined
                      ? card.mark.color === undefined
                        ? {}
                        : { color: card.mark.color }
                      : { logo: card.mark.logo })}
                  />
                  <div className="grid min-w-0 flex-1 gap-1">
                    <span className="text-label">{title}</span>
                    <span className="line-clamp-3 text-caption text-muted-foreground">
                      {offerText(card.description, locale)}
                    </span>
                  </div>
                </div>
                <div className="mt-auto flex min-w-0 flex-wrap items-center gap-2">
                  {card.parts.map((part) => (
                    <Chip key={part} size="sm" data-catalogue-part={part}>
                      {t(PART_LABELS[part])}
                    </Chip>
                  ))}
                  <span className="ml-auto flex shrink-0">
                    {card.action === undefined ? (
                      <Badge tone="neutral" data-catalogue-not-offered="">
                        {status}
                      </Badge>
                    ) : card.status === "start" ? (
                      <CardTarget label={t("connectionCatalogue.startLabel", { title })}>
                        <Button
                          size="sm"
                          variant="outline"
                          data-catalogue-start=""
                          onClick={() => {
                            if (card.action) onAct(card.action);
                          }}
                        >
                          {status}
                        </Button>
                      </CardTarget>
                    ) : (
                      <CardTarget label={t("connectionCatalogue.openLabel", { title })}>
                        <a
                          href={href}
                          className="rounded-md"
                          data-catalogue-open=""
                          onClick={(event) => {
                            if (href === undefined || opensHere(event)) {
                              event.preventDefault();
                              if (card.action) onAct(card.action);
                            }
                          }}
                        >
                          <Badge tone="success" dot>
                            {status}
                          </Badge>
                        </a>
                      </CardTarget>
                    )}
                  </span>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** A plain click opens the page here. With a modifier or another button the browser decides. */
function opensHere(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * The services above the list of Connections, read on the instance: the catalogue's entries
 * for whoever may make a Connection, the entries a person adds as their own server for whoever
 * may add one, and the reader's own sign-ins. Nothing while they are read or none is there.
 */
export function ConnectionServices(props: BuildListHeadProps) {
  // Studio shown alone, as in a rendering of its frame, reads no instance.
  return useOptionalSettingsPage() ? <InstanceServices {...props} /> : null;
}

function InstanceServices({ rows, canCreate, hrefOf, open, create }: BuildListHeadProps) {
  const { locale } = useTranslation();
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const source = useConnectionSource();
  const entries = source.useCatalogueEntries?.(canCreate);
  const mine = usePersonalConnectionsQuery({ apiBaseUrl, authScope, client });
  const navigation = useOptionalBuildNavigation();
  const openRoute = navigation?.openRoute;
  const read = mine.data !== undefined || mine.isError;
  if (rows === undefined || (canCreate && entries === undefined) || !read) return null;
  const own = mine.data?.ownServers;
  const cards = serviceCards({
    entries: canCreate ? (entries ?? []) : [],
    // A person's own servers are added under You > Connections: offered where it can open.
    ownEntries: own?.mayAdd && openRoute ? (own.entries ?? []) : [],
    connections: rows,
    mine: mine.data?.connections ?? [],
    mayCreate: canCreate
  });
  if (cards.length === 0) return null;
  return (
    <CatalogueServices
      cards={cards}
      hrefOf={(action) => {
        switch (action.kind) {
          case "open":
            return hrefOf(action.name);
          case "own-servers":
            return workspaceRoutePath(OWN_SERVERS_ROUTE);
          default:
            return undefined;
        }
      }}
      onAct={(action) => {
        switch (action.kind) {
          case "open":
            open(action.name);
            return;
          case "install":
            create(action.entry);
            return;
          case "own-servers":
            openRoute?.(OWN_SERVERS_ROUTE);
            return;
          case "add-own":
            requestOwnServerAdd({
              title: offerText(action.entry.title, locale),
              url: action.entry.url,
              entry: action.entry.id
            });
            openRoute?.(OWN_SERVERS_ROUTE);
            return;
        }
      }}
    />
  );
}
