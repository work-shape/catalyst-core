import type { ClientInstanceConfig } from "./schemas";
import {
  resolveConfigLocale,
  resolveLocalizedString,
  type ConfigLocaleInput
} from "./localization";

export interface ClientBranding {
  environment: ClientInstanceConfig["clientInstance"]["environment"];
  localization: {
    locale: string;
    defaultLocale: string;
    supportedLocales: string[];
  };
  clientName: string;
  logoUrl?: string;
  logoUrlDark?: string;
  logoInvertOnDark: boolean;
  faviconUrl?: string;
  title: string;
  welcomeMessage: string;
  accentColor: string;
  theme: {
    accentColor: string;
    accentStrongColor: string;
    backgroundColor: string;
    surfaceColor: string;
    textColor: string;
    mutedTextColor: string;
    borderColor: string;
  };
  darkTheme: {
    accentColor: string;
    accentStrongColor: string;
    backgroundColor: string;
    surfaceColor: string;
    textColor: string;
    mutedTextColor: string;
    borderColor: string;
  };
  defaultThemeMode: "light" | "dark" | "system";
}

export function createClientBranding(
  config: ClientInstanceConfig,
  localeInput: ConfigLocaleInput = {}
): ClientBranding {
  const locale = resolveConfigLocale(config.localization, localeInput);
  const accentColor = config.ui.theme.accentColor ?? config.ui.accentColor;
  return {
    environment: config.clientInstance.environment,
    localization: {
      locale,
      defaultLocale: config.localization.defaultLocale,
      supportedLocales: config.localization.supportedLocales
    },
    clientName:
      resolveLocalizedString(config.ui.clientName, locale, config.localization.defaultLocale) ??
      config.clientInstance.displayName,
    logoUrl: config.ui.logoUrl,
    logoUrlDark: config.ui.logoUrlDark,
    logoInvertOnDark: config.ui.logoInvertOnDark,
    faviconUrl: config.ui.faviconUrl,
    title: resolveLocalizedString(config.ui.title, locale, config.localization.defaultLocale),
    welcomeMessage: resolveLocalizedString(
      config.ui.welcomeMessage,
      locale,
      config.localization.defaultLocale
    ),
    accentColor,
    theme: {
      ...config.ui.theme,
      accentColor
    },
    darkTheme: config.ui.darkTheme,
    defaultThemeMode: config.ui.defaultThemeMode
  };
}
