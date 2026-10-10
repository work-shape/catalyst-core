const originKinds = ["agent", "user", "cli", "mcp", "app", "workflow", "schedule"] as const;

export type OperationCallOriginKind = (typeof originKinds)[number];

export interface OperationCallInput {
  key: string;
  /** The value as text. The server renders it; the client shows it as written. */
  value: string;
  /** The server cut the value short for the preview. The call itself holds all of it. */
  truncated: boolean;
}

export interface OperationCallPreview {
  runId: string;
  operation: string;
  effect: "reading" | "changing";
  actor: { kind: "user" | "service_principal"; id: string; label: string };
  origin: { kind: OperationCallOriginKind; agentName?: string; toolName?: string };
  workspaceId?: string;
  inputs: OperationCallInput[];
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
  return {
    runId,
    operation,
    effect: preview.effect,
    actor,
    origin,
    inputs: Array.isArray(preview.inputs)
      ? preview.inputs.flatMap((input) => parseInput(input) ?? [])
      : [],
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
  return key ? { key, value: value.value, truncated: value.truncated === true } : undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
