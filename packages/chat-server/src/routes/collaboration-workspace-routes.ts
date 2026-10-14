import { paginate, pageScope } from "../http/paging";
import { DEFAULT_LIST_LIMIT, apiOperations } from "@vivd-catalyst/api-contract";
import { createSafeConfigView } from "@vivd-catalyst/config-schema";
import { agentConnections } from "../agent-connections";
import { APP_ACTIONS, APP_ASSET_KIND } from "../apps/app-kind";
import { accessResource } from "../asset-access";
import { listedTo } from "../asset-read-workflow";
import {
  AppError,
  asCollaborationWorkspaceId,
  asUserId,
  type CollaborationWorkspaceId,
  getSubjectUserId,
  hasAuthScope,
  isAuthenticatedServicePrincipal,
  type ActorAccess,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type OperationExecutionContext,
  type OperationResource
} from "@vivd-catalyst/core";
import {
  CollaborationWorkspaceWorkflow,
  type WorkspaceChangeCall
} from "../collaboration-workspace-workflow";
import type { Route } from "../http/route";
import { deletionState } from "./deletion-answer";
import { requirePathParam, resolveRequestLocale } from "../request-context";
import type { ChatServerOptions } from "../types";
import { requireWorkspaceAccess } from "../workspace-access";
import { findWorkspaceFiles } from "../workspace-files";

/** The agent kind and the right that writes one, as the kind registers them. */
const AGENT_KIND = "agent";
const AGENT_WRITE = "agent.write";

/** The scopes a credential must carry to list the assets of a kind and to write one. */
const LIST_SCOPE = apiOperations["assets.list"].scope;
const WRITE_SCOPE = apiOperations["assets.put"].scope;

type SectionCaller = { user: AuthenticatedUser; access: ActorAccess };

/**
 * Whether the Agents row of the sidebar is there for the caller in one workspace: it offers a
 * choice, two agents or more, or the caller may write an agent and so make the next one. With
 * one agent New chat starts it, and a page of one card adds nothing. The right is the one the
 * agent kind registers, held on the instance, in a Namespace or on one agent, with a credential
 * whose scope reaches the write.
 */
function agentsRowShown(available: number, { user, access }: SectionCaller): boolean {
  if (available >= 2) {
    return true;
  }
  return (
    hasAuthScope(user, WRITE_SCOPE) &&
    (access.authorize(AGENT_WRITE, { kind: AGENT_KIND }).allowed ||
      access.holdsGrantAt(AGENT_WRITE, ["namespace", "asset"]))
  );
}

/**
 * Whether the Apps row of the sidebar is there for the caller in one workspace: the module is
 * on, and the Apps page of the workspace lists the caller an App, by the check of
 * `assets.list`, or the caller may write an App there, in the workspace or on one of its Apps.
 * One read of at most one App, and none for whoever may write in the whole workspace.
 */
async function appsRowShown(
  options: ChatServerOptions,
  workspaceId: CollaborationWorkspaceId,
  { user, access }: SectionCaller
): Promise<boolean> {
  const kind = options.configAssets.kinds.get(APP_ASSET_KIND);
  if (!options.modules.isEnabled("apps") || !kind) {
    return false;
  }
  const writes = hasAuthScope(user, WRITE_SCOPE);
  if (
    writes &&
    access.authorize(APP_ACTIONS.write, { kind: APP_ASSET_KIND, workspaceId }).allowed
  ) {
    return true;
  }
  const lists = hasAuthScope(user, LIST_SCOPE);
  if (!writes && !lists) {
    return false;
  }
  const found = await options.configAssets.store.listConfigAssetPage({
    clientInstanceId: options.clientInstanceId,
    kind: APP_ASSET_KIND,
    scope: { kind: "workspace", workspaceId },
    limit: 1,
    readable: (asset) =>
      (lists && listedTo(kind, access, asset)) ||
      (writes &&
        access.authorize(
          APP_ACTIONS.write,
          accessResource(asset.kind, asset.name, asset.scope, asset.id)
        ).allowed)
  });
  return found.length > 0;
}

/** The section rows of the sidebar that are there for the caller in one workspace. */
async function workspaceSections(
  options: ChatServerOptions,
  workspaceId: CollaborationWorkspaceId,
  availableAgents: number,
  caller: SectionCaller
): Promise<Array<"agents" | "apps">> {
  const sections: Array<"agents" | "apps"> = [];
  if (agentsRowShown(availableAgents, caller)) {
    sections.push("agents");
  }
  if (await appsRowShown(options, workspaceId, caller)) {
    sections.push("apps");
  }
  return sections;
}

/**
 * Collaboration Workspaces. The reads are plain routes but `workspaces.files.list`, which an
 * agent's tool projects; so is `workspaces.ensure_personal`, which the interface calls on every
 * load. The ten other changes are registered operations: each call is an Operation Run that
 * names the workspace, and the caller's role in it is asked before the policy.
 */
