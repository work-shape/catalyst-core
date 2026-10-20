import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const configAssetEvents = {
  "config_asset.availability_set": {
    ...LEGACY_AUDIT,
    name: "config_asset.availability_set",
    subject: "config_asset"
  },
  "config_asset.default_agent_set": {
    ...LEGACY_AUDIT,
    name: "config_asset.default_agent_set",
    subject: "config_asset"
  },
  "config_asset.deleted": {
    ...LEGACY_AUDIT,
    name: "config_asset.deleted",
    subject: "config_asset"
  },
  "config_asset.draft_discarded": {
    ...LEGACY_AUDIT,
    name: "config_asset.draft_discarded",
    subject: "config_asset"
  },
  "config_asset.published": {
    ...LEGACY_AUDIT,
    name: "config_asset.published",
    subject: "config_asset"
  },
  "config_asset.reverted": {
    ...LEGACY_AUDIT,
    name: "config_asset.reverted",
    subject: "config_asset"
  },
  "config_asset.shipped_skill_unlisted": {
    ...LEGACY_AUDIT,
    name: "config_asset.shipped_skill_unlisted",
    subject: "config_asset"
  },
  "config_asset.updated": {
    ...LEGACY_AUDIT,
    name: "config_asset.updated",
    subject: "config_asset"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
