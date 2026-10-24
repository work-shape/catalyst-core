import type { OwnUsage, UsageSpendPeriod } from "@work-shape/catalyst-api-client";
import {
  List,
  ListRow,
  LoadError,
  PageHeader,
  Progress,
  Section,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { useOwnUsageQuery } from "../../../shared/api/usage-limits";
import { useTranslation, type TranslationKey } from "../../../shared/i18n";
import { useSettingsPage } from "../../../shared/settings-page-context";
import { formatSpend, nearLimit } from "../../../chat/workspace/usage-limit-block";

const PERIODS: readonly {
  period: keyof OwnUsage["own"];
  label: TranslationKey;
  reset: TranslationKey;
}[] = [
  { period: "day", label: "ownUsage.today", reset: "runUsageLimitResetDay" },
  { period: "month", label: "ownUsage.thisMonth", reset: "runUsageLimitResetMonth" }
];

/**
 * You > Usage (LU-2): what the person's own messages cost today and this month, against their
 * own spend limit. Every user sees their own consumption; nobody else's.
 */
export function OwnUsagePage() {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const usage = useOwnUsageQuery({ apiBaseUrl, authScope, client });
  return (
    <OwnUsageView
      usage={usage.data}
      failed={usage.isError}
      onRetry={() => {
        usage.refetch().catch(() => undefined);
      }}
    />
  );
}

function OwnUsageView({
  usage,
  failed,
  onRetry
}: {
  usage: OwnUsage | undefined;
  failed: boolean;
  onRetry(): void;
}) {
  const { t, locale } = useTranslation();
  return (
    <>
      <PageHeader title={t("settings.ownUsage")} description={t("ownUsage.description")} />
      <Section layout="stacked" title={t("ownUsage.section")}>
        {failed ? (
          <LoadError onRetry={onRetry}>{t("ownUsage.loadFailed")}</LoadError>
        ) : !usage ? (
          <SkeletonList rows={2} />
        ) : usage.currency === undefined ? (
          <p className="text-sm text-muted-foreground">{t("limits.notPriced")}</p>
        ) : (
          <List data-testid="own-usage">
            {PERIODS.map(({ period, label, reset }) => (
              <OwnUsageRow
                key={period}
                label={t(label)}
                state={usage.own[period]}
                currency={usage.currency ?? ""}
                locale={locale}
                reset={t(reset)}
              />
            ))}
          </List>
        )}
        <p className="text-caption text-muted-foreground">{t("ownUsage.otherLevels")}</p>
      </Section>
    </>
  );
}

function OwnUsageRow({
  label,
  state,
  currency,
  locale,
  reset
}: {
  label: string;
  state: UsageSpendPeriod;
  currency: string;
  locale: string;
  reset: string;
}) {
  const { t } = useTranslation();
  const spent = formatSpend(state.spent ?? 0, currency, locale);
  // The bar runs to what admission holds the person to, so it is full when the limit stops them.
  const held = state.left === undefined ? state.limit : (state.spent ?? 0) + state.left;
  const amount =
    state.limit === undefined
      ? t("ownUsage.spentNoLimit", { spent })
      : t("ownUsage.spentOf", { spent, limit: formatSpend(state.limit, currency, locale) });
  return (
    <ListRow
      data-testid="own-usage-period"
      title={label}
      descriptionWraps
      description={
        <>
          <span className="block">{amount}</span>
          {state.reached ? (
            <span className="block text-destructive">{t("ownUsage.reached", { reset })}</span>
          ) : null}
          {held === undefined ? null : (
            <Progress
              className="mt-2"
              size="sm"
              label={label}
              max={held}
              value={state.reached ? held : Math.min(state.spent ?? 0, held)}
              tone={
                state.reached
                  ? "danger"
                  : state.left !== undefined && nearLimit(state.spent ?? 0, state.left)
                    ? "warning"
                    : "neutral"
              }
            />
          )}
        </>
      }
    />
  );
}
