import { Cable } from "lucide-react";
import { Badge, Chip } from "@vivd-catalyst/ui";
import type { BuildAssetViewProps, BuildListedKind } from "./build-asset-kind";
import { ConnectionPage } from "./connection-page";
import { useConnectionSource } from "./connection-source";

/** The Connection page on the instance's own answers. */
function ConnectionAssetPage(frame: BuildAssetViewProps) {
  return <ConnectionPage {...frame} source={useConnectionSource()} />;
}

/**
 * Connections in Build: a list, and a page that shows one Connection. A Connection is written
 * by the release so far, so the kind has no editor and no button that starts one. A row says what the instance tells of the
 * Connection without its definition: its connector type, whom it belongs to and whether it is
 * on. Where it comes from is not a chip: every Connection comes from release config so far.
 * No row holds a setting or a reference to a credential.
 */
export const connectionKind: BuildListedKind = {
  kind: "connection",
  path: "connections",
  label: "connections.kind",
  description: "connections.description",
  searchLabel: "connections.search",
  emptyText: "connections.empty",
  icon: Cable,
  view: { Page: ConnectionAssetPage, missingText: "connections.missing" },
  badges: (asset, t) => {
    const { connectorType, enabled } = asset.attributes ?? {};
    return (
      <>
        {typeof connectorType === "string" ? (
          <Chip size="sm">
            <code className="font-mono">{connectorType}</code>
          </Chip>
        ) : null}
        <Chip size="sm">
          {t(
            asset.scope.kind === "workspace"
              ? "connections.scopeWorkspace"
              : "connections.scopeInstance"
          )}
        </Chip>
        {typeof enabled === "boolean" ? (
          <Badge tone={enabled ? "success" : "neutral"} dot>
            {t(enabled ? "connections.enabled" : "connections.disabled")}
          </Badge>
        ) : null}
      </>
    );
  }
};
