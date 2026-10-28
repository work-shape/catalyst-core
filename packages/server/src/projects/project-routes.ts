import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  asCollaborationWorkspaceId,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type OperationAuthorization
} from "@work-shape/catalyst-core";
import { ConversationWorkflow } from "../conversations/conversation-service";
import type { Route } from "../http/route";
import { conversationIdParam } from "../routes/request-context";
import type { ChatServerOptions } from "../types";
import { ProjectWorkflow } from "./project-service";

/**
 * Projects (PRJ-1), of the module `projects`, which refuses all of them where it is off. A
 * project is chat work of people: membership and the audience decide every call, so no grant
 * is asked and a service principal is refused.
 */
export function registerProjectRoutes(route: Route, options: ChatServerOptions): void {
  const projects = new ProjectWorkflow(options);
  const conversations = new ConversationWorkflow(options);

  route(apiOperations["projects.list"], ({ user, params }) =>
    projects.list(user, asCollaborationWorkspaceId(params.collaborationWorkspaceId))
  );

  route(apiOperations["projects.get"], ({ user, params }) =>
    projects.get(user, params.projectName)
  );

  route.operation(apiOperations["projects.create"], {
    // Nothing deletes a project yet: it stays once made.
    changeClass: "irreversible",
    authorize: authorizePerson("projects.create"),
    resource: ({ collaborationWorkspaceId }) => ({
      kind: "collaboration_workspace",
      id: collaborationWorkspaceId
    }),
    execute: ({ collaborationWorkspaceId, title, description, audience }, context) =>
      projects.create(personOf(context.actor), context, {
        collaborationWorkspaceId: asCollaborationWorkspaceId(collaborationWorkspaceId),
        title,
        ...(description ? { description } : {}),
        ...(audience ? { audience } : {})
      })
  });

  route.operation(apiOperations["conversations.set_project"], {
    // Taken out again, or put back, by the same call.
    changeClass: "reversible",
    authorize: authorizePerson("conversations.set_project"),
    resource: ({ conversationId }) => ({ kind: "conversation", id: conversationId }),
    execute: ({ conversationId, projectId }, context) =>
      conversations.setConversationProject(
        conversationIdParam({ conversationId }),
        personOf(context.actor),
        context,
        projectId
      )
  });
}

function authorizePerson(action: string) {
  return (_input: unknown, { actor }: { actor: AuthenticatedIdentity }): OperationAuthorization =>
    isAuthenticatedServicePrincipal(actor)
      ? { allowed: false, action, reason: "no_grant", message: "Only a person works in projects" }
      : { allowed: true };
}

function personOf(actor: AuthenticatedIdentity): AuthenticatedUser {
  if (isAuthenticatedServicePrincipal(actor)) {
    throw new AppError("FORBIDDEN", "Only a person works in projects");
  }
  return actor;
}
