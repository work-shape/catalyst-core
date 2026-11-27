import { Badge, Chip, ConnectionIcon, ServiceMark } from "@work-shape/catalyst-ui";
import { connectionCategory } from "../../shared/connection-facts";
import type { BuildAsset, BuildAssetKind, BuildAssetRow } from "./build-asset-kind";
import { ConnectionCreateDialog } from "./connection-create-dialog";
import { ConnectionAssetEditor } from "./connection-editor";
import { knownConnectorTypeLabel } from "./connection-form";
import { ConnectedPeopleBadge } from "./connection-people";
import { ConnectionsListLayout } from "./connections-list-layout";
import { hiddenFromConnectionList, markArt, serviceFaceOf } from "./my-connections-model";
import { HEALTH_VIEWS, listedHealth } from "./connection-status";
import { CONNECTIONS_BUILD_PATH } from "./connection-tools";
import { listedOwnServer } from "./own-server-model";

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
 * An incomplete Connection: an MCP server or a REST API that accepts no tool yet, such as one a
 * failed connect left behind. Its row says so, and offers its delete where the reader may.
 */
function listedIncomplete(asset: Pick<BuildAssetRow, "attributes">): boolean {
  return asset.attributes?.withoutTools === true;
}

/**
 * Connections in Build (CONN-IA): "Meine Verbindungen" for everyone, and for who manages
 * Connections a tab with the instance's list, the services to install and other people's
 * servers; "New connection" with its own dialog for an MCP server, a REST API or a type with a
 * form of its own; and the page of one Connection. A row says what the instance tells of the
 * Connection without its definition: the mark of its service, what it is for, whose account it
 * uses and whether it works. No row holds a setting or a reference to a credential.
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
  ListLayout: ConnectionsListLayout,
  listHides: hiddenFromConnectionList,
  // A person's own server is for that person alone, whatever its place. Another person's,
  // which an admin sees to switch off or delete, stands below the reader's own (PMCP).
  rowPlace: (asset, t) => {
    const own = listedOwnServer(asset);
    if (own === undefined) return undefined;
    if (own.owner === "reader") return { scope: "personal", name: t("build.placeMine") };
    return {
      scope: "personal",
      name: own.label
        ? t("connections.onlyFor", { name: own.label })
        : t("connections.onlyForDeleted")
    };
  },
  listAside: {
    title: "connections.othersOwn",
    description: "connections.othersOwnText",
    holds: (asset) => listedOwnServer(asset)?.owner === "other"
  },
  // A row shows the mark of the service behind the Connection where it was installed for one,
  // else the icon of its system, and what the Connection is for in words. Its id stands on
  // its page.
  row: (asset, t) => {
    const { service, connectorType } = asset.attributes ?? {};
    const face = serviceFaceOf(asset.attributes);
    // Without a description of its own, an incomplete Connection's row says what it lacks.
    const incomplete = listedIncomplete(asset) ? t("connections.incompleteRow") : undefined;
    return {
      leading: face ? (
        <ServiceMark name={face.title} size="lg" showName={false} {...markArt(face.mark)} />
      ) : (
        <ConnectionIcon
          size="lg"
          service={typeof service === "string" ? service : undefined}
          category={connectionCategory(
            typeof connectorType === "string" ? connectorType : undefined
          )}
        />
      ),
      description: asset.description?.trim() || incomplete
    };
  },
  // An incomplete Connection is removed from its row, as from its page.
  rowRemovable: listedIncomplete,
  rowRemoveLabel: "connections.incompleteRemove",
  // A row says whose account the Connection uses, in words: one shared access, or each
  // person's own, then with how many people connected theirs for who may see them. An enabled
  // shared Connection shows its health in the words of its page; a list of an instance that
  // names no health shows that it is on.
  badges: (asset, t) => {
    const { connectorType, enabled, health, personalSignIn } = asset.attributes ?? {};
    const personal = personalSignIn === true;
    const own = listedOwnServer(asset) !== undefined;
    const listed = enabled === false ? undefined : listedHealth(health, personal);
    const type =
      typeof connectorType === "string" ? knownConnectorTypeLabel(connectorType, t) : undefined;
    return (
      <>
        {type ? <Chip size="sm">{type}</Chip> : null}
        {own ? null : (
          <Chip size="sm">
            {t(personal ? "connections.accountPersonal" : "connections.accountShared")}
          </Chip>
        )}
        {listedIncomplete(asset) ? (
          <Badge tone="warning" data-connection-incomplete="">
            {t("connections.incomplete")}
          </Badge>
        ) : null}
        {enabled === false ? (
          <Badge tone="neutral" dot>
            {t("connections.disabled")}
          </Badge>
        ) : personal && !own ? (
          // Each person connects their own account: nothing here is ready or missing.
          (asset.allowed?.includes("write") ?? false) ? (
            <ConnectedPeopleBadge name={asset.name} />
          ) : null
        ) : listed && listed !== "personal" ? (
          <Badge tone={HEALTH_VIEWS[listed].tone} dot data-connection-list-health={listed}>
            {t(HEALTH_VIEWS[listed].label)}
          </Badge>
        ) : typeof enabled === "boolean" && !own ? (
          <Badge tone="success" dot>
            {t("connections.enabled")}
          </Badge>
        ) : null}
      </>
    );
  }
};