export function registerCollaborationWorkspaceRoutes(
  route: Route,
  options: ChatServerOptions
): void {
  const workspaces = new CollaborationWorkspaceWorkflow(options);
  const create = apiOperations["workspaces.create"];
  const update = apiOperations["workspaces.update"];
  const remove = apiOperations["workspaces.delete"];
  const addMember = apiOperations["workspaces.members.add"];
  const leave = apiOperations["workspaces.members.leave"];
  const updateRole = apiOperations["workspaces.members.update_role"];
  const removeMember = apiOperations["workspaces.members.remove"];
  const requestAccess = apiOperations["workspaces.access_requests.create"];
  const approveRequest = apiOperations["workspaces.access_requests.approve"];
  const declineRequest = apiOperations["workspaces.access_requests.decline"];

  route(apiOperations["workspaces.ensure_personal"], async ({ user }) => {
    const workspace = await options.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId: options.clientInstanceId,
      userId: asUserId(getSubjectUserId(user))
    });
    return workspaces.getWorkspace(user, workspace.id);
  });

  route(apiOperations["workspaces.list"], async ({ user }) => {
    return workspaces.listWorkspaces(user);
  });

  route.operation(create, {
    changeClass: "reversible",
    // Whoever is signed in may create a Shared Workspace, and becomes its Owner.
    authorize: () => ({ allowed: true }),
    execute: (input, context) =>
      workspaces.createSharedWorkspace(changeCall(create.id, context), {
        name: input.name,
        description: input.description,
        visibility: input.visibility,
        defaultConversationVisibility: input.defaultConversationVisibility,
        emoji: input.emoji,
        accentColor: input.accentColor
      })
  });

  route(apiOperations["workspaces.directory.list"], async ({ user }) => {
    return workspaces.browseDirectory(user);
  });

  route(apiOperations["workspaces.get"], async ({ user, params }) => {
    return workspaces.getWorkspace(user, collaborationWorkspaceId(params));
  });

  route(
    apiOperations["workspaces.agents.list"],
    async ({ user, access, params, request, query }) => {
      const assets = await workspaces.getAssetSnapshot(user, collaborationWorkspaceId(params));
      const { defaultAgentName, agents } = createSafeConfigView(
        options.config,
        assets,
        options.modules,
        {
          requestedLocale: resolveRequestLocale(options, request),
          reasoningEffortsOfBinding: (bindingId) =>
            options.modelGateway.capabilities({ bindingId }).reasoningEfforts,
          connections: await agentConnections(options)
        }
      );
      return {
        defaultAgentName,
        visibleSections: await workspaceSections(
          options,
          collaborationWorkspaceId(params),
          agents.length,
          { user, access }
        ),
        ...paginate(
          agents,
          query,
          ["name"],
          false,
          pageScope(apiOperations["workspaces.agents.list"].id, params, query)
        )
      };
    }
  );

  route.operation(apiOperations["workspaces.files.list"], {
    // Any member may search; which conversations they may read the search itself decides.
    authorize: async (input, { actor }) => {
      await requireWorkspaceAccess(options, personOf(actor), collaborationWorkspaceId(input));
      return { allowed: true };
    },
    resource: workspaceResource,
    execute: (input, context) =>
      findWorkspaceFiles(options, {
        user: personOf(context.actor),
        collaborationWorkspaceId: collaborationWorkspaceId(input),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.text === undefined ? {} : { text: input.text }),
        page: context.paging ?? { limit: DEFAULT_LIST_LIMIT + 1 }
      })
  });

  route.operation(update, {
    changeClass: "reversible",
    authorize: (input, { actor }) =>
      workspaces.authorizeChange(
        update.id,
        personOf(actor),
        collaborationWorkspaceId(input),
        "admin"
      ),
    resource: workspaceResource,
    execute: (input, context) =>
      workspaces.updateSettings(changeCall(update.id, context), collaborationWorkspaceId(input), {
        name: input.name,
        description: input.description,
        visibility: input.visibility,
        defaultConversationVisibility: input.defaultConversationVisibility,
        emoji: input.emoji,
        accentColor: input.accentColor
      })
  });

  route(apiOperations["workspaces.deletion_impact.get"], async ({ user, params }) => {
    return workspaces.getDeletionImpact(user, collaborationWorkspaceId(params));
  });

  route.operation(remove, {
    // Deleting a workspace and its conversations is irreversible.
    authorize: (input, { actor }) =>
      workspaces.authorizeDeletion(remove.id, personOf(actor), collaborationWorkspaceId(input)),
    resource: workspaceResource,
    execute: async (input, context) =>
      deletionState(
        await workspaces.deleteSharedWorkspace(
          changeCall(remove.id, context),
          collaborationWorkspaceId(input),
          input.confirmName
        )
      )
  });

  route(apiOperations["workspaces.members.list"], async ({ user, params }) => {
    return workspaces.listMembers(user, collaborationWorkspaceId(params));
  });

  route(apiOperations["workspaces.member_candidates.list"], async ({ user, params, query }) => {
    return workspaces.searchMemberCandidates(user, collaborationWorkspaceId(params), query.q ?? "");
  });

  route.operation(addMember, {
    changeClass: "reversible",
    authorize: (input, { actor }) =>
      workspaces.authorizeChange(
        addMember.id,
        personOf(actor),
        collaborationWorkspaceId(input),
        "admin"
      ),
    resource: workspaceResource,
    execute: (input, context) =>
      workspaces.addMemberByEmail(
        changeCall(addMember.id, context),
        collaborationWorkspaceId(input),
        input.email
      )
  });

  route.operation(leave, {
    changeClass: "reversible",
    // Every member may leave. Who is the last active Owner is decided where the membership goes.
    authorize: (input, { actor }) =>
      workspaces.authorizeChange(
        leave.id,
        personOf(actor),
        collaborationWorkspaceId(input),
        "member"
      ),
    resource: workspaceResource,
    execute: (input, context) =>
      workspaces.leaveWorkspace(changeCall(leave.id, context), collaborationWorkspaceId(input))
  });

  route.operation(updateRole, {
    changeClass: "reversible",
    authorize: (input, { actor }) =>
      workspaces.authorizeChange(
        updateRole.id,
        personOf(actor),
        collaborationWorkspaceId(input),
        "admin"
      ),
    resource: workspaceResource,
    execute: (input, context) => {
      const member = workspaceUserParams(input);
      return workspaces.changeMemberRole(
        changeCall(updateRole.id, context),
        member.collaborationWorkspaceId,
        member.userId,
        input.role
      );
    }
  });

  route.operation(removeMember, {
    changeClass: "reversible",
    authorize: (input, { actor }) =>
      workspaces.authorizeChange(
        removeMember.id,
        personOf(actor),
        collaborationWorkspaceId(input),
        "admin"
      ),
    resource: workspaceResource,
    execute: (input, context) => {
      const member = workspaceUserParams(input);
      return workspaces.removeMember(
        changeCall(removeMember.id, context),
        member.collaborationWorkspaceId,
        member.userId
      );
    }
  });

  route.operation(requestAccess, {
    changeClass: "reversible",
    // The caller has no role in the workspace yet: the workspace must be one that can be found.
    authorize: (input) => workspaces.authorizeAccessRequest(collaborationWorkspaceId(input)),
    resource: workspaceResource,
    execute: (input, context) =>
      workspaces.requestAccess(
        changeCall(requestAccess.id, context),
        collaborationWorkspaceId(input)
      )
  });

  route(apiOperations["workspaces.access_requests.list"], async ({ user, params }) => {
    return workspaces.listAccessRequests(user, collaborationWorkspaceId(params));
  });

  route.operation(approveRequest, {
    changeClass: "reversible",
    authorize: (input, { actor }) =>
      workspaces.authorizeChange(
        approveRequest.id,
        personOf(actor),
        collaborationWorkspaceId(input),
        "admin"
      ),
    resource: workspaceResource,
    execute: (input, context) => {
      const member = workspaceUserParams(input);
      return workspaces.approveAccessRequest(
        changeCall(approveRequest.id, context),
        member.collaborationWorkspaceId,
        member.userId
      );
    }
  });

  route.operation(declineRequest, {
    changeClass: "reversible",
    authorize: (input, { actor }) =>
      workspaces.authorizeChange(
        declineRequest.id,
        personOf(actor),
        collaborationWorkspaceId(input),
        "admin"
      ),
    resource: workspaceResource,
    execute: (input, context) => {
      const member = workspaceUserParams(input);
      return workspaces.declineAccessRequest(
        changeCall(declineRequest.id, context),
        member.collaborationWorkspaceId,
        member.userId
      );
    }
  });
}

