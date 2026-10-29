import {
  AppError,
  DATA_STORE_ASSET_KIND,
  WORKFLOW_ASSET_KIND,
  asCollaborationWorkspaceId,
  asUserId,
  assetMoveLadderRefusal,
  assetOwnerRung,
  assetScopesEqual,
  auditActorFromIdentity,
  authenticatedUserFromRecord,
  createAuthorizer,
  isAuthenticatedServicePrincipal,
  ownerReachRefusal,
  type AccessAdministrationStore,
  type AccessResource,
  type ActorAccess,
  type AssetKindRegistry,
  type AssetMoveEditors,
  type AssetMovePath,
  type AssetMoveUsers,
  type AssetOwnerReach,
  type AssetOwnerRung,
  type ApiAccessStore,
  type AssetScope,
  type AuditActor,
  type AuditEventStore,
  type AuthenticatedIdentity,
  type Authorizer,
  type ClientInstanceId,
  type CollaborationWorkspace,
  type CollaborationWorkspaceStore,
  type ConfigAssetRecord,
  type ConfigAssetStore,
  type JsonObject,
  type LocaleCode,
  type ModuleSnapshot,
  type PermissionGrant,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { readDefinitionField, type WorkflowAssetKind } from "../asset-kinds/shared";
import { assertOwnerReach } from "./asset-owner-references";
import { assetKindLabel, assetTitle } from "./asset-reference-labels";
import { requireAssetKindModuleOn } from "./asset-write-rules";

// SHARE-1 "Teilen mit…": an asset moves up the ladder Nur ich → Team → Alle with what it uses,
// never down or sideways (Felix and the manager, 2026-10-28; it generalises MOVE-1). Only who
// holds the asset where it lies moves it: the owner of a Personal Workspace, or whoever may
// change everything that goes from a team. The move changes the owner: ids, names, revisions,
// drafts, availability, rows and runs stay, so whatever is keyed by the asset follows by
// itself. Editing follows the new place, so the grants that edited the asset at the old one go
// (`grantsLeavingWith`). With the right at the target the move is made at once; without it, it
// becomes a request an admin with that right decides in the Inbox (`asset-move-approval.ts`).

/** What a move or its check is given. The address is where the asset is now. */
export interface AssetMoveInput {
  kind: string;
  name: string;
  /** The workspace that owns the asset now; left out for the instance's own. */
  workspaceId?: string;
  to: { kind: "instance" } | { kind: "workspace"; workspaceId: string };
  /** The id of the asset as the caller read it. Another asset of the name is a conflict. */
  expectedAssetId?: string;
  /** The caller read what breaks and moves it all the same. */
  acceptBreaks?: boolean;
}

/** What the planning reads: the stores of the instance and its kinds. */
export interface AssetMoveOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  kinds: AssetKindRegistry<WorkflowAssetKind>;
  modules: ModuleSnapshot;
  /** Who may do what; a request's requester is asked again when it is decided. */
  authorizer?: Authorizer;
  /** The approval kinds of the instance: a member with one of them open is not moved. */
  approvalKinds(): readonly string[];
}

/** One asset of the move. */
interface MoveMember {
  kind: WorkflowAssetKind;
  record: ConfigAssetRecord;
  title: string;
}

/** An asset that stays where it is and can no longer use a moved one afterwards. */
interface MoveBreak {
  kind: string;
  name: string;
  title: string;
  uses: { kind: string; name: string };
}

export interface AssetMovePlan {
  root: MoveMember;
  from: AssetScope;
  to: AssetScope;
  fromReach: AssetOwnerReach;
  toReach: AssetOwnerReach;
  fromWorkspace?: CollaborationWorkspace;
  toWorkspace?: CollaborationWorkspace;
  locale: LocaleCode;
  /** How many grants the move takes away, as they stand when it is planned. */
  grantsLeaving: { onAssets: number; runAccounts: number };
  /** The asset first, then what it uses that would otherwise stay below it. */
  members: MoveMember[];
  breaks: MoveBreak[];
}

/** The approval kind a request to move an asset of this kind is filed as. */
export function assetMoveApprovalKind(kind: string): string {
  return `${kind}_move`;
}

/** The kinds that a workspace may own, which are the ones that can be moved up. */
export function movableKinds(kinds: AssetKindRegistry<WorkflowAssetKind>): WorkflowAssetKind[] {
  return kinds.kinds.filter((kind) => kind.owners.includes("workspace"));
}

/** What a right at the target is asked on: the kind at the owner the move goes to. */
export function moveTargetResource(
  kind: string,
  to: { kind: "instance" } | { kind: "workspace"; workspaceId: string }
): AccessResource {
  return { kind, ...(to.kind === "workspace" ? { workspaceId: to.workspaceId } : {}) };
}

