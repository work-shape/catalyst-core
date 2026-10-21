import type { FollowUpMode, LocaleCode } from "@work-shape/catalyst-api-client";
import {
  Field,
  PageHeader,
  Section,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  Switch
} from "@work-shape/catalyst-ui";
import { useUpdateCurrentUserMutation } from "../../../shared/api/workspace-mutations";
import { useTranslation, type TranslationKey } from "../../../shared/i18n";
import type { ThemeModePreference } from "../../../shared/theme";
import { otherShortcutKeys } from "../../../chat/assistant/follow-up-shortcut";
import {
  useSettingsPage,
  type SettingsPageContextValue
} from "../../../shared/settings-page-context";

const followUpChoices: readonly { value: FollowUpMode; labelKey: TranslationKey }[] = [
  { value: "queue", labelKey: "followUpModeQueue" },
  { value: "steer", labelKey: "followUpModeSteer" }
];

const themeChoices: readonly { value: ThemeModePreference; labelKey: TranslationKey }[] = [
  { value: "light", labelKey: "settings.themeLight" },
  { value: "dark", labelKey: "settings.themeDark" },
  { value: "system", labelKey: "settings.themeSystem" }
];

/**
 * You > Language and appearance: the language, the theme and what the chat shows. Each choice
 * applies at once, so the page has no Save. What Enter does during a run is kept with the
 * account, the same on every device (FU-2); the rest is kept in this browser.
 */
export function LanguageAppearancePage() {
  const { t } = useTranslation();
  const {
    apiBaseUrl,
    authScope,
    client,
    user,
    locales,
    locale,
    selectLocale,
    themePreference,
    selectThemePreference,
    showContextIndicator,
    setShowContextIndicator
  } = useSettingsPage();
  const update = useUpdateCurrentUserMutation({ apiBaseUrl, authScope, client, userId: user.id });
  // The choice shows at once; the account's answer replaces it.
  const followUpMode = update.isPending
    ? (update.variables.followUpMode ?? user.followUpMode)
    : user.followUpMode;

  return (
    <LanguageAppearanceView
      followUpMode={followUpMode ?? "queue"}
      selectFollowUpMode={(mode) => update.mutate({ followUpMode: mode })}
      followUpModeError={update.isError ? t("followUpModeNotSaved") : undefined}
      locales={locales}
      locale={locale}
      selectLocale={selectLocale}
      themePreference={themePreference}
      selectThemePreference={selectThemePreference}
      showContextIndicator={showContextIndicator}
      setShowContextIndicator={setShowContextIndicator}
    />
  );
}

export function LanguageAppearanceView({
  locales,
  locale,
  selectLocale,
  themePreference,
  selectThemePreference,
  showContextIndicator,
  setShowContextIndicator,
  followUpMode,
  selectFollowUpMode,
  followUpModeError
}: {
  /** What Enter does during the person's run; the row shows only where it can be saved. */
  followUpMode?: FollowUpMode;
  selectFollowUpMode?: (mode: FollowUpMode) => void;
  followUpModeError?: string;
} & Pick<
  SettingsPageContextValue,
  | "locales"
  | "locale"
  | "selectLocale"
  | "themePreference"
  | "selectThemePreference"
  | "showContextIndicator"
  | "setShowContextIndicator"
>) {
  const { t, localeName } = useTranslation();

  return (
    <>
      <PageHeader title={t("settings.languageAppearance")} />
      <Section layout="stacked" title={t("language")}>
        <Select
          className="max-w-xs"
          aria-label={t("language")}
          value={locale}
          onChange={(event) => {
            const next = locales.find((candidate) => candidate === event.currentTarget.value);
            if (next) {
              selectLocale(next);
            }
          }}
        >
          {locales.map((candidate: LocaleCode) => (
            <option key={candidate} value={candidate}>
              {localeName(candidate)}
            </option>
          ))}
        </Select>
      </Section>
      <Section layout="stacked" title={t("settings.appearance")}>
        <div className="grid justify-items-start gap-2">
          <span className="text-label">{t("settings.theme")}</span>
          <SegmentedControl
            label={t("settings.theme")}
            value={themePreference}
            onValueChange={(value) => {
              const next = themeChoices.find((choice) => choice.value === value);
              if (next) {
                selectThemePreference(next.value);
              }
            }}
          >
            {themeChoices.map((choice) => (
              <SegmentedControlItem key={choice.value} value={choice.value}>
                {t(choice.labelKey)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
      </Section>
      <Section layout="stacked" title={t("chatDisplay")}>
        <Field
          layout="inline"
          label={t("contextIndicator")}
          hint={t("contextIndicatorDescription")}
        >
          <Switch checked={showContextIndicator} onCheckedChange={setShowContextIndicator} />
        </Field>
        {selectFollowUpMode ? (
          <Field
            layout="stacked"
            label={t("followUpMode")}
            hint={t("followUpModeDescription", { keys: otherShortcutKeys() })}
            error={followUpModeError}
          >
            <SegmentedControl
              label={t("followUpMode")}
              value={followUpMode ?? "queue"}
              onValueChange={(value) => {
                const next = followUpChoices.find((choice) => choice.value === value);
                if (next) {
                  selectFollowUpMode(next.value);
                }
              }}
            >
              {followUpChoices.map((choice) => (
                <SegmentedControlItem key={choice.value} value={choice.value}>
                  {t(choice.labelKey)}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </Field>
        ) : null}
      </Section>
    </>
  );
}
