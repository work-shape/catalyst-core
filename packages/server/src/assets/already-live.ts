import { AppError } from "@work-shape/catalyst-core";
import { firstVersionOffering } from "../approvals/agent-publish-review";
import type { AssetWorkflowOptions } from "../types";

/** The reason of the answer to a publish of the revision that is live, with no draft beside it. */
const ALREADY_LIVE_REASON = "already_live";

/**
 * Refuses an agent's publish that has nothing to do, before anything waits for a confirmation
 * or an approval: it names the live revision, no draft stands beside it, and there is no first
 * version to offer. Only an agent: its draft lives beside its live revision, so its publish of
 * the live revision publishes nothing. A re-publish of another kind's live revision still means
 * something (who published it, its audience, what it may read) and is not refused here.
 */
export async function refuseAlreadyLive(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets" | "stores">,
  input: {
    kind: string;
    name: string;
    revision: number;
    makeDependenciesAvailable?: boolean;
    expectedAvailability?: unknown;
  }
): Promise<void> {
  if (
    input.kind !== "agent" ||
    input.makeDependenciesAvailable ||
    input.expectedAvailability != null
  )
    return;
  const { clientInstanceId } = options;
  const asset = await options.configAssets.store.getConfigAsset({
    clientInstanceId,
    kind: input.kind,
    name: input.name
  });
  if (!asset || asset.status !== "active" || input.revision !== asset.revision) return;
  const draft = await options.stores.agentProposals.get({ clientInstanceId, agentId: asset.id });
  if (draft) return;
  if ((await firstVersionOffering(options, asset, input.revision)) !== undefined) return;
  throw new AppError(
    "CONFLICT",
    `Revision ${input.revision} of agent '${input.name}' is already live and no draft waits to be published. Nothing to do: nothing was published and no request was filed.`,
    {
      reason: ALREADY_LIVE_REASON,
      kind: input.kind,
      name: input.name,
      liveRevision: input.revision
    }
  );
}
