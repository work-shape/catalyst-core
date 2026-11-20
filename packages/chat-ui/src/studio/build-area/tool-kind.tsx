import { Badge } from "@work-shape/catalyst-ui";
import type { BuildListedKind } from "./build-asset-kind";

/**
 * Tools an instance adds without a release (TOOL-1): a list whose rows say what a `result` tool
 * hands the panel, or which runtime a `code` tool's handler runs in. A tool is written and published with the CLI (`catalyst tool put` and `publish`);
 * agents name it as `tool.<name>.call`.
 */
export const toolKind: BuildListedKind = {
  kind: "tool",
  path: "tools",
  label: "toolAssets.kind",
  overviewText: "toolAssets.purpose",
  description: "toolAssets.description",
  searchLabel: "toolAssets.search",
  emptyText: "toolAssets.empty",
  icon: "tool",
  rowText: (asset) => asset.description,
  badges: (asset) => {
    const kind = asset.attributes?.resultKind ?? asset.attributes?.runtime;
    return typeof kind === "string" ? <Badge>{kind}</Badge> : null;
  }
};
