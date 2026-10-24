import type {
  OwnUsage,
  SetUsageSpendLimitRequest,
  UsageLimits,
  UsageNearLimit,
  UsageSpendAmountsInput,
  UsageSpendLimitOverride,
  UsageSpendPeriod
} from "@work-shape/catalyst-api-contract";
import {
  AppError,
  asCollaborationWorkspaceId,
  asUserId,
  auditActorFromIdentity,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type ActorAccess,
  type AuditRecorder,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type ClientInstanceId,
  type PlatformStores,
  type UsageSpendAmounts,
  type UsageSpendLimitRecord,
  type UsageSpendLimitTarget
} from "@work-shape/catalyst-core";
import type {
  ModelUsageGovernance,
  UsageSpendLevelStatus,
  UsageSpendPeriodStatus
} from "@work-shape/catalyst-usage-governance";

// Spend limits at three levels (LU-2, limits spec 3.1). The limits are instance data, changed
// only through `usage.limits.set`, which the screen, the CLI and an MCP client share. The
// release config's instance values are the operator's ceiling.

/** From this share of a limit on, a workspace or user is listed as near it. */
const NEAR_LIMIT_PERCENT = 80;
/** The most users the Limits view offers to pick for a value of their own. */
const USER_OPTIONS_LIMIT = 500;

export interface UsageLimitsDeps {
  clientInstanceId: ClientInstanceId;
  stores: Pick<PlatformStores, "usage" | "users" | "workspaces">;
  usageGovernance: Pick<
    ModelUsageGovernance,
    "spendCeiling" | "spendCurrency" | "instanceSpendLimits" | "spendStatus" | "heldSpend"
  >;
  now?: () => Date;
}

const toAmount = (micros: number): number => micros / 1_000_000;
const toMicros = (amount: number): number => Math.round(amount * 1_000_000);

function amountsOut(amounts: UsageSpendAmounts | undefined): UsageSpendAmountsInput {
  return {
    ...(amounts?.dailyMicros === undefined ? {} : { daily: toAmount(amounts.dailyMicros) }),
    ...(amounts?.monthlyMicros === undefined ? {} : { monthly: toAmount(amounts.monthlyMicros) })
  };
}

function amountsIn(amounts: UsageSpendAmountsInput): UsageSpendAmounts {
  return {
    ...(amounts.daily === undefined ? {} : { dailyMicros: toMicros(amounts.daily) }),
    ...(amounts.monthly === undefined ? {} : { monthlyMicros: toMicros(amounts.monthly) })
  };
}

function recordOut(record: UsageSpendLimitRecord | undefined) {
  return record ? { ...amountsOut(record), updatedAt: record.updatedAt } : undefined;
}

