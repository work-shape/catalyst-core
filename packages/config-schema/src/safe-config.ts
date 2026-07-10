import type { RuntimeAssetSnapshot } from "@vivd-catalyst/core";
import type { ClientInstanceConfig } from "./schemas";
import { createClientBranding } from "./branding";
import {
  resolveConfigLocale,
  resolveLocalizedString,
  type ConfigLocaleInput
} from "./localization";

export function createSafeConfigView(
  config: ClientInstanceConfig,
  assets: RuntimeAssetSnapshot,
  localeInput: ConfigLocaleInput = {}
) {
  const locale = resolveConfigLocale(config.localization, localeInput);
  const { environment: _environment, ...ui } = createClientBranding(config, {
    requestedLocale: locale
  });

  return {
    clientInstance: {
      id: config.clientInstance.id,
      displayName: config.clientInstance.displayName,
      environment: config.clientInstance.environment
    },
    localization: {
      locale,
      defaultLocale: config.localization.defaultLocale,
      supportedLocales: config.localization.supportedLocales
    },
    retention: config.retention,
    usage: {
      safeguards: config.usage.safeguards
    },
    features: {
      attachments: {
        enabled: false,
        accept: ""
      }
    },
    defaultAgentName: assets.defaultAgentName,
    agents: assets.agents.map((agent) => ({
      name: agent.name,
      displayName: resolveLocalizedString(agent.displayName, locale, config.localization.defaultLocale),
      welcomeMessage: resolveLocalizedString(
        agent.welcomeMessage,
        locale,
        config.localization.defaultLocale
      ),
      welcomeSubtitle: resolveLocalizedString(
        agent.welcomeSubtitle,
        locale,
        config.localization.defaultLocale
      ),
      initialPrompts: agent.initialPrompts.map((initialPrompt) => ({
        title: resolveLocalizedString(initialPrompt.title, locale, config.localization.defaultLocale),
        prompt: resolveLocalizedString(initialPrompt.prompt, locale, config.localization.defaultLocale)
      }))
    })),
    ui
  };
}
