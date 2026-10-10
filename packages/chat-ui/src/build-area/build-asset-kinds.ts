import { createContext, useContext } from "react";
import { agentKind } from "./agent-kind";
import type { BuildAssetKind } from "./build-asset-kind";
import { skillKind } from "./skill-kind";

/**
 * The asset kinds of the platform, in rail order. This is deliberately not the client widget
 * registry: an asset page changes how the instance behaves, so a client assembly must not
 * replace it.
 */
export const buildAssetKinds: readonly BuildAssetKind[] = [agentKind, skillKind];

const BuildAssetKindsContext = createContext<readonly BuildAssetKind[]>(buildAssetKinds);

/** Hands the frame another list of kinds than the platform's. Tests plant a kind through it. */
export const BuildAssetKindsProvider = BuildAssetKindsContext.Provider;

/** The kinds the frame knows, in rail order. */
export function useBuildAssetKinds(): readonly BuildAssetKind[] {
  return useContext(BuildAssetKindsContext);
}
