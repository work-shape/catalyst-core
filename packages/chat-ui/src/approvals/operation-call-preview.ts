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

/** The kind of asset whose content the item shows. */
export const SKILL_ASSET_KIND = "skill";

/** The asset a held save writes, as the server describes it while the call waits. */
export interface OperationCallAsset {
  kind: string;
  name: string;
  title: string;
  /** The registered prefix the asset's name starts with. */
  namespace?: string;
  /** Approving creates the asset. */
  isNew: boolean;
  /** A skill's text in the shape `SkillChangeBody` reads. An opened request has it, a row has not. */
  content?: unknown;
  /** A skill's description as the call saves it. */
  description?: string;
  /** The stored title and description, each where the call changes it. */
  previous: { title?: string; description?: string };
  /** The resources the stored skill has and the call leaves out. */
  removedResources: string[];
  /** The reader may not read the stored skill, so nothing is compared with it. */
  beforeWithheld: boolean;
}

/** The values of `heldBy` that are a standing rule of the instance, not one finding. */
const standingRules = ["instance_default", "declared_default", "central_setting"];

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
  /** What the call saves, where it is a save of an asset that still waits. */
  asset?: OperationCallAsset;
  /** A setting or a default of the instance made the call wait. Unknown for an older request. */
  heldByRule: boolean;
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
  const asset = parseAsset(preview.asset);
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
    heldByRule: standingRules.includes(readText(preview.heldBy) ?? ""),
    ...(asset ? { asset } : {}),
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

function parseAsset(value: unknown): OperationCallAsset | undefined {
  if (!isRecord(value) || typeof value.isNew !== "boolean") {
    return undefined;
  }
  const kind = readText(value.kind);
  const name = readText(value.name);
  if (!kind || !name) {
    return undefined;
  }
  const namespace = readText(value.namespace);
  const previous = isRecord(value.previous) ? value.previous : {};
  const previousTitle = readText(previous.title);
  const previousDescription = readText(previous.description);
  const description = readText(value.description);
  return {
    kind,
    name,
    title: readText(value.title) ?? name,
    isNew: value.isNew,
    previous: {
      ...(previousTitle ? { title: previousTitle } : {}),
      ...(previousDescription ? { description: previousDescription } : {})
    },
    removedResources: Array.isArray(value.removedResources)
      ? value.removedResources.flatMap((path) => readText(path) ?? [])
      : [],
    beforeWithheld: value.beforeWithheld === true,
    ...(namespace ? { namespace } : {}),
    ...(description ? { description } : {}),
    ...(value.content === undefined ? {} : { content: value.content })
  };
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