/**
 * Plans the move of one asset and refuses, with a plain sentence, what cannot move: not a step
 * up, a kind the target cannot own, a team the person is not a member of, an open approval, a
 * reference owner reach refuses at the target, or a build limit of the team. The plan is read
 * again when the move is made, and the store refuses it if a member changed in between.
 */
export async function planAssetMove(
  options: AssetMoveOptions,
  input: AssetMoveInput,
  locale: LocaleCode,
  caller?: { actor: AuthenticatedIdentity; access: ActorAccess }
): Promise<AssetMovePlan> {
  const actor = caller?.actor;
  const { stores, clientInstanceId } = options;
  const de = locale === "de";
  requireAssetKindModuleOn(options.modules, input.kind);
  const rootKind = options.kinds.require(input.kind);
  const from = scopeOf(input.workspaceId);
  const row = await stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: rootKind.kind,
    name: input.name
  });
  if (!row || row.status !== "active" || row.config === null || !assetScopesEqual(row.scope, from))
    throw new AppError("NOT_FOUND", `Config ${rootKind.kind} '${input.name}' was not found`);
  if (input.expectedAssetId !== undefined && input.expectedAssetId !== row.id)
    throw new AppError(
      "CONFLICT",
      `Config ${rootKind.kind} '${input.name}' is another asset than the one this move was made for`,
      { kind: rootKind.kind, name: input.name, reason: "asset_replaced" }
    );
  const to = scopeOf(input.to.kind === "workspace" ? input.to.workspaceId : undefined);
  const workspaces = new Map<string, Promise<CollaborationWorkspace | undefined>>();
  const workspaceOf = (id: string) => {
    let read = workspaces.get(id);
    if (!read) {
      read = stores.workspaces.getWorkspace(clientInstanceId, asCollaborationWorkspaceId(id));
      workspaces.set(id, read);
    }
    return read;
  };
  const reachOf = async (scope: AssetScope): Promise<AssetOwnerReach> =>
    scope.kind === "instance"
      ? { kind: "instance" }
      : {
          kind: "workspace",
          workspaceId: scope.workspaceId,
          workspaceKind: (await workspaceOf(scope.workspaceId))?.kind
        };
  const toWorkspace = to.kind === "workspace" ? await workspaceOf(to.workspaceId) : undefined;
  if (to.kind === "workspace" && !toWorkspace)
    throw new AppError(
      "VALIDATION_FAILED",
      de
        ? "Diesen Arbeitsbereich gibt es auf dieser Instanz nicht."
        : "This workspace does not exist on this instance.",
      { reason: "workspace_not_found" }
    );
  const [fromReach, toReach] = await Promise.all([reachOf(from), reachOf(to)]);
  const placeOf = (reach: AssetOwnerReach, workspace?: CollaborationWorkspace) =>
    ownerPlace(reach, workspace?.name, de);
  const fromPlace = placeOf(
    fromReach,
    from.kind === "workspace" ? await workspaceOf(from.workspaceId) : undefined
  );
  const toPlace = placeOf(toReach, toWorkspace);
  const titleOf = (kind: WorkflowAssetKind, record: ConfigAssetRecord) =>
    assetTitle(options.kinds.kinds, kind.kind, record.name, record.config ?? {}, locale);
  const label = (kind: string, name: string) => `${assetKindLabel(kind, locale)} „${name}“`;
  const rootLabel = label(rootKind.kind, row.name);

  const ladder = assetMoveLadderRefusal(fromReach, toReach);
  if (ladder !== undefined)
    throw refusal(
      ladder,
      ladder === "move_same_place"
        ? de
          ? `${rootLabel} gehört schon ${toPlace}.`
          : `${rootLabel} already belongs to ${toPlace}.`
        : ladder === "move_down"
          ? de
            ? `${rootLabel} gehört ${fromPlace}. Teilen geht nur nach oben, von „Nur ich“ zu einem Team und von einem Team zu Alle, nie zurück. Wer eine eigene Fassung braucht, dupliziert es.`
            : `${rootLabel} belongs to ${fromPlace}. Sharing only goes up, from "Only me" to a team and from a team to everyone, never back. If you need a version of your own, duplicate it.`
          : de
            ? `${rootLabel} gehört ${fromPlace}. Von dort geht Teilen nur nach oben, nicht ${assetOwnerRung(fromReach) === "team" ? "in ein anderes Team" : "in einen anderen persönlichen Arbeitsbereich"}.`
            : `${rootLabel} belongs to ${fromPlace}. From there sharing only goes up, not to ${assetOwnerRung(fromReach) === "team" ? "another team" : "another Personal Workspace"}.`,
      { from, to }
    );
  // Only a team the person belongs to: the place decides who edits, and they stay among them.
  if (
    to.kind === "workspace" &&
    actor !== undefined &&
    !isAuthenticatedServicePrincipal(actor) &&
    !(await stores.workspaces.getMembership({
      clientInstanceId,
      collaborationWorkspaceId: to.workspaceId,
      userId: asUserId(actor.id)
    }))
  )
    throw refusal(
      "move_not_member",
      de
        ? `Du bist nicht Mitglied von ${toPlace}. Teilen geht nur mit einem Team, in dem du Mitglied bist.`
        : `You are not a member of ${toPlace}. You can share only with a team you belong to.`,
      { to }
    );

  // The closure: what a member uses and its owner holds, followed until nothing new is found.
  const records = new Map<string, Promise<ConfigAssetRecord | undefined>>();
  const recordOf = (kind: string, name: string) => {
    const key = `${kind}:${name}`;
    let read = records.get(key);
    if (!read) {
      read =
        key === `${row.kind}:${row.name}`
          ? Promise.resolve(row)
          : stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
      records.set(key, read);
    }
    return read;
  };
  const referencesOf = async (kind: WorkflowAssetKind, record: ConfigAssetRecord) =>
    usedBy(options, kind, record);
  const root: MoveMember = { kind: rootKind, record: row, title: titleOf(rootKind, row) };
  const members: MoveMember[] = [root];
  const memberIds = new Set([row.id]);
  for (let index = 0; index < members.length; index++) {
    const member = members[index];
    if (!member) break;
    for (const reference of await referencesOf(member.kind, member.record)) {
      const kind = options.kinds.get(reference.kind);
      const used = kind ? await recordOf(reference.kind, reference.name) : undefined;
      if (!kind || !used || used.status !== "active" || memberIds.has(used.id)) continue;
      if (!assetScopesEqual(used.scope, from)) continue;
      memberIds.add(used.id);
      members.push({ kind, record: used, title: titleOf(kind, used) });
    }
  }
  const fromWorkspace = from.kind === "workspace" ? await workspaceOf(from.workspaceId) : undefined;
  // Before anything else is said about what goes: only who holds it where it lies moves it.
  if (caller)
    requireMoveSource(
      { fromReach, from, members, locale, ...(fromWorkspace ? { fromWorkspace } : {}) },
      caller.actor,
      caller.access
    );
  for (const member of members) {
    if (!member.kind.owners.includes(to.kind))
      throw refusal(
        "move_kind_owner",
        de
          ? `${label(member.kind.kind, member.record.name)} kann nicht Allen gehören: ${assetKindLabel(member.kind.kind, locale)}s gehören immer einem Team. Teile ${member === members[0] ? "es" : rootLabel} mit einem Team.`
          : `${label(member.kind.kind, member.record.name)} cannot belong to everyone: ${assetKindLabel(member.kind.kind, locale)}s always belong to a team. Share ${member === members[0] ? "it" : rootLabel} with a team instead.`,
        { asset: { kind: member.kind.kind, name: member.record.name }, to }
      );
  }
  await refuseOpenApprovals(options, members, label, de);
  await refuseBeyondBuildLimits(members, toWorkspace, toPlace, label, de);

  // Every move passes owner reach at the target (#142): each member as it will be owned, and
  // each asset it uses as it will be owned after the move.
  const reach = { clientInstanceId, stores };
  for (const member of members) {
    const source = { kind: member.kind.kind, name: member.record.name, scope: to };
    for (const reference of await referencesOf(member.kind, member.record)) {
      const used = options.kinds.get(reference.kind)
        ? await recordOf(reference.kind, reference.name)
        : undefined;
      if (!used || used.status !== "active") continue;
      await assertOwnerReach(
        reach,
        source,
        {
          kind: "reference",
          target: {
            kind: reference.kind,
            name: reference.name,
            scope: memberIds.has(used.id) ? to : used.scope
          },
          acrossOwners: member.kind.crossOwnerReferences?.includes(reference.kind) === true,
          sourceUnread: false
        },
        locale
      );
    }
    if (member.kind.hasWorkspaceAvailability) {
      const availability = (
        await stores.configAssets.listAgentAvailability({
          clientInstanceId,
          agentName: member.record.name,
          kind: member.kind.kind
        })
      ).get(member.record.name);
      if (availability)
        await assertOwnerReach(reach, source, { kind: "availability", availability }, locale);
    }
    const audience = member.record.appAvailability?.audience;
    if (audience !== undefined)
      await assertOwnerReach(reach, source, { kind: "app_audience", audience }, locale);
  }

  const planned = { root, from, to, members };
  const leaving = await grantsLeavingWith(stores, clientInstanceId, planned);
  return {
    ...planned,
    fromReach,
    toReach,
    ...(fromWorkspace ? { fromWorkspace } : {}),
    ...(toWorkspace ? { toWorkspace } : {}),
    locale,
    grantsLeaving: { onAssets: leaving.onAssets.length, runAccounts: leaving.runAccounts.length },
    breaks: await findBreaks(options, { from, fromReach, toReach, memberIds, members, titleOf })
  };
}

