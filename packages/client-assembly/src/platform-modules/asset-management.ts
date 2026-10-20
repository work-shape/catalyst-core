import { defineModule } from "@work-shape/catalyst-core";
import { PLATFORM_ASSET_TOOLS } from "@work-shape/catalyst-tool-execution";

/**
 * Changing agents and skills in the interface. Running an agent and a config push are core:
 * `assets.sync` carries a push too, so its workflow asks the switch and lets the release holder
 * pass where the module is off. A person may also publish a release-written agent draft
 * there; assets.publish checks that provenance itself. Other interactive writes stay bound.
 */
export const assetManagementModule = defineModule({
  name: "assetManagement",
  operations: [
    "assets.put",
    "assets.delete",
    "assets.revert",
    "assets.discard_draft",
    "assets.run_live_once",
    "assets.set_default",
    "assets.set_availability",
    "agents.draft.discard",
    "agents.try.open",
    "guardrails.unpublish"
  ],
  selfCheckedOperations: ["assets.sync", "assets.publish"],
  // The agent's save of a draft is a change of an asset like `assets.put`, which it projects.
  tools: [PLATFORM_ASSET_TOOLS.put.name],
  ui: ["settings.build"]
});
