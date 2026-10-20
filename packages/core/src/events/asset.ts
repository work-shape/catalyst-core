import type { PlatformEventDefinition } from "./definition";

export const assetEvents = {
  // Guardrails answer here before a revision of any asset kind is written. The subject is the
  // asset; its kind narrows the guardrails that apply.
  "asset.before_write": {
    name: "asset.before_write",
    subject: "config_asset",
    legacy: false,
    audited: false,
    phases: ["before"]
  }
} as const satisfies Record<string, PlatformEventDefinition>;