/**
 * Who may move an asset out of where it lies: the owner of a Personal Workspace, nobody else,
 * whatever rights they hold; from a team or the instance, whoever may change every asset that
 * goes. A request is filed only for who passes here.
 */
function requireMoveSource(
  plan: Pick<AssetMovePlan, "fromReach" | "fromWorkspace" | "from" | "members" | "locale">,
  actor: AuthenticatedIdentity,
  access: ActorAccess
): void {
  const de = plan.locale === "de";
  if (assetOwnerRung(plan.fromReach) === "personal") {
    if (
      isAuthenticatedServicePrincipal(actor) ||
      plan.fromWorkspace?.personalUserId == null ||
      plan.fromWorkspace.personalUserId !== actor.id
    )
      throw new AppError(
        "FORBIDDEN",
        de
          ? "Nur wer diesen persönlichen Arbeitsbereich besitzt, kann teilen, was darin liegt."
          : "Only the owner of this Personal Workspace can share what is in it.",
        { reason: "move_not_owner" }
      );
    return;
  }
  const missing = unchangeableMember(plan, access);
  if (missing)
    throw new AppError(
      "FORBIDDEN",
      de
        ? `Du darfst ${assetKindLabel(missing.kind.kind, plan.locale)} „${missing.record.name}“ nicht ändern, und es geht mit. Teilen kann nur, wer alles ändern darf, was mitgeht.`
        : `You may not change ${assetKindLabel(missing.kind.kind, plan.locale)} "${missing.record.name}", and it goes along. Only who may change everything that goes along can share it.`,
      {
        reason: "move_source_right",
        action: missing.kind.actions.write,
        asset: { kind: missing.kind.kind, name: missing.record.name }
      }
    );
}

