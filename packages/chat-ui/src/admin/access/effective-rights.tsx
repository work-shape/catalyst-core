// @rights-screen: included in the rights wording guard.
import { ListChecks } from "lucide-react";
import type { HolderRights } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { useSettingsPage } from "../../shared/settings-page-context";
import { useHolderRightsQuery } from "./access-queries";
import {
  effectiveRightAreas,
  rightAreaLabelKey,
  type EffectiveRightRow
} from "./effective-rights-model";
import { originLabel, placeLabel } from "./origin-words";
import { actionLabel, rightVerb, verbLabel } from "./right-words";

type Translate = TranslationContextValue["t"];

/**
 * What one line allows or refuses. In the area of a kind its verbs suffice ("Ansehen und
 * Bearbeiten"); a right in words of its own keeps them.
 */
function rowActions(row: EffectiveRightRow, area: string, t: Translate, locale: string): string {
  const labels = row.actions.map((action) => {
    const verb = rightVerb(action);
    return verb !== undefined && action.startsWith(`${area}.`)
      ? verbLabel(verb, t)
      : actionLabel(action, t);
  });
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(labels);
}

/**
 * The rights the server decided for one person, grouped by area, each line with where it
 * applies, whether it holds, and where it comes from: the role, a right given directly, a
 * membership, and the deny that refuses it.
 */
export function EffectiveRights({ rights }: { rights: HolderRights }) {
  const { t, locale } = useTranslation();
  const areas = effectiveRightAreas(rights.rights);
  return (
    <div className="grid gap-4">
      {rights.holderActive ? null : <Banner tone="warning">{t("access.effectiveInactive")}</Banner>}
      {areas.length === 0 ? <EmptyState>{t("access.effectiveEmpty")}</EmptyState> : null}
      {areas.map((area) => (
        <section key={area.area} className="grid gap-1.5" aria-label={areaName(area, t)}>
          <h3 className="text-caption font-medium text-muted-foreground">{areaName(area, t)}</h3>
          <ul className="grid divide-y rounded-md border">
            {area.rows.map((row) => {
              const place = placeLabel(row.place, t);
              const denyPlace =
                row.deniedBy !== undefined &&
                (row.deniedBy.scopeKind !== row.place.scopeKind ||
                  row.deniedBy.scopeId !== row.place.scopeId)
                  ? placeLabel(row.deniedBy, t)
                  : undefined;
              return (
                <li
                  key={row.key}
                  data-testid="effective-right"
                  data-area={area.area}
                  data-allowed={row.allowed}
                  className="grid gap-1.5 px-3 py-2.5 text-sm @lg:grid-cols-[minmax(0,1fr)_auto] @lg:items-start @lg:gap-3"
                >
                  <div className="grid min-w-0 gap-0.5">
                    <span className="font-medium">{rowActions(row, area.area, t, locale)}</span>
                    <span className="text-xs text-muted-foreground">{place}</span>
                    {denyPlace === undefined ? null : (
                      <span className="text-xs text-muted-foreground">
                        {t("access.originDenyPlace", { place: denyPlace })}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 @lg:justify-end">
                    <Badge tone={row.allowed ? "success" : "danger"}>
                      {t(row.allowed ? "access.checkAllowed" : "access.checkRefused")}
                    </Badge>
                    {row.grantedBy.map((origin) => (
                      <Badge
                        key={`${origin.source}:${origin.roleId ?? ""}`}
                        appearance="outline"
                        className="font-normal"
                      >
                        {originLabel(origin, rights.roles, t)}
                      </Badge>
                    ))}
                    {row.deniedBy === undefined ? null : (
                      <Badge tone="danger" appearance="outline" className="font-normal">
                        {originLabel(row.deniedBy, rights.roles, t)}
                      </Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function areaName(area: ReturnType<typeof effectiveRightAreas>[number], t: Translate): string {
  return t(rightAreaLabelKey(area.area));
}

/**
 * The card of the User screen: the person's effective rights as the server decided them,
 * read under the rule of reading a person's rights.
 */
export function UserEffectiveRightsCard({ holderId }: { holderId: string }) {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const query = useHolderRightsQuery({ apiBaseUrl, authScope, client, holderId });
  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks size={17} aria-hidden="true" />
          {t("access.effectiveTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="@container grid gap-3 p-4 pt-2">
        <p className="text-sm text-muted-foreground">{t("access.effectiveDescription")}</p>
        {query.data ? (
          <EffectiveRights rights={query.data} />
        ) : query.error ? (
          <Banner
            tone="danger"
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => void query.refetch().catch(() => undefined)}
              >
                {t("tryAgain")}
              </Button>
            }
          >
            {t("access.effectiveLoadFailed")}
          </Banner>
        ) : (
          <SkeletonList rows={3} />
        )}
      </CardContent>
    </Card>
  );
}
