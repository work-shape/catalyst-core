import { useState } from "react";
import {
  useAgentPlacementMutations,
  type AvailabilityKind
} from "../../shared/api/agent-placement-mutations";
import { useAdministeredCollaborationWorkspacesQuery } from "../../shared/api/workspace-queries";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { useTranslation } from "../../shared/i18n";
import { useSettingsPage } from "../../shared/settings-page-context";
import { apiErrorMessage } from "../../shared/workspace-utils";
import type { AvailabilityChoice } from "./asset-availability-fields";
import type { AgentAvailabilityForm } from "./asset-form-model";
import type { BuildAssetEditorProps } from "./build-asset-kind";

/**
 * The query of an agent's read that asks what the availability in the form would leave its
 * members unable to use. It changes nothing.
 */
function availabilityPreviewQuery(form: AgentAvailabilityForm) {
  return form.mode === "all"
    ? { availabilityMode: "all" as const }
    : {
        availabilityMode: "selected" as const,
        availabilityPersonalWorkspaces: form.personalWorkspaces
          ? ("true" as const)
          : ("false" as const),
        availabilityWorkspaceIds: form.collaborationWorkspaceIds.join(",")
      };
}

/** What of the page an availability is read and written for. */
export type AvailabilityFrame = Pick<BuildAssetEditorProps, "asset" | "instanceWrite" | "owner">;

/**
 * Where the asset on the page is available, for a reader who may set it. The instance says so
 * on its read of the asset: the kind's write right on the whole instance, unless the asset denies
 * it, so whoever manages only Connections or only Knowledge Bases sets theirs. An instance from
 * before says nothing, and the right to change all of the instance's assets decides. The page
 * keeps what it was told and what it saved itself. An agent's choice also reads what a changed
 * availability leaves its members unable to use.
 */
export function useAvailabilityChoice(
  frame: AvailabilityFrame,
  kind: AvailabilityKind
): AvailabilityChoice | undefined {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const { asset, owner } = frame;
  const maySet = asset?.canSetAvailability ?? frame.instanceWrite;
  const placement = useAgentPlacementMutations({
    apiBaseUrl,
    authScope,
    client,
    heldMessage: t("configChangeWaitsForApproval")
  });
  const workspacesQuery = useAdministeredCollaborationWorkspacesQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: maySet && asset !== undefined
  });
  const [saved, setSaved] = useState(asset?.availability);
  if (asset === undefined || !maySet) return undefined;
  const scope = owner === undefined ? {} : { workspaceId: owner };
  return {
    saved,
    workspaces: workspacesQuery.data ?? [],
    workspacesError: workspacesQuery.error
      ? apiErrorMessage(workspacesQuery.error, undefined)
      : undefined,
    ...(kind === "agent"
      ? {
          dependencies: {
            key: [
              ...workspaceQueryKeys.assets(apiBaseUrl, authScope),
              "availability-dependencies",
              asset.name,
              owner ?? ""
            ],
            read: async (form: AgentAvailabilityForm, signal: AbortSignal) =>
              (
                await client.assets.get({
                  params: { kind, name: asset.name },
                  query: { ...scope, ...availabilityPreviewQuery(form) },
                  signal
                })
              ).dependencyAvailability ?? null
          }
        }
      : {}),
    save: (next, { makeDependenciesAvailable }) =>
      placement.setAvailability
        .mutateAsync({
          kind,
          name: asset.name,
          assetId: asset.id,
          loaded: saved,
          ...next,
          // Only an agent uses other assets: what it uses is read for its live revision.
          ...(kind === "agent" ? { expectedRevision: asset.revision } : {}),
          ...(kind === "agent" && makeDependenciesAvailable
            ? { makeDependenciesAvailable: true }
            : {})
        })
        .then(
          (stored) => {
            setSaved(stored);
            return undefined;
          },
          (error: unknown) => apiErrorMessage(error, t("configChangeSaveFailed"))
        )
  };
}
