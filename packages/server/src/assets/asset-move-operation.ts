import {
  AppError,
  isAuthenticatedServicePrincipal,
  type AssetMoveStatus,
  type DataHandoverPublish,
  type JsonObject,
  type LocaleCode
} from "@work-shape/catalyst-core";
import { ApprovalRequestWorkflow } from "../approvals/approval-request-service";
import type { ChatServerOptions } from "../types";
import type { AssetCall } from "./asset-access";
import type { HandoverChanges, HandoverConfirmed } from "./data-handover";
import {
  assetMoveApprovalKind,
  assetMoveView,
  executeAssetMove,
  holdsMoveTarget,
  moveActor,
  moveTargetResource,
  planAssetMove,
  requireBreaksAccepted,
  type AssetMoveInput,
  type AssetMoveOptions,
  type AssetMovePlan,
  type AssetMoveView
} from "./asset-move";

/** A move made, or filed as a request an admin decides in the Inbox. */
export type AssetMoveResult = AssetMoveView & {
  status: AssetMoveStatus;
  requestId?: string;
};

/** What the operations `assets.move` and `assets.move_check` read. */
export type AssetMoveOperationOptions = Pick<
  ChatServerOptions,
  "clientInstanceId" | "stores" | "configAssets" | "modules" | "config" | "auditRecorder"
> &
  Pick<ChatServerOptions, "approvalRequests">;

function moveOptions(options: AssetMoveOperationOptions): AssetMoveOptions {
  return {
    clientInstanceId: options.clientInstanceId,
    stores: options.stores,
    kinds: options.configAssets.kinds,
    modules: options.modules,
    approvalKinds: () => [...(options.approvalRequests?.handlers.keys() ?? [])]
  };
}

function localeOf(options: AssetMoveOperationOptions, call: AssetCall): LocaleCode {
  return call.runtime?.locale ?? options.config.localization.defaultLocale;
}

/**
 * What a move changes, as the widening check reads it (DS-13c): each asset that moves, at the
 * owner it goes to. Nothing where the move is refused anyway: the move says why.
 */
export function moveChanges(
  options: AssetMoveOperationOptions
): HandoverChanges<AssetMoveInput & HandoverConfirmed> {
  return async (input) => {
    const plan = await planAssetMove(
      moveOptions(options),
      input,
      options.config.localization.defaultLocale
    ).catch(() => undefined);
    if (!plan) return undefined;
    const scope: DataHandoverPublish["scope"] =
      plan.to.kind === "workspace"
        ? { kind: "workspace", workspaceId: plan.to.workspaceId }
        : { kind: "instance" };
    return plan.members.map(({ kind, record }) => ({ kind: kind.kind, name: record.name, scope }));
  };
}

/** The dry run of a move: what moves, what breaks, who reads and edits it afterwards. */
export async function checkAssetMove(
  options: AssetMoveOperationOptions,
  call: AssetCall,
  input: AssetMoveInput
): Promise<AssetMoveView> {
  const plan = await planAssetMove(moveOptions(options), input, localeOf(options, call), {
    actor: call.actor,
    access: call.access
  });
  return assetMoveView(plan, call.access);
}

/**
 * "Teilen mit…": moves the asset at once where the caller holds the right at the target for
 * everything that moves; otherwise files one request that an admin with that right accepts or
 * declines in the Inbox. A second call while a request for the same move waits answers it.
 */
