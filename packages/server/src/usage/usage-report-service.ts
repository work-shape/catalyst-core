import type {
  UsageBreakdown,
  UsageBreakdownQuery,
  UsageUsers,
  WorkspaceMembersUsage,
  WorkspaceUsage,
  WorkspaceUsageQuery
} from "@work-shape/catalyst-api-contract";
import {
  AppError,
  PERSONAL_WORKSPACES_KEY,
  USAGE_BREAKDOWN_DIMENSIONS,
  asCollaborationWorkspaceId,
  auditActorFromIdentity,
  type ActorAccess,
  type AuditRecorder,
  type AuthenticatedUser,
  type ClientInstanceId,
  type CollaborationWorkspaceId,
  type PlatformStores,
  type UsageBreakdownFilter
} from "@work-shape/catalyst-core";
import type {
  ModelUsageGovernance,
  UsageWorkspaceLabel,
  UsageWorkspaceLabeler
} from "@work-shape/catalyst-usage-governance";
import type { ChatServerOptions } from "../types";
import { requireWorkspaceAccess } from "../workspaces/workspace-access";
import { requireOwnerOrAdmin } from "../workspaces/workspace-service-access";

// The Usage page (LU-3, limits spec 3.3 and 3.4). The Overview and the Breakdown read the daily
// sums; a person's figures are read only with `usage.view_users`, and every such read is an
// audit event that names who looked, at which month, and nothing of what they saw.

export interface UsageReportDeps {
  clientInstanceId: ClientInstanceId;
  stores: Pick<PlatformStores, "users" | "workspaces">;
  usageGovernance: Pick<
    ModelUsageGovernance,
    "summarizeBreakdown" | "summarizeWorkspaceMembers" | "listUserMonthSpend" | "countActivity"
  >;
  auditRecorder: AuditRecorder;
  webSearchEnabled: boolean;
  now?: () => Date;
}

export function usageReportDeps(options: ChatServerOptions): UsageReportDeps {
  return {
    clientInstanceId: options.clientInstanceId,
    stores: options.stores,
    usageGovernance: options.usageGovernance,
    auditRecorder: options.auditRecorder,
    webSearchEnabled: options.config.webAccess.enabled && options.config.webAccess.search.enabled
  };
}

const toAmount = (micros: number): number => micros / 1_000_000;

function currentMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function monthBounds(month: string): { from: string; to: string } {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { from: start.toISOString(), to: end.toISOString() };
}

function filterOf(
  query: Partial<Record<keyof UsageBreakdownFilter, string>>
): UsageBreakdownFilter {
  const filter: UsageBreakdownFilter = {};
  for (const dimension of USAGE_BREAKDOWN_DIMENSIONS) {
    const value = query[dimension];
    if (value !== undefined) filter[dimension] = value;
  }
  return filter;
}

/**
 * How the Usage page shows the workspaces of usage: a shared one by its name, every Personal
 * Workspace under the one key, never by whose it is.
 */
export function workspaceLabeler(
  deps: Pick<UsageReportDeps, "clientInstanceId" | "stores">
): UsageWorkspaceLabeler {
  return async (workspaceIds) => {
    const shared = new Map(
      (
        await deps.stores.workspaces.listSharedWorkspaces({
          clientInstanceId: deps.clientInstanceId
        })
      ).map((workspace) => [workspace.id as string, workspace.name])
    );
    const labels = new Map<string, UsageWorkspaceLabel>();
    await Promise.all(
      workspaceIds.map(async (id) => {
        const name = shared.get(id);
        if (name !== undefined) {
          labels.set(id, { key: id, name });
          return;
        }
        const workspace = await deps.stores.workspaces.getWorkspace(
          deps.clientInstanceId,
          asCollaborationWorkspaceId(id)
        );
        if (workspace?.kind === "personal") labels.set(id, { key: PERSONAL_WORKSPACES_KEY });
      })
    );
    return labels;
  };
}