/** The first asset that goes along which this access may not change where it lies. */
function unchangeableMember(
  plan: Pick<AssetMovePlan, "from" | "members">,
  access: ActorAccess
): MoveMember | undefined {
  return plan.members.find(({ kind, record }) => {
    const resource: AccessResource = {
      kind: kind.kind,
      name: record.name,
      assetId: record.id,
      ...(plan.from.kind === "workspace" ? { workspaceId: plan.from.workspaceId } : {})
    };
    return !access.authorize(kind.actions.write, resource).allowed;
  });
}

/**
 * Why a request filed by this person no longer moves anything when it is decided: their
 * account is no longer active, the Personal Workspace it comes from is no longer theirs, they
 * may no longer change everything that goes from a team, or they left the team it goes to.
 * Undefined while they still could have moved it, as `requireMoveSource` asks it at filing.
 */
export async function requesterRefusal(
  options: Pick<AssetMoveOptions, "clientInstanceId" | "stores" | "authorizer">,
  plan: AssetMovePlan,
  requesterId: string
): Promise<{ reason: string; message: string } | undefined> {
  const de = plan.locale === "de";
  const userId = asUserId(requesterId);
  const user = await options.stores.users.getUser({
    clientInstanceId: options.clientInstanceId,
    userId
  });
  if (user?.status !== "active")
    return {
      reason: "move_requester_inactive",
      message: de
        ? "Das Konto der Person, die das Teilen angefragt hat, ist nicht mehr aktiv. Es wurde nichts geteilt."
        : "The account of the person who asked to share it is no longer active. Nothing was shared."
    };
  if (
    assetOwnerRung(plan.fromReach) === "personal" &&
    plan.fromWorkspace?.personalUserId !== userId
  )
    return {
      reason: "move_requester_not_owner",
      message: de
        ? "Der persönliche Arbeitsbereich, aus dem geteilt werden sollte, gehört nicht mehr der Person, die angefragt hat. Es wurde nichts geteilt."
        : "The Personal Workspace it was to be shared from no longer belongs to the person who asked. Nothing was shared."
    };
  if (assetOwnerRung(plan.fromReach) !== "personal") {
    const requester = authenticatedUserFromRecord({
      user,
      identity: { authSource: "approval-decision", externalUserId: user.id }
    });
    const access = await (options.authorizer ?? createAuthorizer(options.stores.access)).forActor(
      requester
    );
    const missing = unchangeableMember(plan, access);
    if (missing)
      return {
        reason: "move_requester_source_right",
        message: de
          ? `Die Person, die angefragt hat, darf ${assetKindLabel(missing.kind.kind, plan.locale)} „${missing.record.name}“ nicht mehr ändern, und es geht mit. Es wurde nichts geteilt.`
          : `The person who asked may no longer change ${assetKindLabel(missing.kind.kind, plan.locale)} "${missing.record.name}", and it goes along. Nothing was shared.`
      };
  }
  if (
    plan.to.kind === "workspace" &&
    !(await options.stores.workspaces.getMembership({
      clientInstanceId: options.clientInstanceId,
      collaborationWorkspaceId: plan.to.workspaceId,
      userId
    }))
  )
    return {
      reason: "move_requester_not_member",
      message: de
        ? `Die Person, die angefragt hat, ist nicht mehr Mitglied von „${plan.toWorkspace?.name ?? "Team"}“. Es wurde nichts geteilt.`
        : `The person who asked is no longer a member of "${plan.toWorkspace?.name ?? "the team"}". Nothing was shared.`
    };
  return undefined;
}

