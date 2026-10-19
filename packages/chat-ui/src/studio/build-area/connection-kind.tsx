import { Badge, Chip, ConnectionIcon } from "@work-shape/catalyst-ui";
import { connectionCategory } from "../../shared/connection-facts";
import type { BuildAsset, BuildAssetKind } from "./build-asset-kind";
import { ConnectionCreateDialog } from "./connection-create-dialog";
import { ConnectionAssetEditor } from "./connection-editor";
import { connectorTypeLabel } from "./connection-form";
import { HEALTH_VIEWS, listedHealth } from "./connection-status";
import { CONNECTIONS_BUILD_PATH } from "./connection-tools";

/**
 * The name of a Connection that release config defines. Such a Connection is changed there
 * alone, so its page is read-only and offers a copy, as a shipped asset's does.
 */
function releaseConnectionTitle(asset: Pick<BuildAsset, "config" | "name">): string | undefined {
  const { origin, displayName } = asset.config;
  if (origin !== "release") return undefined;
  return typeof displayName === "string" && displayName !== "" ? displayName : asset.name;
}

/**
 * Connections in Build: a list, "New connection" with its own dialog for an MCP server or a
 * REST API, and the page of one Connection. A row says what the instance tells of the Connection without
 * its definition: its icon, what it is for, its connector type, whom it belongs to and
 * whether it is on. No row holds a setting or a reference to a credential.
 */
export const connectionKind: BuildAssetKind = {
  kind: "connection",
  path: CONNECTIONS_BUILD_PATH,
  label: "connections.kind",
  description: "connections.description",
  searchLabel: "connections.search",
  emptyText: "connections.empty",
  emptyReadOnlyText: "connections.emptyReadOnly",
  newLabel: "connections.new",
  titleLabel: "connections.titleLabel",
  deleteTitle: "connections.deleteTitle",
  deleteDescription: "connections.deleteDescription",
  missingText: "connections.missing",
  icon: "connection",
  shippedTitle: releaseConnectionTitle,
  // A batch of the CLI holds no Connection yet.
  withoutCli: true,
  Editor: ConnectionAssetEditor,
  CreateDialog: ConnectionCreateDialog,
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
  // An enabled Connection shows its health in the words of its page; a list of an instance
  // that names no health shows that it is on.
  badges: (asset, t) => {
    const { connectorType, enabled, health } = asset.attributes ?? {};
    const listed = enabled === false ? undefined : listedHealth(health);
    return (
      <>
        {typeof connectorType === "string" ? (
          <Chip size="sm">{connectorTypeLabel(connectorType, t)}</Chip>
        ) : null}
        {listed ? (
          <Badge tone={HEALTH_VIEWS[listed].tone} dot data-connection-list-health={listed}>
            {t(HEALTH_VIEWS[listed].label)}
          </Badge>
        ) : typeof enabled === "boolean" ? (
          <Badge tone={enabled ? "success" : "neutral"} dot>
            {t(enabled ? "connections.enabled" : "connections.disabled")}
          </Badge>
        ) : null}
      </>
    );
  }
};
