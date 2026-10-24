import type { ClientInstanceId, PlatformStores } from "@work-shape/catalyst-core";
import { OPERATION_CALL_APPROVAL_KIND } from "@work-shape/catalyst-tool-execution";
import { endHeldOperationCalls } from "./operation-call-approval-handler";

/**
 * Ends the held calls about a Connection that was deleted. A Connection made again under its
 * name gets the deleted one's asset id back, so a request that still waited would otherwise be
 * decided by `connection.approve` on the new one and run against it.
 */
export function endHeldCallsOnDeletedConnection(input: {
  clientInstanceId: ClientInstanceId;
  connectionAssetId: string;
  stores: Pick<PlatformStores, "approvals">;
}): Promise<number> {
  return endHeldOperationCalls(
    { clientInstanceId: input.clientInstanceId, approvals: input.stores.approvals },
    { subjectContains: { connectionAssetId: input.connectionAssetId } },
    {
      denial: {
        kind: "policy",
        operation: OPERATION_CALL_APPROVAL_KIND,
        reason: "approval_stale"
      },
      message: "The Connection this call is about was deleted."
    }
  );
}
