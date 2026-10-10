const originKinds = ["agent", "user", "cli", "mcp", "app", "workflow", "schedule"] as const;

type OperationCallOriginKind = (typeof originKinds)[number];

interface OperationCallInput {
  key: string;
  /** The value as text. The server renders it; the client shows it as written. */
  value: string;
  /** The server cut the value short for the preview. The call itself holds all of it. */
  truncated: boolean;
  /** How many characters the whole value has, where it was cut. */
  length?: number;
}

/** What became of a call once its request was decided or ended. */
export type OperationCallOutcome =
  "queued" | "done" | "failed" | "interrupted" | "refused" | "expired";

const outcomes: readonly OperationCallOutcome[] = [
  "queued",
  "done",
  "failed",
  "interrupted",
  "refused",
  "expired"
];

/**
 * What became of the call of a request that is not pending, read from what the server recorded
 * on it. A request that was approved before outcomes were recorded ran with its approval.
 */
export function operationCallOutcome(request: {
  status: string;
  applyResult?: unknown;
}): { outcome: OperationCallOutcome; reason?: string } | undefined {
  const result = isRecord(request.applyResult) ? request.applyResult : {};
  const outcome = outcomes.find((candidate) => candidate === result.execution);
  const reason = isRecord(result.error) ? readText(result.error.message) : undefined;
  if (outcome) {
    return { outcome, ...(reason ? { reason } : {}) };
  }
  return request.status === "approved" ? { outcome: "done" } : undefined;
}

/** The whole input of a held call as the request keeps it, as text. Nothing once it is removed. */
export function operationCallFullInput(payload: unknown): string | undefined {
  if (!isRecord(payload) || payload.inputRemoved === true || !("input" in payload)) {
    return undefined;
  }
  return typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input, null, 2);
}

export interface OperationCallPreview {
  runId: string;
  operation: string;
  effect: "reading" | "changing";
  actor: { kind: "user" | "service_principal"; id: string; label: string };
  origin: { kind: OperationCallOriginKind; agentName?: string; toolName?: string };
  workspaceId?: string;
  inputs: OperationCallInput[];
  /** How many fields the input has. More than `inputs` where the preview lists only the first. */
  inputFieldCount: number;
  /** The request ended and its input was removed. */
  inputRemoved: boolean;
  /** After this moment the call expires unexecuted. */
  expiresAt?: string;
}

/**
 * The preview of an operation call that waits for approval, as the server's handler renders it.
 * A preview without the operation, the actor or a known origin yields `undefined`: an approver
 * must not decide a call the item cannot name. An input that cannot be read is left out.
 */
export function parseOperationCallPreview(preview: unknown): OperationCallPreview | undefined {
  if (!isRecord(preview)) {
    return undefined;
  }
  const runId = readText(preview.runId);
  const operation = readText(preview.operation);
  const actor = parseActor(preview.actor);
  const origin = parseOrigin(preview.origin);
  if (!runId || !operation || !actor || !origin) {
    return undefined;
  }
  if (preview.effect !== "reading" && preview.effect !== "changing") {
    return undefined;
  }
  const workspaceId = readText(preview.workspaceId);
  const expiresAt = readText(preview.expiresAt);
  const inputs = Array.isArray(preview.inputs)
    ? preview.inputs.flatMap((input) => parseInput(input) ?? [])
    : [];
  return {
    runId,
    operation,
    effect: preview.effect,
    actor,
    origin,
    inputs,
    inputFieldCount:
      typeof preview.inputFieldCount === "number"
        ? Math.max(preview.inputFieldCount, inputs.length)
        : inputs.length,
    inputRemoved: preview.inputRemoved === true,
    ...(workspaceId ? { workspaceId } : {}),
    ...(expiresAt ? { expiresAt } : {})
  };
}

function parseActor(value: unknown): OperationCallPreview["actor"] | undefined {
  if (!isRecord(value) || (value.kind !== "user" && value.kind !== "service_principal")) {
    return undefined;
  }
  const id = readText(value.id);
  const label = readText(value.label) ?? id;
  return id && label ? { kind: value.kind, id, label } : undefined;
}

function parseOrigin(value: unknown): OperationCallPreview["origin"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = originKinds.find((candidate) => candidate === value.kind);
  if (!kind) {
    return undefined;
  }
  const agentName = readText(value.agentName);
  const toolName = readText(value.toolName);
  return { kind, ...(agentName ? { agentName } : {}), ...(toolName ? { toolName } : {}) };
}

function parseInput(value: unknown): OperationCallInput | undefined {
  if (!isRecord(value) || typeof value.value !== "string") {
    return undefined;
  }
  const key = readText(value.key);
  return key
    ? {
        key,
        value: value.value,
        truncated: value.truncated === true,
        ...(typeof value.length === "number" ? { length: value.length } : {})
      }
    : undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
