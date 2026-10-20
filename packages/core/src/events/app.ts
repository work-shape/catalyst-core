import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const appEvents = {
  // Guardrails answer here before an App's revision goes live. The subject is the App.
  "app.before_publish": {
    name: "app.before_publish",
    subject: "config_asset",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  "app.created": { ...LEGACY_AUDIT, name: "app.created", subject: "config_asset" },
  "app.published": { ...LEGACY_AUDIT, name: "app.published", subject: "config_asset" }
} as const satisfies Record<string, PlatformEventDefinition>;