/** The stores a move writes through, in one transaction: the request's decision or its own. */
export interface AssetMoveWriteStores {
  configAssets: Pick<ConfigAssetStore, "moveConfigAssets" | "listActiveConfigAssets">;
  audit: Pick<AuditEventStore, "appendAuditEvent">;
  access: Pick<AccessAdministrationStore, "listGrants" | "deleteGrant">;
  apiAccess: Pick<ApiAccessStore, "findServicePrincipalByOwner">;
  workspaces: Pick<CollaborationWorkspaceStore, "getMembership">;
}

/**
 * The grants that edited the moved assets at their old place, which go with the move: every
 * grant on a moved asset that is more than reading or using it, and a reading or using one
 * that reaches beyond who reads at the new place (anyone but a member, for a team). And the
 * grants a moved Workflow's own run account holds at the old place: on that workspace, or on
 * an asset of it that stays.
 */
async function grantsLeavingWith(
  stores: Pick<AssetMoveWriteStores, "configAssets" | "access" | "apiAccess" | "workspaces">,
  clientInstanceId: ClientInstanceId,
  plan: Pick<AssetMovePlan, "members" | "from" | "to">
): Promise<{ onAssets: PermissionGrant[]; runAccounts: PermissionGrant[] }> {
  const moved = new Set(plan.members.map(({ record }) => record.id));
  const members = new Map<string, Promise<boolean>>();
  const memberOfTarget = (userId: string) => {
    const { to } = plan;
    if (to.kind !== "workspace") return Promise.resolve(true);
    let read = members.get(userId);
    if (!read) {
      read = stores.workspaces
        .getMembership({
          clientInstanceId,
          collaborationWorkspaceId: to.workspaceId,
          userId: asUserId(userId)
        })
        .then((membership) => membership !== undefined);
      members.set(userId, read);
    }
    return read;
  };
  const onAssets: PermissionGrant[] = [];
  for (const { record } of plan.members) {
    const grants = await stores.access.listGrants({
      clientInstanceId,
      scopeKind: "asset",
      scopeId: record.id
    });
    for (const grant of grants) {
      const readsOrUses = grant.action.endsWith(".read") || grant.action.endsWith(".use");
      const keeps =
        readsOrUses &&
        (plan.to.kind === "instance" ||
          (grant.holderKind === "user" && (await memberOfTarget(grant.holderId))));
      if (!keeps) onAssets.push(grant);
    }
  }
  const runAccounts: PermissionGrant[] = [];
  const { from } = plan;
  let staying: Promise<Set<string>> | undefined;
  const staysAtOldPlace = async (assetId: string) => {
    staying ??= stores.configAssets
      .listActiveConfigAssets({ clientInstanceId })
      .then(
        (assets) =>
          new Set(
            assets
              .filter((asset) => assetScopesEqual(asset.scope, from) && !moved.has(asset.id))
              .map((asset) => asset.id)
          )
      );
    return (await staying).has(assetId);
  };
  if (from.kind === "workspace")
    for (const { kind, record } of plan.members) {
      if (kind.kind !== WORKFLOW_ASSET_KIND) continue;
      const account = await stores.apiAccess.findServicePrincipalByOwner({
        clientInstanceId,
        owner: { kind: WORKFLOW_ASSET_KIND, assetId: record.id }
      });
      if (!account) continue;
      const grants = await stores.access.listGrants({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: account.id
      });
      for (const grant of grants) {
        const atOldPlace =
          (grant.scopeKind === "workspace" && grant.scopeId === from.workspaceId) ||
          (grant.scopeKind === "asset" &&
            grant.scopeId !== undefined &&
            (await staysAtOldPlace(grant.scopeId)));
        if (atOldPlace) runAccounts.push(grant);
      }
    }
  return { onAssets, runAccounts };
}

/** Whether the caller holds the right at the target for every member: then it moves at once. */
export function holdsMoveTarget(access: ActorAccess, plan: AssetMovePlan): boolean {
  return plan.members.every(
    (member) =>
      access.authorize(member.kind.actions.write, moveTargetResource(member.kind.kind, plan.to))
        .allowed
  );
}

/** Refuses a move that breaks something the caller did not say they accept. */
export function requireBreaksAccepted(
  plan: AssetMovePlan,
  accepted: boolean | undefined,
  locale: LocaleCode
): void {
  if (plan.breaks.length === 0 || accepted === true) return;
  const de = locale === "de";
  const named = plan.breaks
    .map((broken) => `${assetKindLabel(broken.kind, locale)} „${broken.name}“`)
    .join(", ");
  throw refusal(
    "move_breaks",
    de
      ? `Danach kann ${named} nicht mehr verwenden, was mitgeht, weil es bei ${ownerPlace(plan.fromReach, undefined, true)} bleibt. Bestätige das, um trotzdem zu teilen.`
      : `Afterwards ${named} can no longer use what moves, because it stays under ${ownerPlace(plan.fromReach, undefined, false)}. Confirm that to share all the same.`,
    {
      breaks: plan.breaks.map(({ kind, name, uses }) => ({ kind, name, uses }))
    }
  );
}

