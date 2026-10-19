import {
  AppError,
  asCollaborationWorkspaceId,
  asUserId,
  createPlatformId,
  getSubjectUserId,
  getAuthScopes,
  isAuthenticatedServicePrincipal,
  isTimeZone,
  nextDueAfter,
  parseCron,
  scheduledPromptDedupeKey,
  SCHEDULED_START_MIN_INTERVAL_MINUTES,
  shortestCronGapMinutes,
  type AuthenticatedUser,
  type OperationExecutionContext,
  type PlatformStores,
  type ScheduledStart,
  type StorePage
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { ConversationWorkflow } from "./conversation-service";
import { getWorkspaceAssetSnapshot } from "../workspaces/agent-availability";
import { scheduledPromptJob, schedulePromptJob } from "./scheduled-start-job";

type Fields = { agentName: string; prompt: string; cron: string; timeZone?: string };

/** Validate the wall clock before it can be persisted or offered for confirmation. */
export function nextScheduledPrompt(cron: string, timeZone: string, after: Date): string {
  const parsed = parseCron(cron);
  if (!parsed || !isTimeZone(timeZone))
    throw new AppError(
      "VALIDATION_FAILED",
      "Use a five-field cron expression and an IANA time zone such as Europe/Berlin"
    );
  if (shortestCronGapMinutes(parsed) < SCHEDULED_START_MIN_INTERVAL_MINUTES)
    throw new AppError(
      "VALIDATION_FAILED",
      `A scheduled prompt runs at most every ${SCHEDULED_START_MIN_INTERVAL_MINUTES} minutes. Choose a less frequent schedule`
    );
  const due = nextDueAfter([parsed], after, timeZone);
  if (!due)
    throw new AppError(
      "VALIDATION_FAILED",
      "This schedule has no supported next run. Choose a recurring time"
    );
  return due.toISOString();
}

function person(context: OperationExecutionContext): AuthenticatedUser {
  if (
    isAuthenticatedServicePrincipal(context.actor) ||
    context.actor.delegatedActor ||
    !getAuthScopes(context.actor).includes("*")
  )
    throw new AppError("FORBIDDEN", "Only a person acting for themself manages scheduled prompts");
  return context.actor;
}

export class ScheduledStartsWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  async requireOwn(stores: PlatformStores, id: string, user: AuthenticatedUser, lock = false) {
    const row = await stores.scheduledStarts.get({
      clientInstanceId: this.options.clientInstanceId,
      id,
      forUpdate: lock
    });
    if (!row || row.ownerUserId !== getSubjectUserId(user))
      throw new AppError("NOT_FOUND", "Scheduled prompt is not available");
    return row;
  }

  async requireAgent(user: AuthenticatedUser, workspaceId: string, agentName: string) {
    const workspace = await new ConversationWorkflow(this.options).requireMemberWorkspace(
      user,
      asCollaborationWorkspaceId(workspaceId)
    );
    const member = await this.options.stores.workspaces.getMembership({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      userId: asUserId(getSubjectUserId(user))
    });
    if (!member)
      throw new AppError("NOT_FOUND", "This workspace is not available for your scheduled prompts");
    const assets = await getWorkspaceAssetSnapshot(this.options, workspace);
    if (!assets.agents.some((agent) => agent.name === agentName))
      throw new AppError("NOT_FOUND", "This agent is not available in this workspace");
  }

  async list(
    context: OperationExecutionContext,
    query: { collaborationWorkspaceId?: string; ownerUserId?: string },
    page: StorePage
  ) {
    const user = person(context);
    const ownerUserId = query.ownerUserId ?? getSubjectUserId(user);
    // An instance admin reads a deactivated person's starts to hand them over or delete them.
    if (ownerUserId !== getSubjectUserId(user))
      await this.requireDeactivatedOwner(context, ownerUserId, this.options.stores);
    const workspaceId = query.collaborationWorkspaceId;
    return this.options.stores.scheduledStarts.list({
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId,
      ...(workspaceId ? { collaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId) } : {}),
      page
    });
  }

  async runs(context: OperationExecutionContext, id: string, page: StorePage) {
    await this.requireOwn(this.options.stores, id, person(context));
    return this.options.stores.scheduledStarts.listRuns({
      clientInstanceId: this.options.clientInstanceId,
      scheduledStartId: id,
      page
    });
  }

  async create(
    context: OperationExecutionContext,
    fields: Fields & { collaborationWorkspaceId: string }
  ) {
    const user = person(context);
    await this.requireAgent(user, fields.collaborationWorkspaceId, fields.agentName);
    const now = new Date();
    const timeZone = fields.timeZone ?? this.options.config.clientInstance.timeZone ?? "UTC";
    const start: ScheduledStart = {
      id: createPlatformId<"ScheduledStartId">("scheduled"),
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: getSubjectUserId(user),
      collaborationWorkspaceId: asCollaborationWorkspaceId(fields.collaborationWorkspaceId),
      agentName: fields.agentName,
      prompt: fields.prompt,
      cron: fields.cron,
      timeZone,
      state: "active",
      nextRunAt: nextScheduledPrompt(fields.cron, timeZone, now),
      personalConnectionsAllowed: await this.personalConsent(context, user),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    return this.options.stores.transaction(async (tx) => {
      const saved = await tx.scheduledStarts.create({ start });
      if (saved.nextRunAt) await schedulePromptJob(tx, saved, saved.nextRunAt);
      return saved;
    });
  }

  async update(context: OperationExecutionContext, id: string, fields: Fields) {
    const user = person(context);
    const before = await this.requireOwn(this.options.stores, id, user);
    await this.requireAgent(user, before.collaborationWorkspaceId, fields.agentName);
    const timeZone = fields.timeZone ?? before.timeZone;
    nextScheduledPrompt(fields.cron, timeZone, new Date());
    const consent = await this.personalConsent(context, user);
    return this.change(user, id, async (tx, current) => {
      // Read under the lock and from no earlier than the tick that last advanced the start, so
      // an edit racing a tick never puts back a due time that tick already ran.
      const next = nextScheduledPrompt(
        fields.cron,
        timeZone,
        new Date(Math.max(Date.now(), Date.parse(current.updatedAt)))
      );
      await this.withdraw(tx, current);
      const saved = await tx.scheduledStarts.update({
        clientInstanceId: current.clientInstanceId,
        id,
        ownerUserId: current.ownerUserId,
        patch: {
          ...fields,
          timeZone,
          nextRunAt: current.state === "active" ? next : null,
          personalConnectionsAllowed: consent
        },
        now: new Date().toISOString()
      });
      if (saved.nextRunAt) await schedulePromptJob(tx, saved, saved.nextRunAt);
      return saved;
    });
  }

  async setState(context: OperationExecutionContext, id: string, state: ScheduledStart["state"]) {
    const user = person(context);
    return this.change(user, id, async (tx, current) => {
      await this.withdraw(tx, current);
      const nextRunAt =
        state === "active" ? nextScheduledPrompt(current.cron, current.timeZone, new Date()) : null;
      const saved = await tx.scheduledStarts.update({
        clientInstanceId: current.clientInstanceId,
        id,
        ownerUserId: current.ownerUserId,
        patch: { state, nextRunAt },
        now: new Date().toISOString()
      });
      if (nextRunAt) await schedulePromptJob(tx, saved, nextRunAt);
      return saved;
    });
  }

  async runNow(context: OperationExecutionContext, id: string) {
    const user = person(context);
    await this.change(user, id, async (tx, current) => {
      if (
        await tx.scheduledStarts.hasOpenRun({
          clientInstanceId: current.clientInstanceId,
          scheduledStartId: id
        })
      )
        throw new AppError(
          "CONFLICT",
          "The previous run is still active or waiting for your decision"
        );
      await schedulePromptJob(tx, current, new Date().toISOString(), true);
    });
    return { queued: true as const };
  }

  async remove(context: OperationExecutionContext, id: string) {
    const user = person(context);
    await this.options.stores.transaction(async (tx) => {
      const current = await tx.scheduledStarts.get({
        clientInstanceId: this.options.clientInstanceId,
        id,
        forUpdate: true
      });
      if (
        !current ||
        (current.ownerUserId !== getSubjectUserId(user) &&
          !context.access.authorize("users.manage").allowed)
      )
        throw new AppError("NOT_FOUND", "Scheduled prompt is not available");
      if (current.ownerUserId !== getSubjectUserId(user))
        await this.requireDeactivatedOwner(context, current.ownerUserId, tx);
      await this.withdraw(tx, current);
      await tx.scheduledStarts.delete({
        clientInstanceId: current.clientInstanceId,
        id,
        ownerUserId: current.ownerUserId
      });
    });
    return { deleted: true as const };
  }

  async handover(context: OperationExecutionContext, id: string, ownerUserId: string) {
    person(context);
    return this.options.stores.transaction(async (tx) => {
      const current = await tx.scheduledStarts.get({
        clientInstanceId: this.options.clientInstanceId,
        id,
        forUpdate: true
      });
      if (!current) throw new AppError("NOT_FOUND", "Scheduled prompt is not available");
      await this.requireDeactivatedOwner(context, current.ownerUserId, tx);
      const target = await tx.users.getUser({
        clientInstanceId: current.clientInstanceId,
        userId: asUserId(ownerUserId)
      });
      if (!target || target.status !== "active")
        throw new AppError("NOT_FOUND", "New owner is not active");
      const member = await tx.workspaces.getMembership({
        clientInstanceId: current.clientInstanceId,
        collaborationWorkspaceId: current.collaborationWorkspaceId,
        userId: asUserId(ownerUserId)
      });
      if (!member) throw new AppError("NOT_FOUND", "New owner is not a member of this workspace");
      await this.withdraw(tx, current);
      await tx.scheduledStarts.detachRuns({
        clientInstanceId: current.clientInstanceId,
        scheduledStartId: id
      });
      return tx.scheduledStarts.update({
        clientInstanceId: current.clientInstanceId,
        id,
        ownerUserId: current.ownerUserId,
        patch: { ownerUserId, state: "paused", nextRunAt: null, personalConnectionsAllowed: false },
        now: new Date().toISOString()
      });
    });
  }

  private async personalConsent(
    context: OperationExecutionContext,
    user: AuthenticatedUser
  ): Promise<boolean> {
    if (user.authenticationMethod === "session-cookie" && user.sessionId && !user.delegatedActor)
      return true;
    if (context.origin.kind !== "agent") return false;
    const run = await this.options.stores.agentRuns.getAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      runId: context.origin.agentRunId
    });
    return (
      run?.ownerUserId === getSubjectUserId(user) &&
      run.authorization?.personalConnectionsAllowed === true
    );
  }

  private async requireDeactivatedOwner(
    context: OperationExecutionContext,
    ownerUserId: string,
    tx: PlatformStores
  ) {
    context.access.require("users.manage");
    const owner = await tx.users.getUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: asUserId(ownerUserId)
    });
    if (!owner || owner.status !== "disabled")
      throw new AppError(
        "FORBIDDEN",
        "Only starts of a deactivated user can be handed over or deleted by an instance admin"
      );
  }

  private change<T>(
    user: AuthenticatedUser,
    id: string,
    fn: (tx: PlatformStores, row: ScheduledStart) => Promise<T>
  ) {
    return this.options.stores.transaction(async (tx) =>
      fn(tx, await this.requireOwn(tx, id, user, true))
    );
  }
  private async withdraw(tx: PlatformStores, current: ScheduledStart) {
    if (current.nextRunAt)
      await tx.jobs.withdraw(scheduledPromptJob, {
        clientInstanceId: current.clientInstanceId,
        dedupeKey: scheduledPromptDedupeKey(current.id, current.nextRunAt)
      });
  }
}
