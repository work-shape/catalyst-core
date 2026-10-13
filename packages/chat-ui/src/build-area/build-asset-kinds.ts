import { createContext, useContext } from "react";
import { agentKind } from "./agent-kind";
import type { BuildKind } from "./build-asset-kind";
import { connectionKind } from "./connection-kind";
import { dataStoreKind } from "./data-store-kind";
import { knowledgeBaseKind } from "./knowledge-base-kind";
import { skillKind } from "./skill-kind";

/**
 * The asset kinds of the platform, in rail order. This is deliberately not the client widget
 * registry: an asset page changes how the instance behaves, so a client assembly must not
 * replace it.
 */
export const buildAssetKinds: readonly BuildKind[] = [
  agentKind,
  skillKind,
  connectionKind,
  dataStoreKind,
  knowledgeBaseKind
];

const BuildAssetKindsContext = createContext<readonly BuildKind[]>(buildAssetKinds);

/** Hands the frame another list of kinds than the platform's. Tests plant a kind through it. */
export const BuildAssetKindsProvider = BuildAssetKindsContext.Provider;

/** The kinds the frame knows, in rail order. */
export function useBuildAssetKinds(): readonly BuildKind[] {
  return useContext(BuildAssetKindsContext);
}
