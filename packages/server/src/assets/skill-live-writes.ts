import {
  AppError,
  assetScopesEqual,
  createAuthorizer,
  hasAuthScope,
  isAuthenticatedServicePrincipal,
  type AccessResource,
  type ActorAccess,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type ConfigAssetRecord,
  type JsonObject,
  type OperationBeforeEvent
} from "@work-shape/catalyst-core";
import { skillConfigSchema } from "@work-shape/catalyst-config-schema";
import { ApprovalRequestWorkflow } from "../approvals/approval-request-service";
import {
  SKILL_CHANGE_KIND,
  filedSkillChangePayload,
  filedSkillChangeOf
} from "../approvals/skill-change-filed";
import type { ApprovalRequestWorkflowOptions } from "../approvals/approval-request-service";
import type { AssetWorkflowOptions } from "../types";
import { configValuesEqual } from "../asset-kinds/shared";
import { accessResource } from "./asset-access";
import { scopeOf } from "./asset-target";
import { skillLiveNeedsPublish } from "./shared-drafts";

type GateOptions = Pick<AssetWorkflowOptions, "clientInstanceId" | "stores">;

/**
 * `skill.publish` on the skill, for this call. A person's right on a credential that may
 * publish: a service principal publishes no skill, and a key with `config_assets:write` alone
 * does not either.
 */
function makesSkillLive(
  actor: AuthenticatedIdentity,
  access: ActorAccess,
  resource: AccessResource
): boolean {
  return (
    !isAuthenticatedServicePrincipal(actor) &&
    hasAuthScope(actor, "config_assets:publish") &&
    access.authorize("skill.publish", resource).allowed
  );
}

/**
 * What a write of a skill that is there does (SKILL-LIVE-1): `live` writes a new live revision
 * that `skill.before_publish` answers too, `personal` writes one of a Personal Workspace, and
 * `request` leaves the live revision and files a `skill_change` request.
 */
export async function skillWriteOutcome(
  options: GateOptions,
  call: { actor: AuthenticatedIdentity; access: ActorAccess },
  asset: Pick<ConfigAssetRecord, "scope">,
  resource: AccessResource
): Promise<"live" | "personal" | "request"> {
  if (!(await skillLiveNeedsPublish(options, asset.scope))) return "personal";
  return makesSkillLive(call.actor, call.access, resource) ? "live" : "request";
}

/**
 * The refusal of a write of a skill with a draft from before SKILL-LIVE-1: the write would leave
 * the draft behind the live revision, where it could no longer be published. Nothing for a skill
 * with none.
 */
export async function pendingSkillDraftRefusal(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "stores">,
  asset: Pick<ConfigAssetRecord, "id" | "name">
): Promise<AppError | undefined> {
  const draft = await options.stores.agentProposals.get({
    clientInstanceId: options.clientInstanceId,
    agentId: asset.id
  });
  if (!draft) return undefined;
  return new AppError(
    "CONFLICT",
    `The skill '${asset.name}' has an unpublished draft from before skills went live on save. Publish it with 'catalyst skill publish ${asset.name} --revision ${String(draft.revision)}' or on the skill page, or discard it, then write again`,
    { reason: "skill_draft_pending", draftRevision: draft.revision }
  );
}

/** The request form of who files: a service principal files under its own id and name. */
function filerOf(actor: AuthenticatedIdentity): AuthenticatedUser {
  if (!isAuthenticatedServicePrincipal(actor)) return actor;
  return {
    id: actor.id,
    externalUserId: actor.id,
    displayLabel: actor.displayLabel,
    roles: [],
    permissionRefs: actor.permissionRefs,
    permissions: actor.permissions,
    clientInstanceId: actor.clientInstanceId,
    authSource: actor.authSource,
    principal: {
      kind: "service",
      id: actor.id,
      displayLabel: actor.displayLabel,
      clientInstanceId: actor.clientInstanceId,
      authSource: actor.authSource
    },
    scopes: actor.scopes
  };
}

/** What one filing asks of the instance: its requests, and the store the request lands in. */
export interface SkillChangeFiling {
  actor: AuthenticatedIdentity;
  correlationId: string;
  locale?: string;
  asset: ConfigAssetRecord;
  config: JsonObject;
  fileSetId?: string;
  operation?: "revert";
}

