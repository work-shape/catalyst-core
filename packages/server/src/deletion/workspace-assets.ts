import {
  AppError,
  type AuditActor,
  type CollaborationWorkspaceId
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";

/** How many assets of a kind one call of its retirement is handed. */
const RETIRE_PAGE = 100;

/**
 * Hands each kind that retires its assets with their workspace the ones the workspace still
 * owns, a page at a time, before the store removes what the workspace owns. A Workflow is
 * deleted as its own delete deletes it (WS-OWN-1b): its name stays taken, its principal is
 * retired and its open runs are cancelled. The store refuses the workspace delete while one is
 * still active, so a pass that fails here is repeated.
 */
export async function retireWorkspaceAssets(
  options: Pick<ChatServerOptions, "clientInstanceId" | "stores" | "configAssets">,
  input: {
    collaborationWorkspaceId: CollaborationWorkspaceId;
    actor: AuditActor;
    correlationId: string;
  }
): Promise<void> {
  const scope = { kind: "workspace" as const, workspaceId: input.collaborationWorkspaceId };
  for (const kind of options.configAssets.kinds.kinds) {
    const retire = kind.retireWithWorkspace?.bind(kind);
    if (retire === undefined) continue;
    const handed = new Set<string>();
    for (;;) {
      // A retired asset is no longer active, so each page starts at the first name again.
      const assets = await options.stores.configAssets.listConfigAssetPage({
        clientInstanceId: options.clientInstanceId,
        kind: kind.kind,
        scope,
        limit: RETIRE_PAGE,
        readable: () => true
      });
      if (assets.length === 0) break;
      // One that is still active after its retirement would be handed again and again.
      if (assets.some((asset) => handed.has(asset.name)))
        throw new AppError("CONFLICT", `A ${kind.kind} of the workspace was not retired`);
      for (const asset of assets) handed.add(asset.name);
      await retire({
        clientInstanceId: options.clientInstanceId,
        assets,
        stores: options.stores,
        actor: input.actor,
        correlationId: input.correlationId
      });
    }
  }
}
