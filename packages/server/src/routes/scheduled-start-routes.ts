import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  isAuthenticatedServicePrincipal,
  getAuthScopes,
  type OperationExecutionContext,
  type StorePage
} from "@work-shape/catalyst-core";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";
import {
  ScheduledStartsWorkflow,
  nextScheduledPrompt
} from "../conversations/scheduled-start-service";

function pageOf(page: StorePage | undefined): StorePage {
  if (!page) throw new AppError("INTERNAL", "Scheduled list requires paging");
  return page;
}

export function registerScheduledStartRoutes(route: Route, options: ChatServerOptions) {
  const workflow = new ScheduledStartsWorkflow(options);
  const authorize = (_input: unknown, { actor }: Pick<OperationExecutionContext, "actor">) =>
    isAuthenticatedServicePrincipal(actor) ||
    actor.delegatedActor ||
    !getAuthScopes(actor).includes("*")
      ? {
          allowed: false as const,
          action: "scheduled_starts.manage",
          reason: "no_grant" as const,
          message: "Only a person acting for themself manages scheduled prompts"
        }
      : { allowed: true as const };
  const floor = (origin: { kind: string }) =>
    origin.kind === "agent" ? ("confirm" as const) : undefined;

  route.operation(apiOperations["scheduled_starts.list"], {
    authorize,
    recordsEveryCall: true,
    execute: (input, context) =>
      workflow.list(context, input.collaborationWorkspaceId, pageOf(context.paging))
  });
  route.operation(apiOperations["scheduled_starts.create"], {
    authorize: async (input, context) => {
      const permission = authorize(input, context);
      if (!permission.allowed || isAuthenticatedServicePrincipal(context.actor)) return permission;
      nextScheduledPrompt(
        input.cron,
        input.timeZone ?? options.config.clientInstance.timeZone ?? "UTC",
        new Date()
      );
      await workflow.requireAgent(context.actor, input.collaborationWorkspaceId, input.agentName);
      return permission;
    },
    changeClass: "reversible",
    policyFloorOf: floor,
    execute: (input, context) => workflow.create(context, input)
  });
  route.operation(apiOperations["scheduled_starts.update"], {
    authorize: async (input, context) => {
      const permission = authorize(input, context);
      if (!permission.allowed || isAuthenticatedServicePrincipal(context.actor)) return permission;
      const current = await workflow.requireOwn(
        options.stores,
        input.scheduledStartId,
        context.actor
      );
      nextScheduledPrompt(input.cron, input.timeZone ?? current.timeZone, new Date());
      await workflow.requireAgent(context.actor, current.collaborationWorkspaceId, input.agentName);
      return permission;
    },
    changeClass: "reversible",
    policyFloorOf: floor,
    execute: (input, context) => workflow.update(context, input.scheduledStartId, input)
  });
  route.operation(apiOperations["scheduled_starts.set_state"], {
    authorize,
    changeClass: "reversible",
    policyFloorOf: floor,
    execute: (input, context) => workflow.setState(context, input.scheduledStartId, input.state)
  });
  route.operation(apiOperations["scheduled_starts.run_now"], {
    authorize,
    changeClass: "reversible",
    policyFloorOf: floor,
    execute: (input, context) => workflow.runNow(context, input.scheduledStartId)
  });
  route.operation(apiOperations["scheduled_starts.delete"], {
    authorize,
    changeClass: "reversible",
    policyFloorOf: floor,
    execute: (input, context) => workflow.remove(context, input.scheduledStartId)
  });
  route.operation(apiOperations["scheduled_starts.runs"], {
    authorize,
    recordsEveryCall: true,
    execute: (input, context) =>
      workflow.runs(context, input.scheduledStartId, pageOf(context.paging))
  });
  route.operation(apiOperations["scheduled_starts.handover"], {
    authorize,
    changeClass: "reversible",
    policyFloorOf: floor,
    execute: (input, context) =>
      workflow.handover(context, input.scheduledStartId, input.ownerUserId)
  });
}