export async function moveAsset(
  options: AssetMoveOperationOptions,
  call: AssetCall,
  input: AssetMoveInput
): Promise<AssetMoveResult> {
  const locale = localeOf(options, call);
  const plan = await planAssetMove(moveOptions(options), input, locale, {
    actor: call.actor,
    access: call.access
  });
  requireBreaksAccepted(plan, input.acceptBreaks, locale);
  if (holdsMoveTarget(call.access, plan)) {
    await executeAssetMove(options, plan, {
      actor: moveActor(call.actor),
      correlationId: call.correlationId,
      ...(call.runId ? { runId: call.runId } : {}),
      ...(call.handover?.length ? { handover: call.handover } : {})
    });
    return { status: "moved", ...assetMoveView(plan, call.access) };
  }
  const { actor } = call;
  // No person stands behind a principal's call to file a request for: its own right decides.
  if (isAuthenticatedServicePrincipal(actor) || !options.approvalRequests) {
    for (const member of plan.members)
      call.access.require(member.kind.actions.write, moveTargetResource(member.kind.kind, plan.to));
    throw new AppError("FORBIDDEN", "The move needs the right at the target");
  }
  const kind = assetMoveApprovalKind(plan.root.kind.kind);
  const [open] = await options.stores.approvals.listApprovalRequests({
    clientInstanceId: options.clientInstanceId,
    kinds: [kind],
    status: "pending",
    subjectContains: { assetId: plan.root.record.id },
    page: { limit: 1 }
  });
  if (open) {
    const de = locale === "de";
    // Somebody else's request is theirs: it is not answered as this caller's, nor named by id.
    if (open.requestedBy.id !== actor.id)
      throw new AppError(
        "VALIDATION_FAILED",
        de
          ? `${open.requestedBy.displayLabel} hat schon angefragt, dieses Asset zu teilen. Die Anfrage wird zuerst entschieden.`
          : `${open.requestedBy.displayLabel} has already asked to share this asset. That request is decided first.`,
        { reason: "move_request_open", requestedBy: open.requestedBy.displayLabel }
      );
    if (sameTarget(open.payload, plan))
      return { status: "requested", requestId: open.id, ...assetMoveView(plan, call.access) };
    throw new AppError(
      "VALIDATION_FAILED",
      de
        ? "Du hast schon angefragt, dieses Asset an einen anderen Ort zu teilen. Ziehe die Anfrage zurück oder warte, bis sie entschieden ist."
        : "You have already asked to share this asset to another place. Withdraw that request, or wait until it is decided.",
      { reason: "move_request_open", requestId: open.id }
    );
  }
  const workflow = new ApprovalRequestWorkflow({
    ...options.approvalRequests,
    clientInstanceId: options.clientInstanceId,
    auditRecorder: options.auditRecorder
  });
  const request = await workflow.createRequest(
    actor,
    { correlationId: call.correlationId },
    {
      kind,
      // The name of the operation. The Inbox words the item in the reader's language.
      summary: "assets.move",
      payload: assetMoveRequestPayload(
        plan,
        actor.id,
        input.acceptBreaks === true,
        locale,
        call.handover
      )
    }
  );
  return { status: "requested", requestId: request.id, ...assetMoveView(plan, call.access) };
}

/**
 * What a request holds: the ids, kinds and names of what moves, from where to where, and who
 * asked. No content. `subject` is what lists and the reviewer's narrower right are matched on.
 * The hand-overs the move confirmed are recorded once it is made, not as it is filed (DS-13c).
 */
function assetMoveRequestPayload(
  plan: AssetMovePlan,
  requesterId: string,
  acceptBreaks: boolean,
  locale: LocaleCode,
  handover: readonly JsonObject[] | undefined
): JsonObject {
  return {
    subject: {
      assetId: plan.root.record.id,
      kind: plan.root.kind.kind,
      ...(plan.to.kind === "workspace" ? { toWorkspaceId: plan.to.workspaceId } : {})
    },
    name: plan.root.record.name,
    ...(plan.from.kind === "workspace" ? { workspaceId: plan.from.workspaceId } : {}),
    to:
      plan.to.kind === "workspace"
        ? { kind: "workspace", workspaceId: plan.to.workspaceId }
        : { kind: "instance" },
    members: plan.members.map(({ kind, record }) => ({
      kind: kind.kind,
      name: record.name,
      assetId: record.id
    })),
    // Built here, never from the caller's input: who is asked again when it is decided.
    requesterId,
    acceptBreaks,
    locale,
    ...(handover?.length ? { handover: [...handover] } : {})
  };
}

function sameTarget(payload: JsonObject, plan: AssetMovePlan): boolean {
  const to = payload.to;
  if (typeof to !== "object" || to === null || Array.isArray(to)) return false;
  return plan.to.kind === "instance"
    ? to.kind === "instance"
    : to.kind === "workspace" && to.workspaceId === plan.to.workspaceId;
}
