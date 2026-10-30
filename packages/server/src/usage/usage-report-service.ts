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
  PERSONAL_AGENTS_KEY,
  PERSONAL_WORKSPACES_KEY,
  USAGE_BREAKDOWN_DIMENSIONS,
  asCollaborationWorkspaceId,
  auditActorFromIdentity,
  getSubjectUserId,
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
import { authorizeReviewer } from "../feedback/feedback-service";
import type { ChatServerOptions } from "../types";
import { offeredAgents } from "../workspaces/agent-availability";
import { requireWorkspaceAccess } from "../workspaces/workspace-access";
import { requireOwnerOrAdmin } from "../workspaces/workspace-service-access";
import { levelOut, resets } from "./usage-limits-service";

// The Usage page (LU-3, limits spec 3.3 and 3.4). The Overview and the Breakdown read the daily
// sums; a person's figures are read only with `usage.view_users`, and every such read is an
// audit event that names who looked, at which month, and nothing of what they saw.

export interface UsageReportDeps {
  clientInstanceId: ClientInstanceId;
  stores: Pick<PlatformStores, "users" | "workspaces" | "feedback">;
  usageGovernance: Pick<
    ModelUsageGovernance,
    | "summarizeBreakdown"
    | "summarizeWorkspaceMembers"
    | "listUserMonthSpend"
    | "countActivity"
    | "spendStatus"
  >;
  configAssets: Pick<ChatServerOptions["configAssets"], "source" | "store">;
  auditRecorder: AuditRecorder;
  webSearchEnabled: boolean;
  /** The feedback Module is on: an agent's row counts the comments on its answers. */
  feedbackEnabled: boolean;
  now?: () => Date;
}

