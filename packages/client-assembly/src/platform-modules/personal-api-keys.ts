import { defineModule } from "@work-shape/catalyst-core";

/**
 * Personal API keys: a person issues keys that act as themself, narrowed to their scopes, in
 * Settings or by confirming the CLI's connect code; whoever holds `api_access.manage` sees and
 * revokes every person's keys. Off, no personal key authenticates (`createClientInstanceAuth`)
 * and the keys stay stored, revocable when the module is on again.
 */
export const personalApiKeysModule = defineModule({
  name: "personalApiKeys",
  operations: [
    "me.api_keys.list",
    "me.api_keys.create",
    "me.api_keys.revoke",
    "me.connect_codes.get",
    "me.connect_codes.confirm",
    "connect_codes.start",
    "connect_codes.redeem",
    "personal_api_keys.list",
    "personal_api_keys.revoke"
  ],
  ui: ["settings.you.api-keys", "settings.you.connect", "settings.api-access.personal-keys"]
});
