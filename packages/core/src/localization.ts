export const localeCodes = ["en", "de"] as const;

export type LocaleCode = (typeof localeCodes)[number];

export type LocalizedStringConfig =
  | string
  | {
      en?: string;
      de?: string;
    };

export interface LocalizationConfig {
  defaultLocale: LocaleCode;
  supportedLocales: LocaleCode[];
}

const localeCodeSet = new Set<string>(localeCodes);

export function isLocaleCode(value: string): value is LocaleCode {
  return localeCodeSet.has(value);
}

export function normalizeLocaleCode(value: string | undefined): LocaleCode | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/_/gu, "-");
  const base = normalized.split("-")[0];
  return base && isLocaleCode(base) ? base : undefined;
}

export function resolveLocalePreference(input: {
  requestedLocale?: string;
  acceptLanguageHeader?: string | string[];
  defaultLocale: LocaleCode;
  supportedLocales: LocaleCode[];
}): LocaleCode {
  const supportedLocales = new Set(input.supportedLocales);
  const requestedLocale = normalizeLocaleCode(input.requestedLocale);
  if (requestedLocale && supportedLocales.has(requestedLocale)) {
    return requestedLocale;
  }

  for (const acceptedLocale of parseAcceptLanguageHeader(input.acceptLanguageHeader)) {
    const locale = normalizeLocaleCode(acceptedLocale);
    if (locale && supportedLocales.has(locale)) {
      return locale;
    }
  }

  return input.defaultLocale;
}

function parseAcceptLanguageHeader(value: string | string[] | undefined): string[] {
  const header = Array.isArray(value) ? value.join(",") : value;
  if (!header) {
    return [];
  }

  return header
    .split(",")
    .map((part) => {
      const [locale, ...parameters] = part.trim().split(";");
      const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
      const quality = qualityParameter ? Number(qualityParameter.split("=")[1]) : 1;
      return {
        locale,
        quality: Number.isFinite(quality) ? quality : 0
      };
    })
    .filter((entry): entry is { locale: string; quality: number } => Boolean(entry.locale))
    .sort((left, right) => right.quality - left.quality)
    .map((entry) => entry.locale);
}