/** Settings > Instance > Usage, Breakdown: the period by one dimension, shared workspaces named. */
export async function readUsageBreakdown(
  deps: UsageReportDeps,
  query: UsageBreakdownQuery
): Promise<UsageBreakdown> {
  const [breakdown, shared] = await Promise.all([
    deps.usageGovernance.summarizeBreakdown({
      clientInstanceId: deps.clientInstanceId,
      from: query.from,
      to: query.to,
      groupBy: query.groupBy,
      filter: filterOf(query),
      webSearchEnabled: deps.webSearchEnabled
    }),
    query.groupBy === "workspace"
      ? deps.stores.workspaces.listSharedWorkspaces({ clientInstanceId: deps.clientInstanceId })
      : Promise.resolve([])
  ]);
  const names = new Map(shared.map((workspace) => [workspace.id as string, workspace.name]));
  return {
    from: query.from,
    to: query.to,
    groupBy: query.groupBy,
    personalWorkspacesKey: PERSONAL_WORKSPACES_KEY,
    total: breakdown.total,
    rows: breakdown.rows.map((row) => {
      const name = names.get(row.key);
      return name === undefined ? row : { ...row, name };
    })
  };
}

async function recordUsersViewed(
  deps: UsageReportDeps,
  input: {
    actor: AuthenticatedUser;
    correlationId: string;
    month: string;
    workspaceId?: CollaborationWorkspaceId;
  }
): Promise<void> {
  await deps.auditRecorder.record({
    type: "governance.usage_users_viewed",
    status: "success",
    actor: auditActorFromIdentity(input.actor),
    correlationId: input.correlationId,
    metadata: {
      view: input.workspaceId === undefined ? "instance" : "workspace",
      month: input.month,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId })
    }
  });
}

/**
 * Settings > Instance > Usage, Users: each person's own spend of a month, listed by name and
 * never ranked. The route requires `usage.view_users`; the read is audited before it answers.
 */
export async function readUsageUsers(
  deps: UsageReportDeps,
  input: { actor: AuthenticatedUser; correlationId: string; month?: string }
): Promise<UsageUsers> {
  const month = input.month ?? currentMonth(deps.now?.() ?? new Date());
  await recordUsersViewed(deps, { actor: input.actor, correlationId: input.correlationId, month });
  const [spend, users] = await Promise.all([
    deps.usageGovernance.listUserMonthSpend({ clientInstanceId: deps.clientInstanceId, month }),
    deps.stores.users.listUsers({ clientInstanceId: deps.clientInstanceId })
  ]);
  const names = new Map(users.map((user) => [user.id as string, user.displayLabel]));
  const items = spend.items.flatMap((row) => {
    const name = names.get(row.userId);
    // A person whose account is gone is not among them: their counter names nobody.
    return name === undefined
      ? []
      : [
          {
            userId: row.userId,
            name,
            spent: toAmount(row.spentMicros),
            modelCallCount: row.modelCallCount,
            tokens: row.tokens
          }
        ];
  });
  items.sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  return { month, ...(spend.currency ? { currency: spend.currency } : {}), items };
}

/** A shared workspace the caller is Owner or Admin of; anything else is not found or refused. */
async function requireManagedSharedWorkspace(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  user: AuthenticatedUser,
  workspaceId: CollaborationWorkspaceId
) {
  const access = await requireWorkspaceAccess(options, user, workspaceId);
  const workspace = await options.stores.workspaces.getWorkspace(
    options.clientInstanceId,
    workspaceId
  );
  // A Personal Workspace has no Usage tab: its usage is one summed row on the instance's page.
  if (workspace?.kind !== "shared") {
    throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
  }
  requireOwnerOrAdmin(access);
  return workspace;
}

