import { useState } from "react";
import {
  ApiError,
  type SetUsageSpendLimitRequest,
  type UsageLimits,
  type UsageSpendAmountsInput,
  type UsageSpendLimitOverride
} from "@work-shape/catalyst-api-client";
import {
  Button,
  EmptyState,
  Field,
  Input,
  List,
  ListRow,
  LoadError,
  PageHeader,
  Section,
  Select,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { formatSpend } from "../../../chat/workspace/usage-limit-block";
import { useSetUsageLimitMutation, useUsageLimitsQuery } from "../../../shared/api/usage-limits";
import { useTranslation } from "../../../shared/i18n";
import { useSettingsPage } from "../../../shared/settings-page-context";

type Change = SetUsageSpendLimitRequest;

/** Which editor a change came from: its level and, for one workspace or user, its target. */
const editorKey = (change: Pick<Change, "level" | "target">) =>
  `${change.level}:${change.target ?? ""}`;

/**
 * Settings > Instance > Limits (LU-2, limits spec 3.1): the spend limits of the instance, of
 * shared workspaces and of users, each per day and per month, and who is near one. Every change
 * goes through `usage.limits.set`, which requires `limits.manage` and records the change in the
 * audit log; it applies from the next message.
 */
export function LimitsPage() {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const limits = useUsageLimitsQuery({ apiBaseUrl, authScope, client });
  const set = useSetUsageLimitMutation({
    apiBaseUrl,
    authScope,
    client,
    heldMessage: t("limits.saveFailed")
  });
  const [saved, setSaved] = useState<string | undefined>();

  return (
    <LimitsView
      limits={limits.data}
      failed={limits.isError}
      onRetry={() => {
        limits.refetch().catch(() => undefined);
      }}
      pending={set.isPending ? editorKey(set.variables) : undefined}
      failure={set.isError ? { key: editorKey(set.variables), error: set.error } : undefined}
      saved={saved}
      onChange={(change) => {
        setSaved(undefined);
        set.mutate(change, { onSuccess: () => setSaved(editorKey(change)) });
      }}
    />
  );
}

function LimitsView({
  limits,
  failed,
  onRetry,
  pending,
  failure,
  saved,
  onChange
}: {
  limits: UsageLimits | undefined;
  failed: boolean;
  onRetry(): void;
  /** The editor whose change is on its way. */
  pending?: string;
  /** The editor whose last change was refused, and why. */
  failure?: { key: string; error: unknown };
  /** The editor whose last change was saved. */
  saved?: string;
  onChange(change: Change): void;
}) {
  const { t, locale } = useTranslation();
  if (failed) {
    return (
      <>
        <PageHeader title={t("settings.limits")} description={t("limits.description")} />
        <LoadError onRetry={onRetry}>{t("limits.loadFailed")}</LoadError>
      </>
    );
  }
  if (!limits) {
    return (
      <>
        <PageHeader title={t("settings.limits")} description={t("limits.description")} />
        <SkeletonList rows={4} />
      </>
    );
  }
  const currency = limits.currency;
  const money = (amount: number | undefined) =>
    amount === undefined
      ? t("limits.noLimit")
      : currency === undefined
        ? String(amount)
        : formatSpend(amount, currency, locale);
  const stateOf = (change: Pick<Change, "level" | "target">) => {
    const key = editorKey(change);
    return {
      pending: pending === key,
      saved: saved === key,
      error: failure?.key === key ? refusalText(failure.error, t, money) : undefined
    };
  };
  const ceiling = limits.ceiling;

  return (
    <>
      <PageHeader title={t("settings.limits")} description={t("limits.description")} />
      {currency === undefined ? (
        <p className="text-sm text-muted-foreground">{t("limits.notPriced")}</p>
      ) : null}

      <Section
        layout="stacked"
        title={t("limits.instance")}
        description={t("limits.instanceDescription")}
      >
        <p className="text-caption text-muted-foreground" data-testid="limits-ceiling">
          {ceiling.daily === undefined
            ? ceiling.monthly === undefined
              ? t("limits.ceilingNone")
              : t("limits.ceilingMonthly", { monthly: money(ceiling.monthly) })
            : ceiling.monthly === undefined
              ? t("limits.ceilingDaily", { daily: money(ceiling.daily) })
              : t("limits.ceiling", {
                  daily: money(ceiling.daily),
                  monthly: money(ceiling.monthly)
                })}
        </p>
        <LimitEditor
          label={t("limits.instance")}
          value={limits.instance}
          {...stateOf({ level: "instance" })}
          onSave={(next) => onChange({ level: "instance", limits: next })}
        />
        <p className="text-caption text-muted-foreground" data-testid="limits-in-force">
          {t("limits.inForce", {
            daily: money(limits.effectiveInstance.daily),
            monthly: money(limits.effectiveInstance.monthly)
          })}
        </p>
      </Section>

      <Section
        layout="stacked"
        title={t("limits.workspaces")}
        description={t("limits.workspacesDescription")}
      >
        <LimitEditor
          label={t("limits.workspaceDefault")}
          value={limits.workspaceDefault}
          {...stateOf({ level: "workspace_default" })}
          onSave={(next) => onChange({ level: "workspace_default", limits: next })}
        />
        <Overrides
          level="workspace"
          pickLabel={t("limits.pickWorkspace")}
          overrides={limits.workspaces}
          options={limits.workspaceOptions}
          stateOf={stateOf}
          onChange={onChange}
        />
      </Section>

      <Section
        layout="stacked"
        title={t("limits.users")}
        description={t("limits.usersDescription")}
      >
        <LimitEditor
          label={t("limits.userDefault")}
          value={limits.userDefault}
          {...stateOf({ level: "user_default" })}
          onSave={(next) => onChange({ level: "user_default", limits: next })}
        />
        <Overrides
          level="user"
          pickLabel={t("limits.pickUser")}
          overrides={limits.users}
          options={limits.userOptions}
          stateOf={stateOf}
          onChange={onChange}
        />
      </Section>

      <Section
        layout="stacked"
        title={t("limits.near")}
        description={t("limits.nearDescription")}
        count={limits.nearLimit.length}
      >
        {limits.nearLimit.length === 0 ? (
          <EmptyState layout="inline">{t("limits.nearEmpty")}</EmptyState>
        ) : (
          <List data-testid="limits-near">
            {limits.nearLimit.map((near) => (
              <ListRow
                key={`${near.kind}:${near.id}:${near.period}`}
                title={near.name ?? near.id}
                description={t("limits.nearRow", {
                  percent: near.percent,
                  period: t(near.period === "day" ? "limits.periodDay" : "limits.periodMonth"),
                  limit: money(near.limit)
                })}
              />
            ))}
          </List>
        )}
      </Section>
    </>
  );
}

interface EditorState {
  pending: boolean;
  saved: boolean;
  error: string | undefined;
}

/** The values of one workspace or one user, and the way to add one. */
function Overrides({
  level,
  pickLabel,
  overrides,
  options,
  stateOf,
  onChange
}: {
  level: Extract<Change["level"], "workspace" | "user">;
  pickLabel: string;
  overrides: readonly UsageSpendLimitOverride[];
  options: readonly { id: string; name: string }[];
  stateOf(change: Pick<Change, "level" | "target">): EditorState;
  onChange(change: Change): void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState("");
  const free = options.filter((option) => !overrides.some((entry) => entry.id === option.id));
  return (
    <>
      {overrides.map((entry) => (
        <LimitEditor
          key={entry.id}
          label={entry.name ?? t("limits.unknownTarget")}
          value={entry}
          removable
          {...stateOf({ level, target: entry.id })}
          onSave={(next) => onChange({ level, target: entry.id, limits: next })}
        />
      ))}
      {free.length === 0 ? null : (
        <div className="grid gap-3">
          <Field label={pickLabel}>
            <Select value={picked} onChange={(event) => setPicked(event.target.value)}>
              <option value="">{t("limits.pickPlaceholder")}</option>
              {free.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>
          {picked === "" ? null : (
            <LimitEditor
              key={picked}
              label={free.find((option) => option.id === picked)?.name ?? picked}
              value={undefined}
              {...stateOf({ level, target: picked })}
              onSave={(next) => {
                if (next) onChange({ level, target: picked, limits: next });
                setPicked("");
              }}
            />
          )}
        </div>
      )}
    </>
  );
}

const asText = (amount: number | undefined) => (amount === undefined ? "" : String(amount));

/** An amount as typed: empty is no limit; anything that is no amount is refused here. */
function parseAmount(text: string): number | undefined | null {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return undefined;
  const amount = Number(trimmed);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/**
 * One level's limit per day and per month. Saving both empty removes the value, so the
 * default or no limit applies again.
 */
function LimitEditor({
  label,
  value,
  removable = false,
  pending,
  saved,
  error,
  onSave
}: {
  label: string;
  value: UsageSpendAmountsInput | undefined;
  /** A value of one workspace or user, which is removed rather than emptied. */
  removable?: boolean;
  onSave(next: UsageSpendAmountsInput | null): void;
} & EditorState) {
  const { t } = useTranslation();
  const [daily, setDaily] = useState(asText(value?.daily));
  const [monthly, setMonthly] = useState(asText(value?.monthly));
  const dailyAmount = parseAmount(daily);
  const monthlyAmount = parseAmount(monthly);
  const invalid = dailyAmount === null || monthlyAmount === null;
  const changed = daily !== asText(value?.daily) || monthly !== asText(value?.monthly);
  const next: UsageSpendAmountsInput | null =
    dailyAmount == null && monthlyAmount == null
      ? null
      : {
          ...(dailyAmount == null ? {} : { daily: dailyAmount }),
          ...(monthlyAmount == null ? {} : { monthly: monthlyAmount })
        };

  return (
    <div className="grid gap-3" data-testid="limit-editor" data-label={label}>
      <p className="text-label">{label}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("limits.daily")} hint={t("limits.emptyMeansNone")}>
          <Input
            inputMode="decimal"
            value={daily}
            invalid={dailyAmount === null}
            onChange={(event) => setDaily(event.target.value)}
          />
        </Field>
        <Field label={t("limits.monthly")} hint={t("limits.emptyMeansNone")}>
          <Input
            inputMode="decimal"
            value={monthly}
            invalid={monthlyAmount === null}
            onChange={(event) => setMonthly(event.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!changed || invalid || pending}
          onClick={() => onSave(next)}
        >
          {t("limits.save")}
        </Button>
        {removable && value ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => onSave(null)}>
            {t("limits.remove")}
          </Button>
        ) : null}
        {error ? (
          <span role="alert" className="text-caption text-destructive">
            {error}
          </span>
        ) : saved && !changed ? (
          <span role="status" className="text-caption text-muted-foreground">
            {t("limits.saved")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Why a change was refused, in the person's language. */
function refusalText(
  error: unknown,
  t: ReturnType<typeof useTranslation>["t"],
  money: (amount: number | undefined) => string
): string {
  if (error instanceof ApiError) {
    const details = detailsOf(error.payload);
    if (details?.reason === "above_ceiling" && typeof details.ceiling === "number") {
      return t("limits.aboveCeiling", { ceiling: money(details.ceiling) });
    }
  }
  return t("limits.saveFailed");
}

function detailsOf(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  const details = payload.error.details;
  return isRecord(details) ? details : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
