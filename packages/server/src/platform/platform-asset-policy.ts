import { POLICY_VALUES, resolvePolicy, type PolicyValue } from "@work-shape/catalyst-core";
import type { AssetWorkflow } from "../assets/asset-service";
import type { AssetWorkflowOptions } from "../types";

type AssetAddress = { kind: string; name?: string; workspaceId?: string };

const stricterOf = (left: PolicyValue | undefined, right: PolicyValue): PolicyValue =>
  left === undefined || POLICY_VALUES.indexOf(right) > POLICY_VALUES.indexOf(left) ? right : left;

/** Policy of the operations projected by the Build Agent, with the live-write floor. */
export function createPlatformAssetPolicy(options: AssetWorkflowOptions, workflow: AssetWorkflow) {
  /**
   * The strictest value an administrator set on any of `operations` for the asset at
   * `address`, read as the value that was set: a tool's own mode stands where no setting names
   * the operation, since a draft save needs no confirmation by default.
   */
  async function centralFloor(
    operations: readonly string[],
    address: AssetAddress
  ): Promise<PolicyValue | undefined> {
    const policy = options.operationCalls?.deps.policy;
    if (!policy) return undefined;
    const centralSettings = await policy.centralSettings();
    const targets = await workflow.policyTargets(address);
    let floor: PolicyValue | undefined;
    for (const name of operations) {
      const asked = resolvePolicy({
        definition: { name, effect: "changing", defaultPolicy: "allow" },
        origin: { kind: "user" },
        instanceDefaults: policy.instanceDefaults,
        centralSettings,
        targets,
        callerCanConfirm: true,
        canPause: true
      });
      if (asked.source === "central_setting") floor = stricterOf(floor, asked.value);
    }
    return floor;
  }

  return {
    centralFloor,
    async putFloor(
      target: AssetAddress,
      hasExpectedRevision: boolean
    ): Promise<PolicyValue | undefined> {
      const central = await centralFloor(["assets.put"], target);
      const kind = options.configAssets.kinds.get(target.kind);
      // Existing agents save a shared draft; creating one, or a skill, is live at once.
      // No central allow or personal Always allow can lower this confirmation floor.
      const savesDraft =
        kind?.lifecycle === "draft_published" || (target.kind === "agent" && hasExpectedRevision);
      return savesDraft ? central : stricterOf(central, "confirm");
    }
  };
}
