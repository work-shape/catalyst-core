import {
  AppError,
  isAuthenticatedServicePrincipal,
  type AssetMoveStatus,
  type JsonObject,
  type LocaleCode
} from "@work-shape/catalyst-core";
import { ApprovalRequestWorkflow } from "../approvals/approval-request-service";
import type { ChatServerOptions } from "../types";
import type { AssetCall } from "./asset-access";
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

/** The dry run of a move: what moves, what breaks, who reads and edits it afterwards. */
export async function checkAssetMove(
  options: AssetMoveOperationOptions,
  call: AssetCall,
  input: AssetMoveInput
): Promise<AssetMoveView> {
  const plan = await planAssetMove(
    moveOptions(options),
    input,
    localeOf(options, call),
    call.actor
  );
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
  const plan = await planAssetMove(moveOptions(options), input, locale, call.actor);
  requireBreaksAccepted(plan, input.acceptBreaks, locale);
  if (holdsMoveTarget(call.access, plan)) {
    await executeAssetMove(options, plan, {
      actor: moveActor(call.actor),
      correlationId: call.correlationId,
      ...(call.runId ? { runId: call.runId } : {})
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
    if (sameTarget(open.payload, plan))
      return { status: "requested", requestId: open.id, ...assetMoveView(plan, call.access) };
    throw new AppError(
      "VALIDATION_FAILED",
      locale === "de"
        ? "Für dieses Asset wartet schon eine Anfrage zum Teilen an einen anderen Ort. Ziehe sie zurück oder warte, bis sie entschieden ist."
        : "A request to share this asset to another place is already waiting. Withdraw it, or wait until it is decided.",
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
      payload: assetMoveRequestPayload(plan, input.acceptBreaks === true, locale)
    }
  );
  return { status: "requested", requestId: request.id, ...assetMoveView(plan, call.access) };
}

/**
 * What a request holds: the ids, kinds and names of what moves, from where to where. No
 * content. `subject` is what lists and the reviewer's narrower right are matched on.
 */
function assetMoveRequestPayload(
  plan: AssetMovePlan,
  acceptBreaks: boolean,
  locale: LocaleCode
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
    acceptBreaks,
    locale
  };
}

function sameTarget(payload: JsonObject, plan: AssetMovePlan): boolean {
  const to = payload.to;
  if (typeof to !== "object" || to === null || Array.isArray(to)) return false;
  return plan.to.kind === "instance"
    ? to.kind === "instance"
    : to.kind === "workspace" && to.workspaceId === plan.to.workspaceId;
}
