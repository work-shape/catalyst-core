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
  type AssetOwnerReach,
  type ConfigAssetRecord,
  type LocaleCode,
  ownerReachRefusal
} from "@work-shape/catalyst-core";
import type { AssetWorkflowOptions } from "../types";
import { assertOwnerReach } from "../assets/asset-owner-references";
import { workspaceDisplayName } from "../publish-narrative/workspace-name";

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
  audience?: AppAudience,
  actor?: AuthenticatedIdentity
): Promise<{
  selected: AppAudience;
  live?: AppAudience;
  liveLabel?: string;
  people?: number;
  choices: AppAudience[];
  label: string;
  workspaceName?: string;
}> {
  requireAppAudience(access, audience);
  const workspace =
    asset.scope.kind === "workspace"
      ? await options.stores.workspaces.getWorkspace(
          options.clientInstanceId,
          asCollaborationWorkspaceId(asset.scope.workspaceId)
        )
      : undefined;
  // The workspace by the name the interface shows: a Personal Workspace after its owner.
  const workspaceName = workspace
    ? await workspaceDisplayName(
        workspace,
        locale,
        async (userId) =>
          (
            await options.stores.users.getUser({
              clientInstanceId: options.clientInstanceId,
              userId: asUserId(userId)
            })
          )?.displayLabel
      )
    : undefined;
  const live = asset.publishedRevisionId
    ? (asset.appAvailability?.audience ?? "workspace")
    : undefined;
  const choices: AppAudience[] = ["self"];
  if (workspace?.kind !== "personal") choices.push("workspace");
  // "Alle" only for an App of the instance or a Shared Workspace (MOVE-1, `assertOwnerReach`).
  const owner: AssetOwnerReach =
    asset.scope.kind === "instance"
      ? { kind: "instance" }
      : { kind: "workspace", workspaceId: asset.scope.workspaceId, workspaceKind: workspace?.kind };
  if (
    access.authorize("app.publish").allowed &&
    ownerReachRefusal(owner, { kind: "app_audience", audience: "instance" }) === undefined
  )
    choices.push("instance");
  const suggested = audience ?? live ?? "self";
  const selected = choices.includes(suggested)
    ? suggested
    : suggested === "workspace" && workspace?.kind === "personal"
      ? "self"
      : (choices.at(-1) ?? "self");
  const labelOf = (choice: AppAudience) =>
    choice === "self"
      ? locale === "de"
        ? "Nur für mich"
        : "Only me"
      : choice === "instance"
        ? locale === "de"
          ? "Alle in der Instanz"
          : "Everyone in the instance"
        : locale === "de"
          ? `Alle in ${workspaceName ?? "diesem Arbeitsbereich"}`
          : `Everyone in ${workspaceName ?? "this workspace"}`;
  const livePerson =
    live === "self" &&
    asset.appAvailability?.userId &&
    (!actor ||
      isAuthenticatedServicePrincipal(actor) ||
      asset.appAvailability.userId !== getSubjectUserId(actor))
      ? await options.stores.users.getUser({
          clientInstanceId: options.clientInstanceId,
          userId: asUserId(asset.appAvailability.userId)
        })
      : undefined;
  const liveLabel = livePerson
    ? locale === "de"
      ? `Nur für ${livePerson.displayLabel}`
      : `Only ${livePerson.displayLabel}`
    : live
      ? labelOf(live)
      : undefined;
  const people =
    selected === "self"
      ? 1
      : selected === "instance"
        ? await options.stores.users.countActiveUsers({
            clientInstanceId: options.clientInstanceId
          })
        : workspace
          ? (
              await options.stores.workspaces.countMembersOfWorkspaces({
                clientInstanceId: options.clientInstanceId,
                collaborationWorkspaceIds: [workspace.id]
              })
            )[0]?.members
          : undefined;
  return {
    selected,
    choices,
    label: labelOf(selected),
    ...(live && liveLabel ? { live, liveLabel } : {}),
    ...(people === undefined ? {} : { people }),
    ...(workspaceName === undefined ? {} : { workspaceName })
  };
}

/** Only me selects the person publishing. A legacy request without a choice keeps the live
 * recipient instead, so omission never silently hands somebody else the private App. */
function appAudiencePerson(
  actor: AuthenticatedIdentity,
  asset: ConfigAssetRecord,
  chosen: AppAudience | undefined,
  audience: AppAudience
): UserId | undefined {
  if (audience !== "self") return undefined;
  if (chosen === undefined && asset.publishedRevisionId && asset.appAvailability?.userId)
    return asUserId(asset.appAvailability.userId);
  if (isAuthenticatedServicePrincipal(actor))
    throw new AppError("FORBIDDEN", "Only me needs a person publishing the App");
  return asUserId(getSubjectUserId(actor));
}

/** Resolve omission once for the committing path: first publishes are private; later ones
 * preserve the live audience without asking a right for a choice the person never made. An
 * App of a Personal Workspace is never published for the whole instance: one already live so
 * keeps running, and the rule meets it at its next publish (MOVE-1). */
export async function prepareAppPublication(
  options: Pick<AssetWorkflowOptions, "stores" | "clientInstanceId">,
  call: { actor: AuthenticatedIdentity; access: ActorAccess },
  asset: ConfigAssetRecord,
  chosen: AppAudience | undefined,
  locale: LocaleCode
) {
  const audience =
    chosen ??
    (asset.publishedRevisionId ? (asset.appAvailability?.audience ?? "workspace") : "self");
  requireAppAudience(call.access, chosen);
  await assertOwnerReach(options, asset, { kind: "app_audience", audience }, locale);
  const person = appAudiencePerson(call.actor, asset, chosen, audience);
  const personalWorkspace = person
    ? await options.stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId: options.clientInstanceId,
        userId: person
      })
    : undefined;
  return { audience, personalWorkspace };
}
