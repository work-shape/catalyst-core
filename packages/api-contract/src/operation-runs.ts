import { z } from "zod";
import { timestampSchema } from "./shared";

export const operationRunOriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent"),
    agentRunId: z.string(),
    conversationId: z.string(),
    agentName: z.string(),
    toolCallId: z.string(),
    toolName: z.string()
  }),
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("cli") }),
  z.object({ kind: z.literal("mcp"), clientName: z.string().optional() }),
  z.object({
    kind: z.literal("app"),
    appRevisionId: z.string(),
    actionName: z.string(),
    pageSessionId: z.string(),
    conversationId: z.string().optional()
  }),
  z.object({ kind: z.literal("workflow"), workflowRunId: z.string(), stepRunId: z.string() }),
  z.object({ kind: z.literal("schedule"), scheduleId: z.string() })
]);

export const operationRunStatusSchema = z.enum([
  "running",
  "pending_confirmation",
  "pending_approval",
  "done",
  "failed",
  "denied",
  "expired"
]);

/**
 * The record of one call of an operation, as a caller reads it. It names the input by its
 * hash and holds neither the input nor what the call answered.
 */
export const operationRunSchema = z.object({
  id: z.string(),
  operation: z.string(),
  effect: z.enum(["reading", "changing"]),
  status: operationRunStatusSchema,
  actor: z.object({
    kind: z.enum(["user", "service_principal"]),
    id: z.string(),
    label: z.string()
  }),
  origin: operationRunOriginSchema,
  workspaceId: z.string().optional(),
  /** The request another person decides, while and after the run waits for it. */
  approvalRequestId: z.string().optional(),
  inputHash: z.string(),
  attempt: z.number().int().min(1),
  decision: z
    .object({
      mode: z.enum(["direct", "confirmed", "approved", "declined"]),
      by: z.string(),
      at: timestampSchema,
      comment: z.string().optional()
    })
    .optional(),
  /** Why the run failed or was refused: a code and a message, never a provider's text. */
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  correlationId: z.string(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
  /** When a waiting run expires unexecuted. */
  expiresAt: timestampSchema.optional(),
  /** Where this run is read. */
  href: z.string()
});

export type OperationRunResource = z.infer<typeof operationRunSchema>;
