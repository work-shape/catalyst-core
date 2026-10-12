import {
  CONNECTION_EXPOSURES,
  CONNECTION_HEALTH_STATES,
  CONNECTION_NAME_MAX_LENGTH,
  CONNECTION_NAME_PATTERN
} from "@vivd-catalyst/asset-schemas";
import { z } from "zod";
import { timestampSchema } from "../shared";
import { defineRegisteredOperation, json } from "./define-operation";

// What a Connection's page and an agent's editor read beyond the asset itself, and the test
// of a Connection. The asset, with name, settings and accepted operations, is read through
// `assets.get`. Nothing here answers a secret, a handle of one, or data of the outside system.

/** How long the description of an operation is at most as these answers carry it. */
export const CONNECTION_OPERATION_DESCRIPTION_MAX_CHARS = 4_000;

const connectionNameSchema = z
  .string()
  .max(CONNECTION_NAME_MAX_LENGTH)
  .regex(CONNECTION_NAME_PATTERN);

const connectionOperationEffectSchema = z.enum(["reading", "changing"]);

export const connectionOperationStatusSchema = z.enum([
  "ready",
  "awaiting_discovery",
  "needs_review",
  "unknown",
  "disabled"
]);

/** What anybody may learn of a Connection's secret: whether there is one, and its version. */
export const connectionSecretStateSchema = z.object({
  state: z.enum(["set", "not_set", "unreadable"]),
  version: z.number().int().optional()
});

export const connectionOperationDetailSchema = z.object({
  name: z.string(),
  /** The name an agent, an App and a Workflow hold: `connection.<name>.<operation>`. */
  toolName: z.string(),
  effect: connectionOperationEffectSchema,
  exposure: z.array(z.enum(CONNECTION_EXPOSURES)),
  enabled: z.boolean(),
  status: connectionOperationStatusSchema,
  /** As the outside system or the release describes it. Untrusted text, shown as text. */
  description: z.string().max(CONNECTION_OPERATION_DESCRIPTION_MAX_CHARS).optional(),
  /** Only with status `needs_review`: the fingerprint to accept in the Connection's config. */
  discoveredFingerprint: z.string().optional()
});

export const connectionDetailSchema = z.object({
  name: z.string(),
  health: z.enum(CONNECTION_HEALTH_STATES),
  lastTestedAt: timestampSchema.optional(),
  lastErrorCode: z.string().optional(),
  secret: connectionSecretStateSchema,
  /** One credential for everyone who may use the Connection. The page says so. */
  sharedCredential: z.boolean(),
  operations: z.array(connectionOperationDetailSchema),
  /** The agents that carry a tool of this Connection, each one the caller may read. */
  usedBy: z.array(
    z.object({ agentName: z.string(), title: z.string(), toolNames: z.array(z.string()) })
  ),
  discoveredAt: timestampSchema.optional()
});

export const connectionTestResultSchema = z.object({
  status: z.enum(["ready", "unauthorized", "network_denied", "unavailable"]),
  testedAt: timestampSchema
});

export const connectionToolSchema = z.object({
  toolName: z.string(),
  operation: z.string(),
  description: z.string().max(CONNECTION_OPERATION_DESCRIPTION_MAX_CHARS).optional(),
  effect: connectionOperationEffectSchema
});

/** The tools an agent may carry: agent-exposed, enabled and ready, by Connection. */
export const connectionToolsSchema = z.object({
  connections: z.array(
    z.object({ name: z.string(), title: z.string(), tools: z.array(connectionToolSchema) })
  )
});

export type ConnectionDetail = z.infer<typeof connectionDetailSchema>;
export type ConnectionOperationDetail = z.infer<typeof connectionOperationDetailSchema>;
export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;
export type ConnectionTools = z.infer<typeof connectionToolsSchema>;

/** The one field these operations take: the Connection's name, from the path. */
export const connectionNameParamsSchema = z.object({ name: connectionNameSchema });

// Each is an operation of the registry. None names its right in `requires`: the right is the
// Connection's own (`connection.read`, `connection.write`) and is decided on the Connection
// the call names, where a grant in a Namespace or on the asset can answer it.
export const connectionOperations = {
  "connections.get": defineRegisteredOperation({
    id: "connections.get",
    method: "GET",
    path: "/api/v1/connections/:name",
    summary: "Read the health, the secret state, the operations and the users of one Connection",
    tag: "Connections",
    auth: "principal",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    response: json(connectionDetailSchema),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  "connections.test": defineRegisteredOperation({
    id: "connections.test",
    method: "POST",
    path: "/api/v1/connections/:name/test",
    summary: "Check that one Connection reaches its system and is let in",
    tag: "Connections",
    auth: "principal",
    scope: "config_assets:write",
    requires: [],
    effect: "changing",
    response: json(connectionTestResultSchema),
    errors: ["NOT_FOUND", "CONFLICT"],
    rateClass: "write"
  }),
  // A path of its own: `agent-tools` would be a valid Connection name under `/connections/`.
  "connections.list_tools": defineRegisteredOperation({
    id: "connections.list_tools",
    method: "GET",
    path: "/api/v1/connection-tools",
    summary: "List the tools of the Connections the caller may read that an agent can carry",
    tag: "Connections",
    auth: "principal",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    response: json(connectionToolsSchema),
    errors: [],
    rateClass: "read"
  })
} as const;
