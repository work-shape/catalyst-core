import { Fragment, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Infrastructure,
  InfrastructureCheck,
  InfrastructureClass,
  InfrastructureProvider
} from "@vivd-catalyst/api-client";
import {
  Badge,
  Banner,
  Button,
  PageHeader,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableCellDetail,
  TableHead,
  TableHeader,
  TableRow,
  type BadgeTone
} from "@vivd-catalyst/ui";
import { formatTime } from "../../control-plane/locale-format";
import { useTranslation, type TranslationKey } from "../../i18n";
import { OperatorManaged } from "../operator-managed";
import { useSettingsPage } from "../settings-page-context";

/**
 * How often the page reads again while it is open. A read answers from the instance's last
 * checks and asks no provider, so this costs the providers nothing.
 */
const INFRASTRUCTURE_REFRESH_MS = 30_000;

/** The classes in the order the page lists them, with their names. */
const classes: readonly { id: InfrastructureClass; labelKey: TranslationKey }[] = [
  { id: "database", labelKey: "infrastructure.classDatabase" },
  { id: "models", labelKey: "infrastructure.classModels" },
  { id: "objectStorage", labelKey: "infrastructure.classObjectStorage" },
  { id: "mail", labelKey: "infrastructure.classMail" },
  { id: "sandbox", labelKey: "infrastructure.classSandbox" },
  { id: "secrets", labelKey: "infrastructure.classSecrets" }
];

type CheckStatus = InfrastructureCheck["status"];
const checkLabelKeys: Record<CheckStatus, TranslationKey> = {
  ok: "infrastructure.checkOk",
  failed: "infrastructure.checkFailed",
  pending: "infrastructure.checkPending",
  not_checked: "infrastructure.checkNotChecked"
};
const checkTones: Record<CheckStatus, BadgeTone> = {
  ok: "success",
  failed: "danger",
  pending: "neutral",
  not_checked: "neutral"
};

type ErrorClass = Extract<InfrastructureCheck, { status: "failed" }>["errorClass"];
/** What the page says about a failed check. The provider's own words never reach it. */
const errorKeys: Record<ErrorClass, TranslationKey> = {
  unreachable: "infrastructure.errorUnreachable",
  timeout: "infrastructure.errorTimeout",
  access_denied: "infrastructure.errorAccessDenied",
  not_found: "infrastructure.errorNotFound",
  bucket_missing: "infrastructure.errorBucketMissing",
  rejected: "infrastructure.errorRejected",
  failed: "infrastructure.errorFailed"
};

/**
 * Instance > Infrastructure: what the instance runs on and whether each provider answers. The
 * providers are release config, so the page changes none of them.
 */
export function InfrastructurePage() {
  const { t, locale } = useTranslation();
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const queryClient = useQueryClient();
  const queryKey = ["instance-infrastructure", apiBaseUrl, authScope];
  const infrastructureQuery = useQuery({
    queryKey,
    queryFn: () => client.instance.infrastructure.get(),
    refetchInterval: INFRASTRUCTURE_REFRESH_MS
  });
  const check = useMutation({
    mutationFn: () => client.instance.infrastructure.check(),
    onSuccess: (checked) => queryClient.setQueryData<Infrastructure>(queryKey, checked),
    // Refused inside the minute of another person's check: the read says from when it runs.
    onError: () => queryClient.invalidateQueries({ queryKey })
  });
  const infrastructure = infrastructureQuery.data;
  const waitUntil = useFutureMoment(infrastructure?.checkAvailableAt);

  return (
    <>
      <PageHeader
        title={t("settings.infrastructure")}
        description={
          infrastructure
            ? t("infrastructure.description", {
                minutes: Math.round(infrastructure.checkIntervalSeconds / 60).toLocaleString(locale)
              })
            : undefined
        }
        secondaryActions={
          <Button
            variant="secondary"
            size="sm"
            loading={check.isPending}
            disabled={!infrastructure || waitUntil !== undefined}
            onClick={() => check.mutate()}
          >
            {t("infrastructure.checkNow")}
          </Button>
        }
      />
      <div className="grid gap-4">
        <OperatorManaged>{t("infrastructure.operatorManaged")}</OperatorManaged>
        {waitUntil ? (
          <Banner layout="line" data-check-wait="">
            {t("infrastructure.checkNowWait", { time: formatTime(waitUntil, locale) })}
          </Banner>
        ) : check.error ? (
          <Banner tone="danger">{t("infrastructure.checkNowFailed")}</Banner>
        ) : null}
        {infrastructure ? (
          <>
            {infrastructureQuery.error ? (
              <Banner tone="danger">{t("infrastructure.refreshFailed")}</Banner>
            ) : null}
            <ProviderTable providers={infrastructure.items} />
          </>
        ) : infrastructureQuery.error ? (
          <Banner tone="danger">{t("infrastructure.loadFailed")}</Banner>
        ) : (
          <SkeletonList rows={5} />
        )}
      </div>
    </>
  );
}

