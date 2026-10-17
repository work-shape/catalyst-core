import {
  agentProposalResponseSchema,
  agentTryConversationResponseSchema,
  applyAgentProposalRequestSchema,
  discardAgentProposalResponseSchema
} from "../agent-proposals";
import { assetWriteResponseSchema } from "../assets";
import { defineRegisteredOperation, json } from "./define-operation";

// The pending change proposal of an agent, which the agent of a Build conversation wrote (TRY-1a).
// Each names the agent and the caller's own Build conversation; anybody else's conversation is
// answered as missing. None names its right in `requires`: the right is the agent's own
// (`agent.read`, `agent.write`), decided on the agent as `assets.*` decide it.
export const agentOperations = {
  "agents.proposal.get": defineRegisteredOperation({
    id: "agents.proposal.get",
    method: "GET",
    path: "/api/v1/agents/:name/proposals/:conversationId",
    summary: "Read the pending change proposal a Build conversation made for an agent",
    tag: "Agents",
    auth: "user",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    response: json(agentProposalResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  // Apply is the person's own save of the agent, with the checks, guardrails, revision and
  // audit of `assets.put`. It writes on the proposal's base revision only.
  "agents.proposal.apply": defineRegisteredOperation({
    id: "agents.proposal.apply",
    method: "POST",
    path: "/api/v1/agents/:name/proposals/:conversationId/apply",
    summary: "Make a pending change proposal the agent's live revision",
    tag: "Agents",
    auth: "user",
    scope: "config_assets:write",
    requires: [],
    effect: "changing",
    body: applyAgentProposalRequestSchema,
    response: json(assetWriteResponseSchema),
    errors: ["NOT_FOUND", "CONFLICT", "REVISION_CONFLICT"],
    rateClass: "write"
  }),
  "agents.proposal.discard": defineRegisteredOperation({
    id: "agents.proposal.discard",
    method: "POST",
    path: "/api/v1/agents/:name/proposals/:conversationId/discard",
    summary: "Drop a pending change proposal. The agent stays as it is",
    tag: "Agents",
    auth: "user",
    scope: "config_assets:write",
    requires: [],
    effect: "changing",
    response: json(discardAgentProposalResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  }),
  // Who may decide on the proposal may try it: the write right on the agent. The Build
  // conversation is the caller's own conversation about the agent; any other is answered as a
  // missing one. The Try conversation goes with an Apply, a Discard and the Build conversation.
  "agents.try.open": defineRegisteredOperation({
    id: "agents.try.open",
    method: "POST",
    path: "/api/v1/agents/:name/try/:conversationId",
    summary:
      "Open the Try conversation of an agent beside a Build conversation, made where there is none",
    tag: "Agents",
    auth: "user",
    scope: "config_assets:write",
    requires: [],
    effect: "changing",
    response: json(agentTryConversationResponseSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  })
} as const;