/** Workspace > Usage: the workspace's month, its days, and a period by one dimension. */
export async function readWorkspaceUsage(
  deps: UsageReportDeps,
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  input: {
    actor: AuthenticatedUser;
    access: ActorAccess;
    workspaceId: CollaborationWorkspaceId;
    query: WorkspaceUsageQuery;
  }
): Promise<WorkspaceUsage> {
  const workspace = await requireManagedSharedWorkspace(options, input.actor, input.workspaceId);
  const now = deps.now?.() ?? new Date();
  const month = monthBounds(currentMonth(now));
  const monthQuery = {
    clientInstanceId: deps.clientInstanceId,
    from: month.from.slice(0, 10),
    to: month.to.slice(0, 10),
    filter: { workspace: input.workspaceId },
    webSearchEnabled: deps.webSearchEnabled
  };
  // The days of the month up to today: a day still to come has no usage to draw.
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  ).toISOString();
  const [days, breakdown, activity] = await Promise.all([
    deps.usageGovernance.summarizeBreakdown({
      ...monthQuery,
      to: (tomorrow < month.to ? tomorrow : month.to).slice(0, 10),
      groupBy: "day"
    }),
    deps.usageGovernance.summarizeBreakdown({
      clientInstanceId: deps.clientInstanceId,
      from: input.query.from,
      to: input.query.to,
      groupBy: input.query.groupBy,
      filter: { ...filterOf(input.query), workspace: input.workspaceId },
      webSearchEnabled: deps.webSearchEnabled
    }),
    deps.usageGovernance.countActivity({
      clientInstanceId: deps.clientInstanceId,
      collaborationWorkspaceId: input.workspaceId,
      from: month.from,
      to: month.to
    })
  ]);
  return {
    workspaceName: workspace.name,
    month: days.total,
    days: days.rows.map(({ key, ...window }) => ({ date: key, ...window })),
    activity,
    breakdown: {
      from: input.query.from,
      to: input.query.to,
      groupBy: input.query.groupBy,
      personalWorkspacesKey: PERSONAL_WORKSPACES_KEY,
      total: breakdown.total,
      rows: breakdown.rows
    },
    membersVisible: input.access.authorize("usage.view_users", {
      workspaceId: input.workspaceId
    }).allowed
  };
}

/**
 * Workspace > Usage, Members: what each member used in this workspace in a month. Needs Owner or
 * Admin of the workspace and `usage.view_users` for it; the read is audited before it answers.
 */
export async function readWorkspaceMembersUsage(
  deps: UsageReportDeps,
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  input: {
    actor: AuthenticatedUser;
    access: ActorAccess;
    correlationId: string;
    workspaceId: CollaborationWorkspaceId;
    month?: string;
  }
): Promise<WorkspaceMembersUsage> {
  await requireManagedSharedWorkspace(options, input.actor, input.workspaceId);
  input.access.require("usage.view_users", { workspaceId: input.workspaceId });
  const month = input.month ?? currentMonth(deps.now?.() ?? new Date());
  await recordUsersViewed(deps, {
    actor: input.actor,
    correlationId: input.correlationId,
    month,
    workspaceId: input.workspaceId
  });
  const [members, users] = await Promise.all([
    deps.usageGovernance.summarizeWorkspaceMembers({
      clientInstanceId: deps.clientInstanceId,
      collaborationWorkspaceId: input.workspaceId,
      month,
      webSearchEnabled: deps.webSearchEnabled
    }),
    deps.stores.users.listUsers({ clientInstanceId: deps.clientInstanceId })
  ]);
  const names = new Map(users.map((user) => [user.id as string, user.displayLabel]));
  const items = members.map(({ userId, ...window }) => {
    const name = userId === undefined ? undefined : names.get(userId);
    return {
      ...window,
      ...(userId === undefined ? {} : { userId }),
      ...(name === undefined ? {} : { name })
    };
  });
  // By name, the usage of nobody recorded last; never by what anyone used.
  items.sort((a, b) =>
    a.name === undefined
      ? 1
      : b.name === undefined
        ? -1
        : a.name.localeCompare(b.name) || (a.userId ?? "").localeCompare(b.userId ?? "")
  );
  return { month, items };
}