/**
 * Makes the move in its own transaction: every member gets the new owner, the grants that
 * edited it at the old place go, and `asset.moved` is recorded with ids alone. A member that
 * changed since the plan refuses it, and then nothing moved; whatever fails rolls all of it back.
 */
export async function executeAssetMove(
  options: Pick<AssetMoveOptions, "clientInstanceId" | "stores">,
  plan: AssetMovePlan,
  call: AssetMoveWriteCall
): Promise<{ version: number }> {
  return options.stores.transaction((stores) =>
    writeAssetMove(stores, options.clientInstanceId, plan, call)
  );
}

export interface AssetMoveWriteCall {
  actor: AuditActor;
  correlationId: string;
  runId?: string;
  requestId?: string;
  /** The hand-overs the move confirmed (DS-13c), recorded with it as it is made. */
  handover?: readonly JsonObject[];
}

/**
 * The writes of a move, through stores bound to the transaction it is part of: a request's
 * decision commits or rolls back with them.
 */
export async function writeAssetMove(
  stores: AssetMoveWriteStores,
  clientInstanceId: ClientInstanceId,
  plan: AssetMovePlan,
  call: AssetMoveWriteCall
): Promise<{ version: number }> {
  const result = await stores.configAssets.moveConfigAssets({
    clientInstanceId,
    to: plan.to,
    assets: plan.members.map(({ record }) => ({
      id: record.id,
      from: plan.from,
      activeRevisionId: record.activeRevisionId,
      ...(record.publishedRevisionId ? { publishedRevisionId: record.publishedRevisionId } : {})
    }))
  });
  // Read again inside the transaction: a grant given since the plan goes as well.
  const leaving = await grantsLeavingWith(stores, clientInstanceId, plan);
  const dropped = [...leaving.onAssets, ...leaving.runAccounts];
  for (const grant of dropped)
    await stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
  await stores.audit.appendAuditEvent({
    clientInstanceId,
    type: "asset.moved",
    status: "success",
    actor: call.actor,
    subject: plan.root.record.id,
    correlationId: call.correlationId,
    metadata: {
      assetId: plan.root.record.id,
      kind: plan.root.kind.kind,
      from: ownerIds(plan.from),
      to: ownerIds(plan.to),
      moved: plan.members.map(({ kind, record }) => ({ assetId: record.id, kind: kind.kind })),
      ...(dropped.length > 0 ? { droppedGrantIds: dropped.map((grant) => grant.id) } : {}),
      ...(call.requestId ? { requestId: call.requestId } : {}),
      ...(call.runId ? { operationRunId: call.runId } : {})
    }
  });
  for (const metadata of call.handover ?? [])
    await stores.audit.appendAuditEvent({
      clientInstanceId,
      type: "data_store.handover_confirmed",
      status: "success",
      actor: call.actor,
      correlationId: call.correlationId,
      metadata: {
        ...metadata,
        ...(call.requestId ? { requestId: call.requestId } : {}),
        ...(call.runId ? { operationRunId: call.runId } : {})
      }
    });
  return result;
}

/** The actor a move made by a person or a principal is recorded under. */
export function moveActor(actor: AuthenticatedIdentity): AuditActor {
  return auditActorFromIdentity(actor);
}

type MoveOwner = { kind: "instance" } | { kind: "workspace"; workspaceId: string };

/** What a check answers: names, titles and owners only, never content. */
export interface AssetMoveView {
  asset: { kind: string; name: string; id: string };
  from: MoveOwner;
  to: MoveOwner;
  path: AssetMovePath;
  moves: { kind: string; name: string; id: string; title: string }[];
  breaks: { kind: string; name: string; title: string; uses: { kind: string; name: string } }[];
  afterwards: {
    owner: MoveOwner & { rung: AssetOwnerRung; workspaceName?: string };
    editors: AssetMoveEditors;
    users: AssetMoveUsers;
    callerEdits: boolean;
    /**
     * The grants that go: on the moved assets, those to change them and those to read or use
     * them that reach beyond the new place; and a moved Workflow's run account's at the old.
     */
    grantsDropped: { onAssets: number; runAccounts: number };
  };
  /** The rows that go with a moved Data Store, and who reads them afterwards. */
  data: { kind: string; name: string; title: string; sentence: string }[];
}

/**
 * What a check answers and the dialog shows: what moves, what breaks, and who reads and edits
 * it afterwards. Names and titles only, never content.
 */
