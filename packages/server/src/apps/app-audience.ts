import {
  AppError,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  asUserId,
  type AuthenticatedIdentity,
  type UserId,
  asCollaborationWorkspaceId,
  type ActorAccess,
  type AppAudience,
  type ConfigAssetRecord,
  type LocaleCode
} from "@work-shape/catalyst-core";
import type { AssetWorkflowOptions } from "../types";

/** Only an instance publish right may offer or dispatch an instance audience. An asset or
 * workspace grant cannot stand in for it. This same gate runs again when a held call resumes. */
export function requireAppAudience(access: ActorAccess, audience: AppAudience | undefined): void {
  if (audience === "instance") access.require("app.publish");
}

export async function appAudienceReview(
  options: Pick<AssetWorkflowOptions, "stores" | "clientInstanceId">,
  asset: ConfigAssetRecord,
  access: ActorAccess,
  locale: LocaleCode,
  audience?: AppAudience
): Promise<{
  selected: AppAudience;
  choices: AppAudience[];
  label: string;
  workspaceName?: string;
}> {
  const selected =
    audience ??
    (asset.publishedRevisionId ? (asset.appAvailability?.audience ?? "workspace") : "self");
  requireAppAudience(access, audience);
  const workspace =
    asset.scope.kind === "workspace"
      ? await options.stores.workspaces.getWorkspace(
          options.clientInstanceId,
          asCollaborationWorkspaceId(asset.scope.workspaceId)
        )
      : undefined;
  const label =
    selected === "self"
      ? locale === "de"
        ? "Nur für den Ersteller"
        : "Only the builder"
      : selected === "instance"
        ? locale === "de"
          ? "Alle in der Instanz"
          : "Everyone in the instance"
        : locale === "de"
          ? `Alle in ${workspace?.name ?? "diesem Arbeitsbereich"}`
          : `Everyone in ${workspace?.name ?? "this workspace"}`;
  const choices: AppAudience[] = ["self", "workspace"];
  if (access.authorize("app.publish").allowed) choices.push("instance");
  return { selected, choices, label, ...(workspace ? { workspaceName: workspace.name } : {}) };
}

/** Only me selects the person publishing. A legacy request without a choice keeps the live
 * recipient instead, so omission never silently hands somebody else the private App. */
export function appAudiencePerson(
  actor: AuthenticatedIdentity,
  asset: ConfigAssetRecord,
  chosen: AppAudience | undefined,
  audience: AppAudience
): UserId | undefined {
  if (audience !== "self") return undefined;
  if (chosen === undefined && asset.appAvailability?.userId)
    return asUserId(asset.appAvailability.userId);
  if (isAuthenticatedServicePrincipal(actor))
    throw new AppError("FORBIDDEN", "Only me needs a person publishing the App");
  return asUserId(getSubjectUserId(actor));
}