/** A moment while it lies ahead, and nothing from then on. */
function useFutureMoment(moment: string | undefined): string | undefined {
  const [, setPassed] = useState<string>();
  const remainingMs = moment === undefined ? 0 : new Date(moment).getTime() - Date.now();
  useEffect(() => {
    if (moment === undefined || remainingMs <= 0) {
      return;
    }
    const timer = setTimeout(() => setPassed(moment), remainingMs);
    return () => clearTimeout(timer);
  }, [moment, remainingMs]);
  return remainingMs > 0 ? moment : undefined;
}

const COLUMN_COUNT = 5;

function ProviderTable({ providers }: { providers: readonly InfrastructureProvider[] }) {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("infrastructure.provider")}</TableHead>
          <TableHead>{t("infrastructure.region")}</TableHead>
          <TableHead>{t("infrastructure.destination")}</TableHead>
          <TableHead>{t("infrastructure.secrets")}</TableHead>
          <TableHead>{t("infrastructure.health")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {classes.map(({ id, labelKey }) => {
          const ofClass = providers.filter((provider) => provider.class === id);
          if (ofClass.length === 0) {
            return null;
          }
          return (
            <Fragment key={id}>
              <TableRow data-infrastructure-class={id}>
                <TableHead colSpan={COLUMN_COUNT} scope="colgroup" className="text-foreground">
                  {t(labelKey)}
                </TableHead>
              </TableRow>
              {ofClass.map((provider) => (
                <ProviderRow key={provider.id} provider={provider} />
              ))}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ProviderRow({ provider }: { provider: InfrastructureProvider }) {
  const { t } = useTranslation();
  return (
    <TableRow data-provider={provider.id} data-origin={provider.origin}>
      <TableCell className="font-mono">
        {provider.name ?? provider.type}
        {provider.name === undefined ? null : <TableCellDetail>{provider.type}</TableCellDetail>}
      </TableCell>
      <TableCell>
        {provider.region === undefined ? (
          <span className="text-muted-foreground">{t("infrastructure.regionInside")}</span>
        ) : (
          t(provider.region === "eu" ? "infrastructure.regionEu" : "infrastructure.regionGlobal")
        )}
      </TableCell>
      <TableCell>
        <Destination provider={provider} />
      </TableCell>
      <TableCell>
        {provider.secrets.length === 0 ? (
          <span className="text-muted-foreground">{t("infrastructure.noSecrets")}</span>
        ) : (
          <ul className="grid gap-1">
            {provider.secrets.map((secret) => (
              <li
                key={secret.name ?? secret.field}
                className="flex flex-wrap items-center gap-2"
                data-secret-field={secret.name === undefined ? secret.field : undefined}
              >
                <span className="font-mono whitespace-nowrap">{secret.name ?? secret.field}</span>
                <Badge tone={secret.state === "set" ? "neutral" : "danger"} size="sm">
                  {t(
                    secret.state === "set"
                      ? "infrastructure.secretSet"
                      : "infrastructure.secretMissing"
                  )}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </TableCell>
      <TableCell>
        <Health check={provider.check} />
      </TableCell>
    </TableRow>
  );
}

/** The host and the bucket. A value the instance withholds is named as not shown. */
function Destination({ provider }: { provider: InfrastructureProvider }) {
  const { t } = useTranslation();
  const withheld = new Set(provider.withheld);
  const host = withheld.has("endpointHost") ? t("infrastructure.notShown") : provider.endpointHost;
  const bucket = withheld.has("bucket") ? t("infrastructure.notShown") : provider.bucket;
  if (host === undefined && bucket === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <>
      {host === undefined ? null : (
        <span
          className={withheld.has("endpointHost") ? undefined : "font-mono whitespace-nowrap"}
          data-withheld={withheld.has("endpointHost") ? "endpointHost" : undefined}
        >
          {host}
        </span>
      )}
      {bucket === undefined ? null : (
        <TableCellDetail data-withheld={withheld.has("bucket") ? "bucket" : undefined}>
          {t("infrastructure.bucket", { bucket })}
        </TableCellDetail>
      )}
    </>
  );
}

function Health({ check }: { check: InfrastructureCheck }) {
  const { t, locale } = useTranslation();
  const checkedAt =
    check.status === "ok" || check.status === "failed" ? check.checkedAt : undefined;
  return (
    <div data-check={check.status} data-checked-at={checkedAt}>
      <Badge tone={checkTones[check.status]} dot>
        {t(checkLabelKeys[check.status])}
      </Badge>
      {check.status === "failed" ? (
        <TableCellDetail className="mt-1" data-error-class={check.errorClass}>
          {t(errorKeys[check.errorClass])}
        </TableCellDetail>
      ) : null}
      {check.status === "not_checked" ? (
        <TableCellDetail className="mt-1">
          {t("infrastructure.checkNotCheckedDetail")}
        </TableCellDetail>
      ) : null}
      {checkedAt === undefined ? null : (
        <TableCellDetail className="mt-1">
          {t("infrastructure.checkedAt", { time: formatTime(checkedAt, locale) })}
        </TableCellDetail>
      )}
    </div>
  );
}