/** Settings > Instance > Limits: every level, the overrides by name, and who is near a limit. */
export async function readUsageLimits(deps: UsageLimitsDeps): Promise<UsageLimits> {
  const { clientInstanceId } = deps;
  const [records, counters, workspaces, users] = await Promise.all([
    deps.stores.usage.listSpendLimits({ clientInstanceId }),
    deps.stores.usage.readSpendCounters({ clientInstanceId, all: true }),
    deps.stores.workspaces.listSharedWorkspaces({ clientInstanceId }),
    deps.stores.users.listUsers({
      clientInstanceId,
      activeOnly: true,
      page: { limit: USER_OPTIONS_LIMIT }
    })
  ]);
  const workspaceName = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const userName = new Map(users.map((user) => [user.id as string, user.displayLabel]));
  const at = (level: UsageSpendLimitRecord["level"]) =>
    records.find((record) => record.level === level);
  const overrides = (level: UsageSpendLimitTarget): UsageSpendLimitOverride[] =>
    records
      .filter((record) => record.level === level && record.targetId !== undefined)
      .map((record) => {
        const id = record.targetId ?? "";
        const name = (level === "workspace" ? workspaceName : userName).get(id);
        return {
          id,
          ...(name === undefined ? {} : { name }),
          ...amountsOut(record),
          updatedAt: record.updatedAt
        };
      });

  // The limit each workspace and user is held against: its own value, else the default.
  const limitOf = (kind: UsageSpendLimitTarget, id: string): UsageSpendAmounts | undefined =>
    records.find((record) => record.level === kind && record.targetId === id) ??
    at(kind === "workspace" ? "workspace_default" : "user_default");
  const nearLimit: UsageNearLimit[] = [];
  for (const counter of counters) {
    if (counter.scopeKind === "instance") continue;
    const kind = counter.scopeKind;
    const limits = limitOf(kind, counter.scopeId);
    const limitMicros = counter.period === "day" ? limits?.dailyMicros : limits?.monthlyMicros;
    if (limitMicros === undefined) continue;
    const held = deps.usageGovernance.heldSpend(limitMicros);
    const percent = held <= 0 ? 100 : Math.max(0, Math.floor((counter.costMicros / held) * 100));
    if (percent < NEAR_LIMIT_PERCENT) continue;
    const name = (kind === "workspace" ? workspaceName : userName).get(counter.scopeId);
    // A workspace being deleted, or a user no longer active, is nobody to act on.
    if (name === undefined) continue;
    nearLimit.push({
      kind,
      id: counter.scopeId,
      name,
      period: counter.period,
      limit: toAmount(limitMicros),
      percent
    });
  }
  nearLimit.sort((a, b) => b.percent - a.percent || a.id.localeCompare(b.id));

  const currency = deps.usageGovernance.spendCurrency();
  const instance = at("instance");
  return {
    ...(currency ? { currency } : {}),
    ceiling: amountsOut(deps.usageGovernance.spendCeiling()),
    ...(instance ? { instance: recordOut(instance) } : {}),
    effectiveInstance: amountsOut(deps.usageGovernance.instanceSpendLimits(instance)),
    ...(at("workspace_default") ? { workspaceDefault: recordOut(at("workspace_default")) } : {}),
    ...(at("user_default") ? { userDefault: recordOut(at("user_default")) } : {}),
    workspaces: overrides("workspace"),
    users: overrides("user"),
    nearLimit,
    workspaceOptions: workspaces
      .map((workspace) => ({ id: workspace.id, name: workspace.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    userOptions: users
      .map((user) => ({ id: user.id, name: user.displayLabel }))
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}

/**
 * Sets or removes one level's limit and records the change with its old and new value. An
 * instance limit above the release config's is refused, and so is a value for a workspace that
 * is not a shared one of the instance or for a user who is not there.
 */
export async function setUsageLimit(
  deps: UsageLimitsDeps,
  input: SetUsageSpendLimitRequest & {
    actor: AuthenticatedIdentity;
    audit: AuditRecorder;
    correlationId: string;
  }
): Promise<{
  level: SetUsageSpendLimitRequest["level"];
  target?: string;
  limits?: UsageSpendAmountsInput;
}> {
  const { clientInstanceId } = deps;
  const limits = input.limits === null ? null : amountsIn(input.limits);
  if (input.level === "instance" && limits) {
    const ceiling = deps.usageGovernance.spendCeiling();
    const above = (
      [
        ["daily", limits.dailyMicros, ceiling.dailyMicros],
        ["monthly", limits.monthlyMicros, ceiling.monthlyMicros]
      ] as const
    ).find(([, value, most]) => value !== undefined && most !== undefined && value > most);
    if (above) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The instance's ${above[0]} limit cannot be above the release config's ${toAmount(above[2] ?? 0)}`,
        { reason: "above_ceiling", period: above[0], ceiling: toAmount(above[2] ?? 0) }
      );
    }
  }
  if (input.level === "workspace" && input.target !== undefined) {
    const workspace = await deps.stores.workspaces.getWorkspace(
      clientInstanceId,
      asCollaborationWorkspaceId(input.target)
    );
    if (!workspace || workspace.kind !== "shared") {
      throw new AppError("NOT_FOUND", "There is no shared workspace with this id", {
        reason: "workspace_not_found"
      });
    }
  }
  if (input.level === "user" && input.target !== undefined) {
    const user = await deps.stores.users.getUser({
      clientInstanceId,
      userId: asUserId(input.target)
    });
    if (!user || user.status === "deleting") {
      throw new AppError("NOT_FOUND", "There is no user with this id", {
        reason: "user_not_found"
      });
    }
  }
  const { previous } = await deps.stores.usage.setSpendLimit({
    clientInstanceId,
    level: input.level,
    ...(input.target === undefined ? {} : { targetId: input.target }),
    limits,
    updatedBy: isAuthenticatedServicePrincipal(input.actor)
      ? input.actor.id
      : getSubjectUserId(input.actor)
  });
  const before = previous ? amountsOut(previous) : null;
  const after = limits ? amountsOut(limits) : null;
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await input.audit.record({
      type: "governance.usage_limit_changed",
      status: "success",
      actor: auditActorFromIdentity(input.actor),
      correlationId: input.correlationId,
      subject: clientInstanceId,
      metadata: {
        level: input.level,
        ...(input.target === undefined ? {} : { target: input.target }),
        previous: before,
        next: after
      }
    });
  }
  return {
    level: input.level,
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(after ? { limits: after } : {})
  };
}

/** The first moment after the current UTC day and month. */
function resets(now: Date): { day: string; month: string } {
  return {
    day: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    ).toISOString(),
    month: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
  };
}

function levelOut(
  level: UsageSpendLevelStatus,
  showAmounts: boolean,
  at: { day: string; month: string }
): { day: UsageSpendPeriod; month: UsageSpendPeriod } {
  const period = (status: UsageSpendPeriodStatus, resetsAt: string): UsageSpendPeriod => ({
    ...(showAmounts ? { spent: toAmount(status.spentMicros) } : {}),
    ...(showAmounts && status.limitMicros !== undefined
      ? { limit: toAmount(status.limitMicros) }
      : {}),
    ...(status.reached === undefined ? {} : { reached: status.reached }),
    resetsAt
  });
  return { day: period(level.day, at.day), month: period(level.month, at.month) };
}

/**
 * The caller's own consumption against their own limit, and whether the limit of a shared
 * workspace they work in, or of the instance, stops them. A member reads no amount of the
 * workspace, its owners and admins do; the instance's amounts are for those who set limits or see
 * usage. A workspace the caller is no member of is left out.
 */
export async function readOwnUsage(
  deps: UsageLimitsDeps,
  input: { actor: AuthenticatedUser; access: ActorAccess; workspaceId?: string }
): Promise<OwnUsage> {
  const userId = getSubjectUserId(input.actor);
  const admin =
    input.access.authorize("limits.manage").allowed || input.access.authorize("usage.view").allowed;
  const membership =
    input.workspaceId === undefined
      ? undefined
      : await deps.stores.workspaces.getMembership({
          clientInstanceId: deps.clientInstanceId,
          collaborationWorkspaceId: asCollaborationWorkspaceId(input.workspaceId),
          userId: asUserId(userId)
        });
  const status = await deps.usageGovernance.spendStatus({
    clientInstanceId: deps.clientInstanceId,
    userId,
    ...(membership ? { workspaceId: input.workspaceId } : {})
  });
  const at = resets(deps.now?.() ?? new Date());
  return {
    ...(status.currency ? { currency: status.currency } : {}),
    own: levelOut(status.own, true, at),
    ...(status.workspace
      ? {
          workspace: {
            id: status.workspace.id,
            ...levelOut(
              status.workspace,
              admin || membership?.role === "owner" || membership?.role === "admin",
              at
            )
          }
        }
      : {}),
    instance: levelOut(status.instance, admin, at)
  };
}
