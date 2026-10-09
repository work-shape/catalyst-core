import type { LocaleCode } from "@vivd-catalyst/api-client";
import {
  Field,
  PageHeader,
  Section,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  Switch
} from "@vivd-catalyst/ui";
import { useTranslation, type TranslationKey } from "../../i18n";
import type { ThemeModePreference } from "../../theme";
import { useSettingsPage, type SettingsPageContextValue } from "../settings-page-context";

const themeChoices: readonly { value: ThemeModePreference; labelKey: TranslationKey }[] = [
  { value: "light", labelKey: "settings.themeLight" },
  { value: "dark", labelKey: "settings.themeDark" },
  { value: "system", labelKey: "settings.themeSystem" }
];

/**
 * You > Language and appearance: the language, the theme and what the chat shows. Each choice
 * is kept in this browser and applies at once, so the page has no Save.
 */
export function LanguageAppearancePage() {
  const {
    locales,
    locale,
    selectLocale,
    themePreference,
    selectThemePreference,
    showContextIndicator,
    setShowContextIndicator
  } = useSettingsPage();

  return (
    <LanguageAppearanceView
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
  setShowContextIndicator
}: Pick<
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
      </Section>
    </>
  );
}
