import { z } from "zod";
import {
  localeCodes,
  resolveLocalePreference,
  type LocaleCode,
  type LocalizationConfig,
  type LocalizedStringConfig
} from "@agent-chat-platform/core";

export const localeCodeSchema = z.enum(localeCodes);

export const localizationConfigSchema = z
  .object({
    defaultLocale: localeCodeSchema.default("en"),
    supportedLocales: z.array(localeCodeSchema).min(1).default(["en", "de"])
  })
  .default({
    defaultLocale: "en",
    supportedLocales: ["en", "de"]
  })
  .superRefine((config, context) => {
    if (!config.supportedLocales.includes(config.defaultLocale)) {
      context.addIssue({
        code: "custom",
        path: ["defaultLocale"],
        message: "defaultLocale must be included in supportedLocales"
      });
    }

    if (new Set(config.supportedLocales).size !== config.supportedLocales.length) {
      context.addIssue({
        code: "custom",
        path: ["supportedLocales"],
        message: "supportedLocales must not contain duplicates"
      });
    }
  });

const localizedStringMapSchema = z
  .object({
    en: z.string().min(1).optional(),
    de: z.string().min(1).optional()
  })
  .strict()
  .refine((value) => value.en !== undefined || value.de !== undefined, {
    message: "At least one localized value is required"
  });

export const localizedStringSchema = z.union([z.string().min(1), localizedStringMapSchema]);

export interface ConfigLocaleInput {
  requestedLocale?: string;
  acceptLanguageHeader?: string | string[];
}

export function resolveConfigLocale(
  localization: LocalizationConfig,
  input: ConfigLocaleInput = {}
): LocaleCode {
  return resolveLocalePreference({
    requestedLocale: input.requestedLocale,
    acceptLanguageHeader: input.acceptLanguageHeader,
    defaultLocale: localization.defaultLocale,
    supportedLocales: localization.supportedLocales
  });
}

export function resolveLocalizedString(
  value: LocalizedStringConfig,
  locale: LocaleCode,
  fallbackLocale: LocaleCode
): string;
export function resolveLocalizedString(
  value: LocalizedStringConfig | undefined,
  locale: LocaleCode,
  fallbackLocale: LocaleCode
): string | undefined;
export function resolveLocalizedString(
  value: LocalizedStringConfig | undefined,
  locale: LocaleCode,
  fallbackLocale: LocaleCode
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return value[locale] ?? value[fallbackLocale] ?? value.en ?? value.de;
}
