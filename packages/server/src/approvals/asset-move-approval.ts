import {
  AppError,
  asCollaborationWorkspaceId,
  assetScopesEqual,
  auditActorFromUser,
  isPlatformAction,
  localeCodes,
  type ApprovalRequestContext,
  type ApprovalRequestHandler,
  type ApprovalStaleness,
  type AssetScope,
  type JsonObject,
  type PlatformAction
} from "@work-shape/catalyst-core";
import { z } from "zod";
import {
  assetMoveApprovalKind,
  assetMoveView,
  executeAssetMove,
  movableKinds,
  moveTargetResource,
  planAssetMove,
  type AssetMoveOptions,
  type AssetMovePlan
} from "../assets/asset-move";

const ownerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instance") }),
  z.object({ kind: z.literal("workspace"), workspaceId: z.string().min(1) })
]);

const payloadSchema = z.object({
  subject: z.object({
    assetId: z.string().min(1),
    kind: z.string().min(1),
    toWorkspaceId: z.string().min(1).optional()
  }),
  name: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  to: ownerSchema,
  members: z
    .array(z.object({ kind: z.string().min(1), name: z.string().min(1), assetId: z.string() }))
    .min(1),
  acceptBreaks: z.boolean(),
  locale: z.enum(localeCodes)
});

type AssetMovePayload = z.infer<typeof payloadSchema> & JsonObject;

/**
 * One request kind per kind a workspace can own: `<kind>_move` (SHARE-1). Who holds the
 * kind's write at the target decides it, and for an agent that takes a skill along the
 * skill's write there too. A team's builder reads the requests into their own team.
 */
export function createAssetMoveApprovalHandlers(
  options: AssetMoveOptions
): ApprovalRequestHandler<AssetMovePayload>[] {
  return movableKinds(options.kinds).map((kind) =>
    handlerFor(options, kind.kind, writeOf(options, kind.kind))
  );
}

function writeOf(options: AssetMoveOptions, kind: string): PlatformAction {
  const write = options.kinds.require(kind).actions.write;
  if (!isPlatformAction(write))
    throw new AppError("INTERNAL", `The write of ${kind} is no platform action`);
  return write;
}

function scopeOf(owner: AssetMovePayload["to"]): AssetScope {
  return owner.kind === "instance"
    ? { kind: "instance" }
    : { kind: "workspace", workspaceId: asCollaborationWorkspaceId(owner.workspaceId) };
}

function handlerFor(
  options: AssetMoveOptions,
  kind: string,
  write: PlatformAction
): ApprovalRequestHandler<AssetMovePayload> {
  const plan = (payload: AssetMovePayload): Promise<AssetMovePlan> =>
    planAssetMove(
      options,
      {
        kind,
        name: payload.name,
        ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
        to: payload.to,
        expectedAssetId: payload.subject.assetId
      },
      payload.locale
    );
  const applied = async (
    payload: JsonObject,
    context: ApprovalRequestContext
  ): Promise<boolean> => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) return false;
    const store = context.transaction?.configAssets ?? options.stores.configAssets;
    const root = await store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind,
      name: parsed.data.name
    });
    return (
      root?.id === parsed.data.subject.assetId &&
      root.status === "active" &&
      assetScopesEqual(root.scope, scopeOf(parsed.data.to))
    );
  };
  return {
    kind: assetMoveApprovalKind(kind),
    requiredPermission: write,
    resourceOf: (payload) => moveTargetResource(kind, payload.to),
    furtherPermissions: (payload) =>
      payload.members
        .filter((member) => member.kind !== kind)
        .map((member) => ({
          permission: writeOf(options, member.kind),
          resource: moveTargetResource(member.kind, payload.to)
        })),
    async reviewableSubjects(access) {
      const workspaces = await options.stores.workspaces.listSharedWorkspaces({
        clientInstanceId: options.clientInstanceId
      });
      return workspaces
        .filter((workspace) => access.authorize(write, { kind, workspaceId: workspace.id }).allowed)
        .map((workspace) => ({ toWorkspaceId: workspace.id }));
    },
    validate: (payload) => payloadSchema.parse(payload),
    async preview(payload, context) {
      // Names, titles and owners only: what moves, what breaks, who reads and edits it after.
      try {
        const planned = await plan(payload);
        const view: JsonObject = context.viewer
          ? { ...assetMoveView(planned, context.viewer.access) }
          : { asset: { kind, name: payload.name, id: payload.subject.assetId } };
        return view;
      } catch (error) {
        return {
          asset: { kind, name: payload.name, id: payload.subject.assetId },
          to: payload.to,
          members: payload.members,
          ...(error instanceof AppError ? { stale: error.message } : {})
        };
      }
    },
    async isStale(payload, context): Promise<boolean | ApprovalStaleness> {
      if (await applied(payload, context)) return false;
      let planned: AssetMovePlan;
      try {
        planned = await plan(payload);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const details: { reason?: unknown } = error.details ?? {};
        const reason = typeof details.reason === "string" ? details.reason : "move_refused";
        return { result: { reason, message: error.message } };
      }
      const filed = new Set(payload.members.map((member) => member.assetId));
      if (
        planned.members.length !== filed.size ||
        planned.members.some((member) => !filed.has(member.record.id))
      )
        return { result: { reason: "move_changed" } satisfies JsonObject };
      if (planned.breaks.length > 0 && !payload.acceptBreaks)
        return { result: { reason: "move_breaks" } satisfies JsonObject };
      return false;
    },
    isApplied: applied,
    async apply(payload, approver, context): Promise<JsonObject> {
      if (await applied(payload, context)) return { status: "moved" };
      const planned = await plan(payload);
      await executeAssetMove(options, planned, {
        actor: auditActorFromUser(approver),
        correlationId: context.correlationId,
        requestId: context.requestId
      });
      return {
        status: "moved",
        moved: planned.members.map(({ kind: memberKind, record }) => ({
          kind: memberKind.kind,
          assetId: record.id
        }))
      };
    }
  };
}