export function assetMoveView(plan: AssetMovePlan, access: ActorAccess): AssetMoveView {
  const direct = holdsMoveTarget(access, plan);
  return {
    asset: { kind: plan.root.kind.kind, name: plan.root.record.name, id: plan.root.record.id },
    from: ownerIds(plan.from),
    to: ownerIds(plan.to),
    path: direct ? "direct" : "request",
    moves: plan.members.map(({ kind, record, title }) => ({
      kind: kind.kind,
      name: record.name,
      id: record.id,
      title
    })),
    breaks: plan.breaks.map(({ kind, name, title, uses }) => ({ kind, name, title, uses })),
    afterwards: {
      owner: {
        ...ownerIds(plan.to),
        rung: assetOwnerRung(plan.toReach),
        ...(plan.toWorkspace ? { workspaceName: plan.toWorkspace.name } : {})
      },
      // Who changes it: the Builders of the team, or instance admins and instance Builders.
      editors: plan.to.kind === "instance" ? "instance_builders" : "workspace_builders",
      // Who uses it: the team's members, or everyone where it is offered.
      users: plan.to.kind === "instance" ? "everyone_where_offered" : "workspace_members",
      callerEdits: direct,
      grantsDropped: plan.grantsLeaving
    },
    data: plan.members
      .filter(({ kind }) => kind.kind === DATA_STORE_ASSET_KIND)
      .map(({ kind, record, title }) => ({
        kind: kind.kind,
        name: record.name,
        title,
        sentence: dataSentence(plan, title)
      }))
  };
}

function dataSentence(plan: AssetMovePlan, title: string): string {
  const team = plan.toWorkspace?.name;
  if (plan.locale === "de")
    return plan.to.kind === "workspace"
      ? `Die Daten in „${title}“ gehen mit und sind dann für das Team „${team ?? "Team"}“ lesbar.`
      : `Die Daten in „${title}“ gehen mit und sind dann für alle lesbar, denen es angeboten wird.`;
  return plan.to.kind === "workspace"
    ? `The data in "${title}" goes along and can then be read by the team "${team ?? "team"}".`
    : `The data in "${title}" goes along and can then be read by everyone it is offered to.`;
}

function ownerIds(scope: AssetScope): MoveOwner {
  return scope.kind === "instance"
    ? { kind: "instance" }
    : { kind: "workspace", workspaceId: scope.workspaceId };
}

function scopeOf(workspaceId: string | undefined): AssetScope {
  return workspaceId === undefined
    ? { kind: "instance" }
    : { kind: "workspace", workspaceId: asCollaborationWorkspaceId(workspaceId) };
}

/** The place on the ladder as people read it: „Nur ich“, the team's name, or Alle. */
function ownerPlace(reach: AssetOwnerReach, workspaceName: string | undefined, de: boolean) {
  const rung = assetOwnerRung(reach);
  if (rung === "everyone") return de ? "Allen" : "everyone";
  if (rung === "personal") return de ? "„Nur ich“" : `"Only me"`;
  return `„${workspaceName ?? (de ? "Team" : "team")}“`;
}

function refusal(reason: string, message: string, details: JsonObject = {}): AppError {
  return new AppError("VALIDATION_FAILED", message, { reason, ...details });
}

/**
 * What one asset uses, in every revision a user or a writer is served: the draft, the
 * published revision, and an agent's shared draft.
 */
