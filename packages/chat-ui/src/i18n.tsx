import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { LocaleCode } from "@vivd-catalyst/api-client";
import { translations, type TranslationKey } from "./i18n/translations";

export type { TranslationKey };

type TranslationValues = Record<string, string | number>;

export interface TranslationContextValue {
  locale: LocaleCode;
  t(key: TranslationKey, values?: TranslationValues): string;
  localeName(locale: LocaleCode): string;
}

const defaultTranslationContext = createTranslationContext("en");
const TranslationContext = createContext<TranslationContextValue>(defaultTranslationContext);

export function TranslationProvider({
  locale,
  children
}: {
  locale: LocaleCode;
  children: ReactNode;
}) {
  const value = useMemo(() => createTranslationContext(locale), [locale]);
  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useTranslation(): TranslationContextValue {
  return useContext(TranslationContext);
}

function normalizeUiLocale(value: string | undefined): LocaleCode | undefined {
  const locale = value?.trim().toLowerCase().replace(/_/gu, "-").split("-")[0];
  return locale === "en" || locale === "de" ? locale : undefined;
}

export function readBrowserLocale(): LocaleCode | undefined {
  for (const language of window.navigator.languages ?? [window.navigator.language]) {
    const locale = normalizeUiLocale(language);
    if (locale) {
      return locale;
    }
  }
  return undefined;
}

export function createTranslationContext(locale: LocaleCode): TranslationContextValue {
  return {
    locale,
    t(key, values) {
      return interpolate(translations[locale][key] ?? translations.en[key], values);
    },
    localeName(targetLocale) {
      return translations[locale][`locale${targetLocale === "de" ? "De" : "En"}`];
    }
  };
}

function interpolate(message: string, values: TranslationValues | undefined): string {
  if (!values) {
    return message;
  }

  // A function as the replacement keeps "$&" and similar sequences in a value as plain text.
  return Object.entries(values).reduce(
    (currentMessage, [name, value]) => currentMessage.replaceAll(`{${name}}`, () => String(value)),
    message
  );
}
