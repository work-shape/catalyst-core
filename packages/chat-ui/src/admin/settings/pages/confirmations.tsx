import type { OperationSetting, PersonPolicySettingValue } from "@work-shape/catalyst-api-client";
import {
  EmptyState,
  List,
  ListRow,
  LoadError,
  PageHeader,
  Section,
  Select,
  SkeletonList
} from "@work-shape/catalyst-ui";
import {
  useOwnOperationSettingsQuery,
  useSetOwnOperationSettingMutation
} from "../../../shared/api/operation-settings";
import { useTranslation, type TranslationKey } from "../../../shared/i18n";
import { useSettingsPage } from "../../../shared/settings-page-context";

/** The administrator's setting: the person set nothing for the action. */
const DEFAULT = "default";
type Choice = PersonPolicySettingValue | typeof DEFAULT;

const choiceLabels: Record<Choice, TranslationKey> = {
  default: "confirm.default",
  always_allow: "confirm.alwaysAllow",
  ask: "confirm.askMe",
  never: "confirm.never"
};

/**
 * You > Confirmations (OP-6): per action Always allow, Ask me or Never, for the calls the
 * person's own agents make, in chat and in scheduled runs. The list holds the actions the
 * person set, and those their agents called lately. Each choice applies at once.
 */
export function ConfirmationsPage() {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const settings = useOwnOperationSettingsQuery({ apiBaseUrl, authScope, client });
  const set = useSetOwnOperationSettingMutation({
    apiBaseUrl,
    authScope,
    client,
    heldMessage: t("confirm.saveFailed")
  });
  // The choice shows at once; the server's answer replaces it.
  const pending = set.isPending ? set.variables : undefined;

  return (
    <ConfirmationsView
      items={settings.data?.items}
      loading={settings.isPending}
      failed={settings.isError}
      onRetry={() => {
        settings.refetch().catch(() => undefined);
      }}
      saving={pending}
      saveFailed={set.isError ? set.variables.operation : undefined}
      onChange={(operation, value) => set.mutate({ operation, value })}
    />
  );
}

function ConfirmationsView({
  items,
  loading,
  failed,
  onRetry,
  saving,
  saveFailed,
  onChange
}: {
  items: readonly OperationSetting[] | undefined;
  loading: boolean;
  failed: boolean;
  onRetry(): void;
  saving?: { operation: string; value: PersonPolicySettingValue | null };
  /** The action whose last choice was not saved. */
  saveFailed?: string;
  onChange(operation: string, value: PersonPolicySettingValue | null): void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("settings.confirmations")} description={t("confirm.description")} />
      <Section layout="stacked" title={t("confirm.actions")} count={items?.length}>
        {failed ? (
          <LoadError onRetry={onRetry}>{t("confirm.listFailed")}</LoadError>
        ) : loading || !items ? (
          <SkeletonList rows={3} />
        ) : items.length === 0 ? (
          <EmptyState layout="inline">{t("confirm.empty")}</EmptyState>
        ) : (
          <List data-testid="confirmation-settings">
            {items.map((item) => (
              <ConfirmationRow
                key={item.operation}
                item={item}
                shown={saving?.operation === item.operation ? saving.value : item.value}
                failed={saveFailed === item.operation}
                onChange={(value) => onChange(item.operation, value)}
              />
            ))}
          </List>
        )}
      </Section>
    </>
  );
}

function ConfirmationRow({
  item,
  shown,
  failed,
  onChange
}: {
  item: OperationSetting;
  shown: PersonPolicySettingValue | null | undefined;
  failed: boolean;
  onChange(value: PersonPolicySettingValue | null): void;
}) {
  const { t } = useTranslation();
  const choice: Choice = shown ?? DEFAULT;
  // Always allow stays listed where the person chose it before, so the row says what holds.
  const choices: Choice[] = [
    DEFAULT,
    ...(item.mayAlwaysAllow || choice === "always_allow" ? (["always_allow"] as const) : []),
    "ask",
    "never"
  ];
  const label = item.title ?? item.operation;
  const note = item.alwaysAllowLocked
    ? t("confirm.lockedByAdmin")
    : item.effect === "changing" && !item.mayAlwaysAllow
      ? t("confirm.notReversible")
      : undefined;
  return (
    <ListRow
      data-testid="confirmation-setting"
      data-operation={item.operation}
      data-locked={item.alwaysAllowLocked ? "" : undefined}
      title={label}
      descriptionWraps
      description={
        <>
          {/* An action without a title of its own is named by its name alone. */}
          {item.title ? <span className="block font-mono">{item.operation}</span> : null}
          {note ? <span className="block">{note}</span> : null}
          {failed ? (
            <span role="alert" className="block text-destructive">
              {t("confirm.saveFailed")}
            </span>
          ) : null}
        </>
      }
      actionsVisible
      actions={
        <Select
          size="sm"
          className="w-40 sm:w-60"
          aria-label={t("confirm.valueFor", { action: label })}
          value={choice}
          onChange={(event) => {
            const next = choices.find((value) => value === event.target.value);
            if (next) onChange(next === DEFAULT ? null : next);
          }}
        >
          {choices.map((value) => (
            <option
              key={value}
              value={value}
              disabled={value === "always_allow" && !item.mayAlwaysAllow}
            >
              {t(choiceLabels[value])}
            </option>
          ))}
        </Select>
      }
    />
  );
}