export function usageReportDeps(options: ChatServerOptions): UsageReportDeps {
  return {
    clientInstanceId: options.clientInstanceId,
    stores: options.stores,
    usageGovernance: options.usageGovernance,
    configAssets: options.configAssets,
    auditRecorder: options.auditRecorder,
    webSearchEnabled: options.config.webAccess.enabled && options.config.webAccess.search.enabled,
    feedbackEnabled: options.modules.isEnabled("feedback")
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

type AgentRows = Pick<UsageBreakdown, "rows" | "feedback" | "unusedAgents">;

/**
 * The Breakdown by agent of the whole instance or of one shared workspace, completed (limits
 * spec 3.3, question 5): each agent's row counts the comments on its answers where the feedback
 * Module is on, and the agents offered there that caused no usage in the period are named.
 * Narrowed any other way, the rows are a share of usage that comments and offers do not split
 * by, so they stay as they are.
 */
async function completeAgentRows(
  deps: UsageReportDeps,
  input: {
    rows: UsageBreakdown["rows"];
    from: string;
    to: string;
    /** The shared workspace the rows are of; absent for the whole instance. */
    workspaceId?: CollaborationWorkspaceId;
    access: ActorAccess;
  }
): Promise<AgentRows> {
  const { rows, workspaceId } = input;
  const [offered, counts] = await Promise.all([
    workspaceId === undefined
      ? instanceAgentNames(deps)
      : offeredAgents(
          { clientInstanceId: deps.clientInstanceId, configAssets: deps.configAssets },
          { kind: "shared", id: workspaceId }
        ).then(({ available }) => available.map((agent) => agent.name)),
    deps.feedbackEnabled
      ? deps.stores.feedback.countFeedbackByAgent({
          clientInstanceId: deps.clientInstanceId,
          from: new Date(`${input.from}T00:00:00.000Z`),
          to: new Date(`${input.to}T00:00:00.000Z`),
          ...(workspaceId === undefined ? {} : { workspaceId })
        })
      : Promise.resolve(undefined)
  ]);
  const used = new Set(rows.map((row) => row.key));
  const unusedAgents = [...new Set(offered)]
    .filter((name) => !used.has(name))
    .sort((a, b) => a.localeCompare(b));
  if (!counts) return { rows, unusedAgents };
  return {
    // People's own agents in a shared workspace are one row that names none of them: no count.
    rows: rows.map((row) =>
      row.key === "" || row.key === PERSONAL_AGENTS_KEY
        ? row
        : { ...row, feedbackCount: counts.get(row.key) ?? 0 }
    ),
    feedback: { reviewable: authorizeReviewer(undefined, { access: input.access }).allowed },
    unusedAgents
  };
}

/**
 * The agents of the instance and of its shared workspaces, by name. A person's own agent is no
 * agent of the instance's: it is neither listed nor named.
 */
async function instanceAgentNames(deps: UsageReportDeps): Promise<string[]> {
  const [assets, shared] = await Promise.all([
    deps.configAssets.source.getSnapshot(),
    deps.stores.workspaces.listSharedWorkspaces({ clientInstanceId: deps.clientInstanceId })
  ]);
  const sharedIds = new Set<string>(shared.map((workspace) => workspace.id));
  return assets.agents
    .filter((agent) => {
      const scope = assets.agentKeys?.get(agent.name)?.scope;
      return scope === undefined || scope.kind === "instance" || sharedIds.has(scope.workspaceId);
    })
    .map((agent) => agent.name);
}

/**
 * The shared workspace a Breakdown by agent is of: none for the whole instance, the one it is
 * narrowed to, or nothing to complete where it is narrowed further.
 */
async function agentRowsScope(
  deps: UsageReportDeps,
  query: UsageBreakdownQuery
): Promise<{ workspaceId?: CollaborationWorkspaceId } | undefined> {
  if (query.groupBy !== "agent") return undefined;
  const { workspace, ...rest } = filterOf(query);
  if (Object.keys(rest).length > 0) return undefined;
  if (workspace === undefined) return {};
  if (workspace === PERSONAL_WORKSPACES_KEY || workspace === "") return undefined;
  const found = await deps.stores.workspaces.getWorkspace(
    deps.clientInstanceId,
    asCollaborationWorkspaceId(workspace)
  );
  return found?.kind === "shared" ? { workspaceId: found.id } : undefined;
}

/** Settings > Instance > Usage, Breakdown: the period by one dimension, shared workspaces named. */
export async function readUsageBreakdown(
  deps: UsageReportDeps,
  query: UsageBreakdownQuery,
  access: ActorAccess
): Promise<UsageBreakdown> {
  const [breakdown, shared, agentScope] = await Promise.all([
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
      : Promise.resolve([]),
    agentRowsScope(deps, query)
  ]);
  const names = new Map(shared.map((workspace) => [workspace.id as string, workspace.name]));
  const rows = breakdown.rows.map((row) => {
    const name = names.get(row.key);
    return name === undefined ? row : { ...row, name };
  });
  return {
    from: query.from,
    to: query.to,
    groupBy: query.groupBy,
    personalWorkspacesKey: PERSONAL_WORKSPACES_KEY,
    total: breakdown.total,
    ...(agentScope === undefined
      ? { rows }
      : await completeAgentRows(deps, {
          rows,
          from: query.from,
          to: query.to,
          access,
          ...agentScope
        }))
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
  const filter = filterOf(input.query);
  const [days, breakdown, activity, spend] = await Promise.all([
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
      filter: { ...filter, workspace: input.workspaceId },
      webSearchEnabled: deps.webSearchEnabled
    }),
    deps.usageGovernance.countActivity({
      clientInstanceId: deps.clientInstanceId,
      collaborationWorkspaceId: input.workspaceId,
      from: month.from,
      to: month.to
    }),
    deps.usageGovernance.spendStatus({
      clientInstanceId: deps.clientInstanceId,
      userId: getSubjectUserId(input.actor),
      workspaceId: input.workspaceId
    })
  ]);
  // The last day drawn is today: the days run up to it.
  const { key: _today, ...today } = days.rows.at(-1) ?? { key: "", ...days.total };
  const level = spend.workspace;
  const limited =
    level !== undefined &&
    (level.day.limitMicros !== undefined || level.month.limitMicros !== undefined);
  const agentRows =
    input.query.groupBy === "agent" && Object.keys(filter).length === 0
      ? await completeAgentRows(deps, {
          rows: breakdown.rows,
          from: input.query.from,
          to: input.query.to,
          workspaceId: input.workspaceId,
          access: input.access
        })
      : { rows: breakdown.rows };
  return {
    workspaceName: workspace.name,
    today,
    month: days.total,
    // Its Owners and Admins read the workspace's amounts (limits spec 3.1).
    ...(limited
      ? {
          limit: {
            ...(spend.currency ? { currency: spend.currency } : {}),
            ...levelOut(level, true, resets(now))
          }
        }
      : {}),
    days: days.rows.map(({ key, ...window }) => ({ date: key, ...window })),
    activity,
    breakdown: {
      from: input.query.from,
      to: input.query.to,
      groupBy: input.query.groupBy,
      personalWorkspacesKey: PERSONAL_WORKSPACES_KEY,
      total: breakdown.total,
      ...agentRows
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
