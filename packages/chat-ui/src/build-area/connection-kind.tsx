import { Cable } from "lucide-react";
import { Badge, Chip } from "@vivd-catalyst/ui";
import type { BuildListedKind } from "./build-asset-kind";

/**
 * Connections in Build: a list. A Connection is written by the release so far, so the kind has
 * no asset page and no button that starts one. A row says what the instance tells of the
 * Connection without its definition: its connector type, whom it belongs to, where it comes
 * from and whether it is on. No row holds a setting or a reference to a credential.
 */
export const connectionKind: BuildListedKind = {
  kind: "connection",
  path: "connections",
  label: "connections.kind",
  searchLabel: "connections.search",
  emptyText: "connections.empty",
  icon: Cable,
  badges: (asset, t) => {
    const { connectorType, origin, enabled } = asset.attributes ?? {};
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
        {origin === "release" || origin === "runtime" ? (
          <Chip size="sm">
            {t(origin === "release" ? "connections.originRelease" : "connections.originRuntime")}
          </Chip>
        ) : null}
        {typeof enabled === "boolean" ? (
          <Badge tone={enabled ? "success" : "neutral"} dot>
            {t(enabled ? "connections.enabled" : "connections.disabled")}
          </Badge>
        ) : null}
      </>
    );
  }
};
