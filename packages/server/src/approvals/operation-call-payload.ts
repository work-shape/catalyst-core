import {
  AUTH_PRINCIPAL_KINDS,
  OPERATION_EFFECTS,
  OPERATION_ORIGIN_KINDS,
  AppError,
  isJsonObject,
  unknownToJsonValue,
  type JsonObject,
  type JsonValue
} from "@work-shape/catalyst-core";
import { z } from "zod";

/**
 * How many input fields the item of a held call lists, and how much of each value it shows in
 * its row. What it leaves out it counts, and the full view shows the whole input as it was
 * frozen. Both bound what one item puts on the screen; the call always holds all of it.
 */
const HELD_OPERATION_PREVIEW_MAX_FIELDS = 50;
const HELD_OPERATION_PREVIEW_VALUE_MAX_CHARS = 2000;

const principalSchema = z.object({
  kind: z.enum(AUTH_PRINCIPAL_KINDS),
  id: z.string(),
  displayLabel: z.string(),
  authSource: z.string(),
  externalUserId: z.string().optional()
});

/**
 * The frozen call. The run keeps what the call is and who made it; the request keeps what the
 * run must not: the input, and how the person was signed in when they made the call.
 */
export const payloadSchema = z.object({
  runId: z.string().min(1),
  operation: z.string().min(1),
  effect: z.enum(OPERATION_EFFECTS),
  input: z.unknown().optional(),
  /** The kind preview retained after the executable input is removed. */
  asset: z.record(z.string(), z.json()).optional(),
  /** What the call is about, as `approval` of its operation froze it when it was held. */
  subject: z.record(z.string(), z.json()).optional(),
  /**
   * The kind of held call whose `subject` this is, where the request is of another kind: a
   * confirmation in the Inbox of a publish is an `operation_call` about an `app_publish`.
   */
  subjectKind: z.string().optional(),
  /** Set once the request ended: the input and how the person was signed in are gone. */
  inputRemoved: z.literal(true).optional(),
  /**
   * `confirmation`: the request is the confirmation of the person the call acts for, who was
   * not present, addressed to them alone (OP-4b). Without it, another person's approval.
   */
  mode: z.literal("confirmation").optional(),
  actor: z.object({
    id: z.string().min(1),
    label: z.string(),
    externalUserId: z.string().optional(),
    authSource: z.string().optional(),
    subjectUserId: z.string().optional(),
    principal: principalSchema.optional(),
    scopes: z.array(z.string()).optional()
  }),
  origin: z.object({
    kind: z.enum(OPERATION_ORIGIN_KINDS),
    agentName: z.string().optional(),
    toolName: z.string().optional()
  }),
  workspaceId: z.string().optional(),
  /**
   * What the call's before-events read when it was held, merged into the input when it is
   * executed: the revision of a Page an App is written from, for instance.
   */
  heldInput: z.record(z.string(), z.unknown()).optional(),
  /**
   * Where the value came from that made the call wait: a setting or a default of the instance,
   * or a guardrail. A request that was filed before this was kept names nothing.
   */
  heldBy: z
    .enum(["instance_default", "declared_default", "policy_floor", "central_setting", "guardrail"])
    .optional(),
  expiresAt: z.string()
});

export type OperationCallPayload = z.infer<typeof payloadSchema>;

export function parsePayload(payload: JsonObject): OperationCallPayload {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Invalid operation call payload", {
      issues: parsed.error.issues
    });
  }
  return parsed.data;
}

export function toJsonObject(value: unknown): JsonObject {
  const json = unknownToJsonValue(value);
  if (!isJsonObject(json)) {
    throw new AppError("INTERNAL", "An operation call is not a JSON object");
  }
  return json;
}

/**
 * What a person who decides is shown: the call, who made it and its input, field by field.
 * A text is a row as it is written, and every other value is a row of indented JSON, so no
 * row is one escaped line. Nothing is left out without a count: `inputFieldCount` is how many
 * rows the call has, and a row that was cut says how long its value is. The request itself
 * carries the whole input.
 */
export function previewOf(payload: OperationCallPayload) {
  const fields = payload.inputRemoved ? [] : inputFields(unknownToJsonValue(payload.input));
  return {
    runId: payload.runId,
    operation: payload.operation,
    effect: payload.effect,
    ...(payload.mode ? { mode: payload.mode } : {}),
    actor: { kind: "user", id: payload.actor.id, label: payload.actor.label },
    origin: payload.origin,
    ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
    ...(payload.heldBy ? { heldBy: payload.heldBy } : {}),
    inputs: fields.slice(0, HELD_OPERATION_PREVIEW_MAX_FIELDS).map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return text.length > HELD_OPERATION_PREVIEW_VALUE_MAX_CHARS
        ? {
            key,
            value: text.slice(0, HELD_OPERATION_PREVIEW_VALUE_MAX_CHARS),
            truncated: true,
            length: text.length
          }
        : { key, value: text };
    }),
    inputFieldCount: fields.length,
    ...(payload.inputRemoved ? { inputRemoved: true } : {}),
    expiresAt: payload.expiresAt
  };
}

/**
 * The rows of an input. A field that holds an object is one row for each of its own fields,
 * named `field.inner`: a long text inside it, such as the instructions of a definition, is
 * then a row of its own and is cut on its own.
 */
function inputFields(input: JsonValue): [string, JsonValue][] {
  if (!isJsonObject(input)) return [["input", input]];
  const rows = (fields: JsonObject, prefix: string): [string, JsonValue][] =>
    Object.entries(fields).flatMap(([key, value]): [string, JsonValue][] =>
      value === undefined ? [] : [[`${prefix}${key}`, value]]
    );
  return rows(input, "").flatMap(([key, value]) =>
    isJsonObject(value) && Object.keys(value).length > 0 ? rows(value, `${key}.`) : [[key, value]]
  );
}
