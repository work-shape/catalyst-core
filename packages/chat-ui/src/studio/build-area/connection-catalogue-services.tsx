import { ChevronRight } from "lucide-react";
import {
  Badge,
  Card,
  CardTarget,
  Chip,
  IconButton,
  ServiceMark,
  cn
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { CatalogueEntryOffer } from "./connection-catalogue-model";
import { offerText } from "./connection-typed-model";

/**
 * "Dienste" in New connection (CAT-1): one card per catalogue entry, with the service's mark,
 * one sentence and the parts it brings. An entry the operator has not named is greyed, says
 * to ask the operator, and cannot be chosen.
 */
export function CatalogueServices({
  entries,
  onChoose
}: {
  entries: readonly CatalogueEntryOffer[];
  onChoose(entry: CatalogueEntryOffer): void;
}) {
  const { locale, t } = useTranslation();
  return (
    <section className="grid min-w-0 gap-2" data-connection-services="">
      <h3 className="text-label text-muted-foreground">{t("connectionCatalogue.services")}</h3>
      <div
        className="grid min-w-0 gap-2"
        role="group"
        aria-label={t("connectionCatalogue.services")}
      >
        {entries.map((entry) => {
          const title = offerText(entry.title, locale);
          return (
            <Card
              key={entry.id}
              padding="md"
              className={cn("flex min-w-0 items-center gap-3 p-3", !entry.offered && "opacity-60")}
              data-catalogue-entry={entry.id}
              data-catalogue-offered={entry.offered ? "true" : "false"}
              aria-disabled={entry.offered ? undefined : true}
            >
              <ServiceMark
                name={title}
                size="lg"
                showName={false}
                {...(entry.mark.logo === undefined
                  ? entry.mark.color === undefined
                    ? {}
                    : { color: entry.mark.color }
                  : { logo: entry.mark.logo })}
              />
              <div className="grid min-w-0 flex-1 gap-1">
                <span className="text-label">{title}</span>
                <span className="text-caption text-muted-foreground">
                  {offerText(entry.description, locale)}
                </span>
                <span className="flex min-w-0 flex-wrap gap-1">
                  {entry.parts.map((part) => (
                    <Chip key={part.part} size="sm" data-catalogue-part={part.part}>
                      {t(
                        part.part === "tools"
                          ? "connectionCatalogue.partTools"
                          : "connectionCatalogue.partSource"
                      )}
                    </Chip>
                  ))}
                  {entry.offered ? null : (
                    <Badge tone="neutral" data-catalogue-not-offered="">
                      {t("connectionCatalogue.notOffered")}
                    </Badge>
                  )}
                </span>
              </div>
              {entry.offered ? (
                <CardTarget label={title}>
                  <IconButton label={title} onClick={() => onChoose(entry)}>
                    <ChevronRight aria-hidden="true" />
                  </IconButton>
                </CardTarget>
              ) : null}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
