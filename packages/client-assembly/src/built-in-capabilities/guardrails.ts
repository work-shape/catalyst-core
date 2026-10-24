import {
  defineCapability,
  type ClientInstanceCapability
} from "@work-shape/catalyst-capability-sdk";
import type { ReleaseGuardrailConfig } from "@work-shape/catalyst-config-schema";
import { GUARDRAIL_ASSET_KIND, defineModule } from "@work-shape/catalyst-core";
import { GuardrailRunner, seedReleaseGuardrails } from "@work-shape/catalyst-server";

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

/** The name a deployment's own guardrails capability takes to stand in for the built-in one. */
export const GUARDRAILS_CAPABILITY_NAME = "guardrails";

/**
 * The guardrails as a capability: the platform ships it built in until it moves to the
 * capabilities (core-extraction-guardrails.md, slice 4a). It reaches the platform through the
 * capability seams alone: the check, the seed, the retention, the models and the stores of its
 * context. Two parts are not seams yet and are handed in: `guardrails` of release config, until
 * the capability declares its config schema, and the guardrail kind, its operations and its
 * rights, which the platform still registers while the module is on.
 */
export function createGuardrailsCapability(input: {
  /** `guardrails` of release config: the floor. */
  guardrails: Readonly<Record<string, ReleaseGuardrailConfig>>;
}): ClientInstanceCapability {
  return defineCapability({
    name: GUARDRAILS_CAPABILITY_NAME,
    modules: [guardrailsModule],
    create(context) {
      const { clientInstanceId, stores, logger } = context;
      // Hits kept while the module was on are deleted on time while it is off as well.
      const retention = async (retained: {
        days: number;
        stores: { guardrails: Pick<typeof stores.guardrails, "deleteHitsOlderThan"> };
      }) => ({
        guardrailHitsDeletedCount: await retained.stores.guardrails.deleteHitsOlderThan({
          clientInstanceId,
          days: retained.days
        })
      });
      // Off, nothing answers at a before-event and stored guardrails are kept as they are.
      if (!context.modules.isEnabled(guardrailsModule.name)) return { retention };
      return {
        beforeActionCheck: new GuardrailRunner({
          clientInstanceId,
          guardrails: input.guardrails,
          models: context.models,
          hits: stores.guardrails,
          assets: stores.configAssets,
          shipped: stores.guardrails
        }),
        async instanceSeed(seed) {
          const result = await seedReleaseGuardrails({
            clientInstanceId,
            guardrails: input.guardrails,
            stores: seed.stores
          });
          if (result.created.length + result.updated.length + result.removed.length > 0) {
            // Names only. No instruction of a guardrail is logged.
            logger.info({ guardrails: result }, "Release Guardrails reconciled");
          }
          if (result.conflicts.length > 0) {
            // The floor runs from release config all the same; the asset keeps the name in Build.
            logger.warn(
              { conflicts: result.conflicts },
              "Release Guardrails share a name with a guardrail written as an asset"
            );
          }
        },
        retention
      };
    }
  });
}
