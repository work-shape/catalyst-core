import { authorizeAgentDependencies } from "../agent-dependency-availability";
import {
  type AgentAvailability,
  AppError,
  asCollaborationWorkspaceId,
  operationDenialError,
  type ActorAccess,
  type OperationAuthorization
} from "@work-shape/catalyst-core";
import { decide, deleteDecision } from "../asset-access";
import {
  clearsLastDefault,
  loadStoredAssets,
  assertUpsertPolicyAndMissingRight,
  keptStored,
  listsModelBindings,
  loadAgentLists,
  missingUpsertRightOf,
  setsInitialDefault
} from "../asset-write-rules";
import { readsTarget, type AssetAddress, type AssetTarget } from "../asset-target";
import { requirePrecondition } from "../asset-revision";
import type { AssetVerbScope } from "./scope";

/** The right on the asset a write asks for: its write right, or its delete right. */
type AssetRight = "write" | "delete";

/**
 * Every right of a write that names the revision it was made against, and after them the
 * precondition itself: the right on the asset, then what the write needs beside it, then
 * the revision. A caller without a right learns nothing else, and a write that names no
 * revision reaches neither the policy nor a guardrail.
 */
export async function authorizeRevisionWrite(
  scope: AssetVerbScope,
  access: ActorAccess,
  input: AssetAddress & {
    expectedRevision?: number | null;
    makeDependenciesAvailable?: boolean;
    expectedAvailability?: Omit<AgentAvailability, "collaborationWorkspaceIds"> & {
      collaborationWorkspaceIds: string[];
    };
    config?: Record<string, unknown>;
    /** The revision a revert makes the content again: its config is what the write puts. */
    revision?: number;
  },
  right: AssetRight,
  beforeConfirmation = false
): Promise<OperationAuthorization> {
  const target = await scope.target(input);
  const decision =
    right === "delete"
      ? deleteDecision(access, target)
      : writeDecisionOn(access, target, await writtenConfigOf(scope, target, input));
  if (!decision.allowed) {
    return decision;
  }
  // A revert restores content: who does not read the asset is refused before the guardrails
  // read the revision, so no answer of theirs tells what it holds. A name of no asset of
  // this scope has nothing to restore and is refused by the revert as a free name is.
  if (input.revision !== undefined && target.asset && !readsTarget(access, target)) {
    return decide(access, target.kind.actions.read, target.resource);
  }
  const config =
    input.config ??
    (input.revision === undefined
      ? undefined
      : ((await revisionOf(scope, target, input.revision))?.config ?? undefined));
  const further = await furtherRight(scope, access, target, right, config, beforeConfirmation);
  if (further.allowed) {
    requirePrecondition(input, input.expectedRevision);
  }
  if (further.allowed && input.makeDependenciesAvailable) {
    if (target.kind.kind !== "agent" || target.asset?.status === "active" || config === undefined)
      throw new AppError(
        "VALIDATION_FAILED",
        "Dependency availability consent is only accepted when creating an agent"
      );
    if (input.expectedAvailability === undefined)
      throw new AppError(
        "PRECONDITION_REQUIRED",
        "Review the new agent's workspace availability before making its dependencies available",
        { reason: "dependency_availability_review_required" }
      );
    return authorizeAgentDependencies(scope.options, access, config, {
      ...input.expectedAvailability,
      collaborationWorkspaceIds: input.expectedAvailability.collaborationWorkspaceIds.map(
        asCollaborationWorkspaceId
      )
    });
  }
  return further;
}

/** The config a put or a revert writes: the one sent, or the revision's for a revert. */
async function writtenConfigOf(
  scope: AssetVerbScope,
  target: AssetTarget,
  input: { config?: Record<string, unknown>; revision?: number }
): Promise<unknown> {
  if (input.config !== undefined) return input.config;
  if (input.revision === undefined) return undefined;
  return (await revisionOf(scope, target, input.revision))?.config ?? undefined;
}

/**
 * The right a put or a revert of `next` asks: what the kind decides it on (a person's own
 * server, PMCP), else the kind's write right on the asset.
 */
function writeDecisionOn(
  access: ActorAccess,
  target: AssetTarget,
  next: unknown
): OperationAuthorization {
  const decided =
    next === undefined || next === null
      ? undefined
      : target.kind.writeDecision?.({
          access,
          resource: target.resource,
          current: target.asset?.status === "active" ? target.asset.config : undefined,
          next
        });
  return decided ?? decide(access, target.kind.actions.write, target.resource);
}

/** Throws the refusal of `writeDecisionOn`, as the operation layer answers a missing right. */
export function requireWriteOn(access: ActorAccess, target: AssetTarget, next: unknown): void {
  const decision = writeDecisionOn(access, target, next);
  if (!decision.allowed) {
    const { allowed: _allowed, ...denial } = decision;
    throw operationDenialError({ kind: "forbidden", ...denial });
  }
}

/**
 * The rights a write of one asset needs beside the one on the asset: what the kind asks for
 * a put of this definition, such as the right to manage model settings, and the write right
 * on the instance where the write changes the instance default. They are decided on what the
 * caller sent and on the stored asset, before the revision is: a caller who lacks one is
 * told that and nothing of the revision.
 */
async function furtherRight(
  scope: AssetVerbScope,
  access: ActorAccess,
  target: AssetTarget,
  right: AssetRight,
  config?: Record<string, unknown>,
  beforeConfirmation = false
): Promise<OperationAuthorization> {
  const { kind, name } = target;
  if (right === "write" && config !== undefined && kind.representation !== "files") {
    const current = target.asset?.status === "active" ? target.asset.config : undefined;
    const check = beforeConfirmation ? assertUpsertPolicyAndMissingRight : missingUpsertRightOf;
    const missing = check(access, "put", kind, {
      name,
      resource: target.resource,
      current,
      next: keptStored(kind, current, kind.prepareInteractiveUpsert({ current, next: config })),
      modelBindingsListed: listsModelBindings(
        await loadAgentLists(
          scope.options,
          target.scope.kind === "workspace" ? target.scope.workspaceId : undefined
        )
      )
    });
    if (missing !== undefined) {
      return { allowed: false, ...missing };
    }
  }
  // Only a holder of the write right on the instance changes its default, so only for
  // everyone else is the set read to see whether this write would.
  const instanceWrite = access.authorize(kind.actions.write);
  if (!kind.holdsInstanceDefault || instanceWrite.allowed) {
    return { allowed: true };
  }
  const stored = await loadStoredAssets(scope.options);
  const changesDefault =
    right === "delete"
      ? target.asset?.status === "active" && clearsLastDefault(stored.set, kind, name)
      : setsInitialDefault(stored.set, kind, target.scope);
  return changesDefault
    ? { allowed: false, action: kind.actions.write, reason: instanceWrite.reason }
    : { allowed: true };
}

export function revisionOf(scope: AssetVerbScope, target: AssetTarget, revision: number) {
  return scope.options.configAssets.store.getConfigAssetRevision({
    clientInstanceId: scope.options.clientInstanceId,
    kind: target.kind.kind,
    name: target.name,
    revision
  });
}

/** Throws the refusal of `furtherRight`, as the operation layer answers a missing right. */
export async function requireFurtherRight(
  scope: AssetVerbScope,
  access: ActorAccess,
  target: AssetTarget,
  right: AssetRight,
  config?: Record<string, unknown>
): Promise<void> {
  const further = await furtherRight(scope, access, target, right, config);
  if (!further.allowed) {
    throw operationDenialError({
      kind: "forbidden",
      action: further.action,
      reason: further.reason
    });
  }
}