async function usedBy(
  options: Pick<AssetMoveOptions, "clientInstanceId" | "stores">,
  kind: WorkflowAssetKind,
  record: ConfigAssetRecord
): Promise<{ kind: string; name: string }[]> {
  if (!kind.references) return [];
  const configs: unknown[] = [record.config, record.publishedConfig];
  if (kind.kind === "agent") {
    const draft = await options.stores.agentProposals.get({
      clientInstanceId: options.clientInstanceId,
      agentId: record.id
    });
    if (draft) configs.push(draft.config);
  }
  const seen = new Set<string>();
  const used: { kind: string; name: string }[] = [];
  for (const config of configs) {
    if (config === undefined || config === null) continue;
    for (const reference of kind.references(config)) {
      const key = `${reference.kind}:${reference.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      used.push(reference);
    }
  }
  return used;
}

/** A member that waits for a decision, such as its publish, is not moved under it. */
async function refuseOpenApprovals(
  options: AssetMoveOptions,
  members: readonly MoveMember[],
  label: (kind: string, name: string) => string,
  de: boolean
): Promise<void> {
  const moveKinds = new Set(
    movableKinds(options.kinds).map((kind) => assetMoveApprovalKind(kind.kind))
  );
  const kinds = options.approvalKinds().filter((kind) => !moveKinds.has(kind));
  if (kinds.length === 0) return;
  for (const member of members) {
    const subjects: JsonObject[] = [
      { assetId: member.record.id },
      { publishedWith: [{ assetId: member.record.id }] }
    ];
    for (const subjectContains of subjects) {
      const [open] = await options.stores.approvals.listApprovalRequests({
        clientInstanceId: options.clientInstanceId,
        kinds,
        status: "pending",
        subjectContains,
        page: { limit: 1 }
      });
      if (open)
        throw refusal(
          "move_open_approval",
          de
            ? `Für ${label(member.kind.kind, member.record.name)} wartet noch eine Freigabe. Sie wird zuerst entschieden, dann kann es geteilt werden.`
            : `A request about ${label(member.kind.kind, member.record.name)} is still waiting. It is decided first; then it can be shared.`,
          { asset: { kind: member.kind.kind, name: member.record.name }, requestId: open.id }
        );
    }
  }
}

/** An agent goes into a team only within the tools and models the team allows (WS-BUILD-1). */
async function refuseBeyondBuildLimits(
  members: readonly MoveMember[],
  workspace: CollaborationWorkspace | undefined,
  place: string,
  label: (kind: string, name: string) => string,
  de: boolean
): Promise<void> {
  if (!workspace) return;
  const { allowedToolNames, allowedModelBindingIds } = workspace;
  if (allowedToolNames === undefined && allowedModelBindingIds === undefined) return;
  const strings = (config: unknown, field: string) => {
    const value = readDefinitionField(config, field);
    if (typeof value === "string") return [value];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  };
  for (const member of members) {
    if (member.kind.kind !== "agent") continue;
    for (const config of [member.record.config, member.record.publishedConfig]) {
      if (!config) continue;
      const tool =
        allowedToolNames &&
        strings(config, "toolNames").find((name) => !allowedToolNames.includes(name));
      const bindings = [
        ...strings(config, "modelBindingId"),
        ...strings(config, "userSelectableModelBindingIds")
      ];
      const model =
        allowedModelBindingIds &&
        (bindings.length === 0 ? "" : bindings.find((id) => !allowedModelBindingIds.includes(id)));
      if (tool === undefined && model === undefined) continue;
      throw refusal(
        "move_build_limits",
        de
          ? `${label("agent", member.record.name)} nutzt ${tool === undefined ? "ein Modell" : `das Werkzeug „${tool}“`}, das in ${place} nicht erlaubt ist. Passe den Agenten an oder bitte einen Admin, es dort zu erlauben.`
          : `${label("agent", member.record.name)} uses ${tool === undefined ? "a model" : `the tool "${tool}"`} that ${place} does not allow. Change the agent, or ask an admin to allow it there.`,
        {
          asset: { kind: "agent", name: member.record.name },
          ...(tool === undefined ? {} : { toolName: tool }),
          workspaceId: workspace.id
        }
      );
    }
  }
}

/**
 * What stays where it is and can no longer use a moved asset: an asset of the old owner that
 * uses one, where owner reach refuses the pair once the moved one belongs to the target. Only
 * a move to a team can break anything: whatever is owned anywhere may use what Alle own.
 */
async function findBreaks(
  options: Pick<AssetMoveOptions, "clientInstanceId" | "stores" | "kinds">,
  input: {
    from: AssetScope;
    fromReach: AssetOwnerReach;
    toReach: AssetOwnerReach;
    memberIds: ReadonlySet<string>;
    members: readonly MoveMember[];
    titleOf(kind: WorkflowAssetKind, record: ConfigAssetRecord): string;
  }
): Promise<MoveBreak[]> {
  if (input.toReach.kind === "instance") return [];
  const moved = new Map(
    input.members.map(({ kind, record }) => [`${kind.kind}:${record.name}`, record])
  );
  const breaks: MoveBreak[] = [];
  for (const kind of options.kinds.kinds) {
    if (!kind.references || !kind.owners.includes(input.from.kind)) continue;
    let afterName: string | undefined;
    for (;;) {
      const page = await options.stores.configAssets.listConfigAssetPage({
        clientInstanceId: options.clientInstanceId,
        kind: kind.kind,
        scope: input.from,
        limit: 200,
        ...(afterName === undefined ? {} : { afterName }),
        readable: () => true
      });
      for (const listed of page) {
        if (input.memberIds.has(listed.id)) continue;
        // The page holds the draft; the published revision and an agent's draft are read too.
        const record =
          (await options.stores.configAssets.getConfigAsset({
            clientInstanceId: options.clientInstanceId,
            kind: kind.kind,
            name: listed.name
          })) ?? listed;
        for (const reference of await usedBy(options, kind, record)) {
          if (!moved.has(`${reference.kind}:${reference.name}`)) continue;
          const refused = ownerReachRefusal(input.fromReach, {
            kind: "reference",
            target: input.toReach,
            acrossOwners: kind.crossOwnerReferences?.includes(reference.kind) === true
          });
          if (refused === undefined) continue;
          breaks.push({
            kind: kind.kind,
            name: record.name,
            title: input.titleOf(kind, record),
            uses: { kind: reference.kind, name: reference.name }
          });
        }
      }
      if (page.length < 200) break;
      afterName = page.at(-1)?.name;
    }
  }
  return breaks;
}
