import {
  APPROVAL_EXECUTIONS,
  OPERATION_EFFECTS,
  OPERATION_ORIGIN_KINDS,
  PRINCIPAL_HOLDER_KINDS,
  type PolicySource
} from "@work-shape/catalyst-core";
const originKinds = OPERATION_ORIGIN_KINDS;

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
export type OperationCallOutcome = (typeof APPROVAL_EXECUTIONS)[number];

const outcomes: readonly OperationCallOutcome[] = [...APPROVAL_EXECUTIONS];

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

/**
 * Whether a request is the confirmation of the person a call acts for, addressed to them alone
 * (OP-4b): only they see it, and they answer it with Allow or Deny.
 */
export function isInboxConfirmation(request: {
  addresseeUserId?: string;
  preview?: unknown;
}): boolean {
  return (
    request.addresseeUserId !== undefined ||
    (isRecord(request.preview) && request.preview.mode === "confirmation")
  );
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

/** Why a held publish can no longer be approved: what it would publish moved since. */
export type PublishStale = "gone" | "draft_moved" | "live_moved";
const staleReasons: readonly PublishStale[] = ["gone", "draft_moved", "live_moved"];

/** One entry of a list that is new or changed against the live revision. */
export interface PublishChange {
  label: string;
  change: "new" | "changed" | "added" | "removed";
}

/**
 * What a held publish makes live, against the live revision, as the server reviewed it while
 * the request waits (GR-PUB-1).
 */
export interface PublishReview {
  kind: string;
  title: string;
  revision: number;
  /** The live revision it replaces. Absent before the first publish. */
  liveRevision?: number;
  files: PublishChange[];
  /** The actions or the steps that change something, new or changed. Absent where unknown. */
  changing?: PublishChange[];
  hostsAdded: string[];
  connections: string[];
  dataStores: { name: string; minSchema?: number }[];
  runAs?: string;
  stale?: PublishStale;
}

/** The values of `heldBy` that are a standing rule of the instance, not one finding. */
const standingRules: readonly string[] = [
  "instance_default",
  "declared_default",
  "central_setting"
] as const satisfies readonly PolicySource[];

export interface OperationCallPreview {
  runId: string;
  operation: string;
  effect: (typeof OPERATION_EFFECTS)[number];
  actor: { kind: (typeof PRINCIPAL_HOLDER_KINDS)[number]; id: string; label: string };
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
  /** What a held publish makes live, for one opened request that still waits. */
  review?: PublishReview;
  /** A setting or a default of the instance made the call wait. Unknown for an older request. */
  heldByRule: boolean;
  /**
   * The operation's own floor made the call wait: what a named action declares or what the
   * Connection operation it stands for asks. No setting of the instance lowers it.
   */
  heldByFloor: boolean;
  /**
   * The call waits for the confirmation of the person it acts for, who was not present, in
   * their Inbox (OP-4b). Without it, the call waits for another person's approval.
   */
  confirmation?: true;
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
  const review = parseReview(preview.review);
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
    heldByFloor: preview.heldBy === "policy_floor",
    ...(preview.mode === "confirmation" ? { confirmation: true as const } : {}),
    ...(asset ? { asset } : {}),
    ...(review ? { review } : {}),
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

function parseReview(value: unknown): PublishReview | undefined {
  if (!isRecord(value) || typeof value.revision !== "number") return undefined;
  const kind = readText(value.kind);
  const name = readText(value.name);
  if (!kind || !name) return undefined;
  const texts = (list: unknown) =>
    Array.isArray(list) ? list.flatMap((entry) => readText(entry) ?? []) : [];
  const changes = (list: unknown, label: "path" | "label"): PublishChange[] =>
    Array.isArray(list)
      ? list.flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const text = readText(entry[label]);
          const change = changeKinds.find((candidate) => candidate === entry.change);
          return text && change ? [{ label: text, change }] : [];
        })
      : [];
  const runAs = readText(value.runAs);
  const stale = staleReasons.find((reason) => reason === value.stale);
  return {
    kind,
    title: readText(value.title) ?? name,
    revision: value.revision,
    ...(typeof value.liveRevision === "number" ? { liveRevision: value.liveRevision } : {}),
    files: changes(value.files, "path"),
    ...(Array.isArray(value.changing) ? { changing: changes(value.changing, "label") } : {}),
    hostsAdded: texts(value.hostsAdded),
    connections: texts(value.connections),
    dataStores: Array.isArray(value.dataStores)
      ? value.dataStores.flatMap((store) => {
          if (!isRecord(store)) return [];
          const storeName = readText(store.name);
          return storeName
            ? [
                {
                  name: storeName,
                  ...(typeof store.minSchema === "number" ? { minSchema: store.minSchema } : {})
                }
              ]
            : [];
        })
      : [],
    ...(runAs ? { runAs } : {}),
    ...(stale ? { stale } : {})
  };
}

const changeKinds: readonly PublishChange["change"][] = ["new", "changed", "added", "removed"];

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
