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
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import {
  type ServiceCard,
  type ServiceCardAction,
  type ServiceCardStatus
} from "./connection-services-model";
import { offerText } from "./connection-typed-model";

/** What a part is called on a card. */
const PART_LABELS: Record<ServiceCard["parts"][number], TranslationKey> = {
  tools: "connectionCatalogue.partTools",
  source: "connectionCatalogue.partSource"
};

/** What a card says of its entry, in the reader's words. */
const STATUS_LABELS: Record<ServiceCardStatus, TranslationKey> = {
  installed: "connectionCatalogue.statusInstalled",
  start: "connectionCatalogue.statusStart",
  "not-offered": "connectionCatalogue.notOffered"
};

/**
 * "Dienste hinzufügen" on the manage tab of the Connections page (CAT-PAGE, CONN-IA): one card
 * per catalogue entry, with the service's mark, one sentence, what it brings and whether the
 * instance has it. A card of an installed entry opens its Connection and says so in neutral
 * words, never as if the reader were connected; one not yet installed starts its install. An
 * entry the operator has not named is greyed, says to ask, and opens nothing.
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
      title={t("connectionCatalogue.installTitle")}
      description={t("connectionCatalogue.installText")}
      data-connection-services=""
    >
      <ul
        className="grid min-w-0 grid-cols-1 gap-3 @xl:grid-cols-2 @5xl:grid-cols-3"
        aria-label={t("connectionCatalogue.installTitle")}
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
                          <Badge tone="neutral">{status}</Badge>
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
