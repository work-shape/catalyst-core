import { listQuerySchema } from "../shared";
import {
  administeredCollaborationWorkspaceSchema,
  agentAvailabilitySchema,
  configAssetMutationVersionResponseSchema,
  configAssetsOverviewSchema,
  setConfigAgentAvailabilityRequestSchema,
  setDefaultConfigAgentRequestSchema
} from "../configuration";
import { defineOperation, json, page } from "./define-operation";

export const configAssetOperations = {
  "config_assets.get_overview": defineOperation({
    id: "config_assets.get_overview",
    method: "GET",
    path: "/api/v1/instance/config/assets",
    summary: "List agents and skills with their revisions",
    tag: "Config Assets",
    auth: "principal",
    scope: "config_assets:read",
    requires: ["agent.read", "skill.read"],
    effect: "reading",
    response: json(configAssetsOverviewSchema),
    errors: [],
    rateClass: "read"
  }),
  "config_agents.set_default": defineOperation({
    id: "config_agents.set_default",
    method: "PUT",
    path: "/api/v1/instance/config/default-agent",
    summary: "Set or clear the default agent",
    tag: "Config Assets",
    auth: "principal",
    scope: "config_assets:write",
    requires: ["agent.write"],
    effect: "changing",
    body: setDefaultConfigAgentRequestSchema,
    response: json(configAssetMutationVersionResponseSchema),
    errors: ["CONFLICT"],
    rateClass: "write"
  }),
  "config_agents.set_availability": defineOperation({
    id: "config_agents.set_availability",
    method: "PUT",
    path: "/api/v1/instance/config/agents/:name/availability",
    summary: "Set the workspaces an agent is available in",
    tag: "Config Assets",
    auth: "principal",
    scope: "config_assets:write",
    requires: ["agent.write"],
    effect: "changing",
    body: setConfigAgentAvailabilityRequestSchema,
    response: json(agentAvailabilitySchema),
    errors: [],
    rateClass: "write"
  }),
  "instance.workspaces.list": defineOperation({
    id: "instance.workspaces.list",
    method: "GET",
    path: "/api/v1/instance/workspaces",
    summary: "List the Shared Workspaces an agent can be made available in",
    tag: "Config Assets",
    auth: "principal",
    scope: "config_assets:write",
    requires: ["agent.write"],
    effect: "reading",
    query: listQuerySchema,
    response: page(administeredCollaborationWorkspaceSchema, ["createdAt", "id"], false),
    errors: [],
    rateClass: "read"
  })
} as const;
