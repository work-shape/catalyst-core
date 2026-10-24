import { GUARDRAIL_ASSET_KIND, defineModule } from "@work-shape/catalyst-core";

/**
 * Guardrails: rules at the before-events that allow, warn, hold for an approval or block, from
 * release config, from guardrail assets, or shipped with the release. On by default for one
 * transition release. Off, no guardrail answers at a before-event and only policy, floors and
 * rights apply; the guardrail kind, its operations and its screens are gone, and what is stored
 * of guardrails and their hits is kept and inert. Its code leaves core for a capability
 * (ADR-0032); until then the platform ships it.
 */
export const guardrailsModule = defineModule({
  name: "guardrails",
  kinds: [GUARDRAIL_ASSET_KIND],
  operations: [
    "guardrails.list_hits",
    "guardrails.test",
    "guardrails.dry_run",
    "guardrails.list_shipped",
    "guardrails.switch_shipped",
    "guardrails.unpublish"
  ],
  ui: ["studio.guardrails"]
});