/**
 * Files a whole change of a skill for `skill.approve` to decide, and answers the request: the
 * caller's own pending request for the same change where one is open, so that a push sent again
 * files no second one. `store` is the transaction's where the filing commits with a batch.
 */
export async function fileSkillChange(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "auditRecorder"> & {
    approvalRequests?: Pick<ApprovalRequestWorkflowOptions, "store" | "handlers" | "checks">;
  },
  filing: SkillChangeFiling,
  store?: ApprovalRequestWorkflowOptions["store"]
): Promise<{ id: string; existing?: true }> {
  const approvals = options.approvalRequests;
  if (!approvals?.handlers.has(SKILL_CHANGE_KIND)) {
    throw new AppError(
      "CONFLICT",
      "This instance takes no skill changes for approval: the change needs skill.publish",
      { reason: "no_skill_change_requests" }
    );
  }
  const filer = filerOf(filing.actor);
  const requests = store ?? approvals.store;
  const open = await requests.listApprovalRequests({
    clientInstanceId: options.clientInstanceId,
    kinds: [SKILL_CHANGE_KIND],
    status: "pending",
    requestedById: filer.id,
    page: { limit: 50 }
  });
  const same = open.find((request) => {
    const filed = filedSkillChangeOf(request.payload);
    return (
      filed?.skillName === filing.asset.name &&
      filed.proposed.baseRevision === filing.asset.revision &&
      configValuesEqual(filed.proposed.config, filing.config)
    );
  });
  if (same) return { id: same.id, existing: true };
  const workflow = new ApprovalRequestWorkflow({
    ...approvals,
    store: requests,
    clientInstanceId: options.clientInstanceId,
    auditRecorder: options.auditRecorder
  });
  const parsed = skillConfigSchema.safeParse(filing.config);
  const title = parsed.success ? parsed.data.title : filing.asset.name;
  const request = await workflow.createRequest(
    filer,
    { correlationId: filing.correlationId },
    {
      kind: SKILL_CHANGE_KIND,
      summary:
        filing.locale === "de"
          ? `Änderung an „${title}“ zur Freigabe`
          : `Change to "${title}" for approval`,
      payload: filedSkillChangePayload(filing.asset, filing.config, {
        ...(filing.fileSetId === undefined ? {} : { fileSetId: filing.fileSetId }),
        ...(filing.operation === undefined ? {} : { operation: filing.operation })
      })
    }
  );
  return { id: request.id };
}

/** What asks whether a write of a skill goes live behind `skill.before_publish`. */
export interface SkillLiveCheck {
  options: Pick<
    AssetWorkflowOptions,
    "clientInstanceId" | "configAssets" | "stores" | "authorizer"
  >;
  /** The call's actor. Without one the publish event is asked, the safer of the two. */
  actor: AuthenticatedIdentity | undefined;
}

/**
 * The events of a write as its guardrails answer it, with `skill.before_publish` of a save that
 * makes a team's or the instance's skill live (SKILL-LIVE-1). A write that files a request is
 * asked it when the request is approved. A new skill and a personal one have no publish.
 */
export async function withSkillLiveEvent(
  check: SkillLiveCheck,
  address: { kind: string; name: string; workspaceId?: string },
  events: readonly OperationBeforeEvent[]
): Promise<OperationBeforeEvent[]> {
  const write = events[0];
  if (address.kind !== "skill" || write === undefined) return [...events];
  const { options, actor } = check;
  const asset = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: "skill",
    name: address.name
  });
  if (asset?.status !== "active" || !assetScopesEqual(asset.scope, scopeOf(address.workspaceId)))
    return [...events];
  const resource = accessResource("skill", asset.name, asset.scope, asset.id);
  const authorizer = options.authorizer ?? createAuthorizer(options.stores.access);
  const outcome = actor
    ? await skillWriteOutcome(
        options,
        { actor, access: await authorizer.forActor(actor) },
        asset,
        resource
      )
    : "live";
  if (outcome !== "live") return [...events];
  return [
    ...events,
    {
      ...write,
      name: "skill.before_publish",
      subject: {
        ...write.subject,
        id: asset.id,
        ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
      }
    }
  ];
}
