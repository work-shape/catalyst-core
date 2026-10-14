import { Badge, Chip, ConnectionIcon } from "@vivd-catalyst/ui";
import { connectionCategory } from "../connection-facts";
import type { BuildAssetViewProps, BuildListedKind } from "./build-asset-kind";
import { ConnectionPage } from "./connection-page";
import { useConnectionSource } from "./connection-source";
import { CONNECTIONS_BUILD_PATH } from "./connection-tools";

/** The Connection page on the instance's own answers. */
function ConnectionAssetPage(frame: BuildAssetViewProps) {
  return <ConnectionPage {...frame} source={useConnectionSource()} />;
}

/**
 * Connections in Build: a list, and a page that shows one Connection. A Connection is written
 * by the release so far, so the kind has no editor and no button that starts one. A row says what the instance tells of the
 * Connection without its definition: its icon, what it is for, its connector type, whom it
 * belongs to and whether it is on. Where it comes from is not a chip: every Connection comes from release config so far.
 * No row holds a setting or a reference to a credential.
 */
export const connectionKind: BuildListedKind = {
  kind: "connection",
  path: CONNECTIONS_BUILD_PATH,
  label: "connections.kind",
  description: "connections.description",
  searchLabel: "connections.search",
  emptyText: "connections.empty",
  icon: "connection",
  view: { Page: ConnectionAssetPage, missingText: "connections.missing" },
  // A row shows the icon of the system behind the Connection, on its tile, and what the
  // Connection is for in words. Its id stands on its page.
  row: (asset) => {
    const { service, connectorType } = asset.attributes ?? {};
    return {
      leading: (
        <ConnectionIcon
          size="lg"
          service={typeof service === "string" ? service : undefined}
          category={connectionCategory(
            typeof connectorType === "string" ? connectorType : undefined
          )}
        />
      ),
      description: asset.description?.trim() || undefined
    };
  },
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