/** The workspace a call changes: what its run names, and where the policy is asked. */
function workspaceResource(input: { collaborationWorkspaceId: string }): OperationResource {
  return {
    kind: "collaboration_workspace",
    id: input.collaborationWorkspaceId,
    workspaceId: asCollaborationWorkspaceId(input.collaborationWorkspaceId)
  };
}

/** What the workflow takes from the run of a changing call. */
function changeCall(operationId: string, context: OperationExecutionContext): WorkspaceChangeCall {
  return {
    operationId,
    user: personOf(context.actor),
    audit: context.audit,
    correlationId: context.correlationId
  };
}

/** These operations authenticate a person, so no service principal reaches them. */
function personOf(actor: AuthenticatedIdentity): AuthenticatedUser {
  if (isAuthenticatedServicePrincipal(actor)) {
    throw new AppError("FORBIDDEN", "Service principals cannot access user-scoped routes");
  }
  return actor;
}

function collaborationWorkspaceId(params: { collaborationWorkspaceId: string }) {
  return asCollaborationWorkspaceId(
    requirePathParam(params.collaborationWorkspaceId, "Missing Collaboration Workspace id")
  );
}

function workspaceUserParams(params: { collaborationWorkspaceId: string; userId: string }) {
  const userId = asUserId(requirePathParam(params.userId, "Missing user id"));
  return { collaborationWorkspaceId: collaborationWorkspaceId(params), userId };
}
