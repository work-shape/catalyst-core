import { requireAppAudience } from "../../apps/app-audience";
import type {
  AppAudience,
  AuthenticatedIdentity,
  ActorAccess,
  OperationApproval,
  OperationAuthorization,
  OperationOrigin
} from "@work-shape/catalyst-core";
import { decide } from "../asset-access";
import { requireAssetManagementOn } from "../asset-write-rules";
import type { AssetAddress } from "../asset-target";
import { liveRevision } from "../asset-live-revision";
import { appPublishReview } from "../../apps/app-publish-reach";
import { publishApproval, publishFromAPerson } from "../../approvals/publish-approval";
import type { AssetVerbScope } from "./scope";

/**
 * The publish right of the kind and the kind's own check of the revision it makes live. A
 * kind without a published revision names none, and a call on it passes here to be refused
 * for that by the operation itself.
 */
export async function authorizeAssetPublish(
  scope: AssetVerbScope,
  caller: { actor: AuthenticatedIdentity; access: ActorAccess; origin: OperationOrigin },
  address: AssetAddress & {
    revision: number;
    audience?: AppAudience;
    makeDependenciesAvailable?: boolean;
  }
): Promise<OperationAuthorization> {
  const { access, origin } = caller;
  if (address.kind === "app") requireAppAudience(access, address.audience);
  if (address.kind === "agent")
    return scope.agentDrafts.authorizePublish(
      { ...caller, audit: scope.options.auditRecorder, correlationId: "" },
      address
    );
  requireAssetManagementOn(scope.options, access, "put");
  const target = await scope.target(address);
  const { publish } = target.kind.actions;
  if (publish === undefined) return { allowed: true };
  const right = publishFromAPerson(target, origin) ?? decide(access, publish, target.resource);
  // What the revision lends is asked of the caller now too: a publish that waits for an
  // approval is filed only where its caller could make it live.
  if (right.allowed && target.asset?.status === "active") {
    await liveRevision(scope.options, caller, target, address.revision);
  }
  return right;
}

/**
 * Who decides a publish that a guardrail holds: the holders of the kind's `approve` right,
 * and the caller's own click where they hold it. None for a kind whose publish is not held.
 */
export async function assetPublishApproval(
  scope: AssetVerbScope,
  input: AssetAddress & { revision: number; audience?: AppAudience }
): Promise<OperationApproval | undefined> {
  const target = await scope.target(input);
  const asset = target.asset;
  const revision =
    target.kind.kind === "app"
      ? await scope.options.configAssets.store.getConfigAssetRevision({
          clientInstanceId: scope.options.clientInstanceId,
          kind: input.kind,
          name: input.name,
          revision: input.revision
        })
      : undefined;
  const widens =
    asset && revision?.config
      ? appPublishReview(asset, target.kind, revision.config, input.audience).publishWidens
      : undefined;
  return publishApproval(target, input.revision, input.audience, undefined, widens);
}
