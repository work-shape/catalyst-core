import type { PlatformAssetCalls } from "@work-shape/catalyst-tool-execution";
import { type AssetCallScope } from "./scope";

/** What a save of a skill the agent reads would file. */
export function skillCalls(scope: AssetCallScope): Pick<PlatformAssetCalls, "skillSaveApproval"> {
  const { options, workflow, callOf } = scope;
  return {
    async skillSaveApproval(context, name) {
      // A skill's name is unique on the instance: its row says which owner it is saved in.
      const row = await options.configAssets.store.getConfigAsset({
        clientInstanceId: options.clientInstanceId,
        kind: "skill",
        name
      });
      if (row === undefined) return undefined;
      const call = await callOf(context);
      return workflow.reads.saveApprovalAt(call, {
        kind: "skill",
        name,
        ...(row.scope.kind === "workspace" ? { workspaceId: row.scope.workspaceId } : {})
      });
    }
  };
}
