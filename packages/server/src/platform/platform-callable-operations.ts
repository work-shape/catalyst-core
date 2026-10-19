import {
  CONNECTION_OPERATION_PREFIX,
  DATA_STORE_OPERATION_PREFIX,
  KNOWLEDGE_OPERATION_PREFIX,
  WORKFLOW_OPERATION_PREFIX,
  unknownToJsonValue,
  type JsonObject,
  type OperationDefinition,
  type ConversationId,
  type OperationOrigin
} from "@work-shape/catalyst-core";
import { MAX_LIST_LIMIT } from "@work-shape/catalyst-api-contract";
import type {
  PlatformOperationsAudience,
  PlatformOperationsQuery
} from "@work-shape/catalyst-tool-execution";
import { z } from "zod";
import type { AssetCall } from "../assets/asset-access";
import type { AssetWorkflowOptions } from "../types";
import { resolveOperationResource } from "../operations/operation-resource";
import { paginate, pageScope, storePage } from "../http/paging";

// Who would call the operations `platform.assets.operations` lists: a step of a Workflow, or a
// `connection` action of an App. Each audience is offered the operations exposed to its own
// surface, as the operation's own rule asks of a call from there.

/**
 * The operations that exist as data, by who names them: a step of a Workflow names any of
 * them; a `connection` action of an App names an operation of a Connection, and reaches a Data
 * Store and a Workflow through actions of their own kinds.
 */
const CALLABLE_PREFIXES: Readonly<Record<PlatformOperationsAudience, readonly string[]>> = {
  workflow: [
    CONNECTION_OPERATION_PREFIX,
    DATA_STORE_OPERATION_PREFIX,
    KNOWLEDGE_OPERATION_PREFIX,
    WORKFLOW_OPERATION_PREFIX
  ],
  app: [CONNECTION_OPERATION_PREFIX]
};

/** Whether the audience names an operation of this name at all. */
function callableByAudience(name: string, audience: PlatformOperationsAudience): boolean {
  return CALLABLE_PREFIXES[audience].some((prefix) => name.startsWith(prefix));
}

/**
 * The origin an operation's rule is asked from for the list: a step of a Workflow, or an action
 * of a Page of the agent's conversation. An operation not exposed to that surface is none the
 * audience may name. A Page names no App, so no App is asked.
 */
function listingOrigin(
  audience: PlatformOperationsAudience,
  conversationId: ConversationId
): OperationOrigin {
  return audience === "app"
    ? { kind: "app", appRevisionId: "", actionName: "", pageSessionId: "", conversationId }
    : { kind: "workflow", workflowRunId: "", stepRunId: "" };
}

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** The input or output of an operation as JSON Schema, where it can be told as one. */
export function jsonSchemaOf(
  given: JsonObject | undefined,
  schema: z.ZodType
): JsonObject | undefined {
  if (given) return given;
  try {
    const derived = jsonObjectSchema.safeParse(z.toJSONSchema(schema, { unrepresentable: "any" }));
    if (!derived.success || Object.keys(derived.data).length <= 1) return undefined;
    const value = unknownToJsonValue(derived.data);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The caller's callable operations, using the catalog's scoped, exclusive name cursor. */
export async function listCallableOperations(
  options: AssetWorkflowOptions,
  call: AssetCall,
  conversationId: ConversationId,
  audience: PlatformOperationsAudience,
  input: PlatformOperationsQuery
) {
  const query = { ...input, for: audience, limit: MAX_LIST_LIMIT };
  const scope = pageScope("operations.list_callable", {}, query);
  const paging = storePage(query, ["name"], scope);
  const after = paging.after?.[0];
  const listing = await options.operationCalls?.registry.list({});
  const candidates = (listing?.operations ?? [])
    .filter(
      (definition) =>
        callableByAudience(definition.name, audience) &&
        (input.name === undefined || definition.name === input.name) &&
        (input.prefix === undefined || definition.name.startsWith(input.prefix)) &&
        (typeof after !== "string" ||
          Buffer.compare(Buffer.from(definition.name), Buffer.from(after)) > 0)
    )
    .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  const visible: OperationDefinition[] = [];
  for (const definition of candidates) {
    try {
      const { resource, resourceNotFound } = await resolveOperationResource(
        options,
        definition.resource({})
      );
      if (resourceNotFound) continue;
      const decision =
        definition.action !== null
          ? call.access.authorize(definition.action, resource)
          : await definition.authorize(
              {},
              {
                actor: call.actor,
                origin: listingOrigin(audience, conversationId),
                correlationId: call.correlationId,
                access: call.access,
                resource
              }
            );
      if (!decision.allowed) continue;
    } catch {
      continue;
    }
    visible.push(definition);
    // One authorized lookahead proves another page exists without revealing a hidden key.
    if (visible.length === paging.limit) break;
  }
  const page = paginate(visible, query, ["name"], false, scope);
  return {
    operations: page.items.map((definition) => {
      const inputSchema = jsonSchemaOf(definition.inputJsonSchema, definition.inputSchema);
      const outputSchema = jsonSchemaOf(definition.outputJsonSchema, definition.outputSchema);
      return {
        name: definition.name,
        effect: definition.effect,
        ...(inputSchema ? { inputSchema } : {}),
        ...(outputSchema ? { outputSchema } : {})
      };
    }),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    truncated: !!page.nextCursor || (listing?.truncated.length ?? 0) > 0
  };
}
