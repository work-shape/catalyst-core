import type { AppAction, AppMode } from "@vivd-catalyst/api-client";
import type { BadgeTone } from "@vivd-catalyst/ui";
import type { TranslationKey } from "../i18n";
import { PAGE_ADDRESS_LIFETIME_MS, PAGE_ADDRESS_RENEWAL_MARGIN_MS } from "../pages/page-address";
import type { AppRights } from "./app-model";

// The named actions of an App as the interface shows them: what a row says of an action, who
// is offered its test, and what the test dialog checks before it calls and shows after. The
// instance decides every call itself. What is checked here spares a call that cannot pass.

/** What a call of an action would come to for the reader, as a row says it. */
export interface AppActionOutcome {
  labelKey: TranslationKey;
  tone: BadgeTone;
}

const policyOutcomes: Record<AppAction["policy"], AppActionOutcome> = {
  allow: { labelKey: "apps.actionPolicyAllow", tone: "success" },
  confirm: { labelKey: "apps.actionPolicyConfirm", tone: "info" },
  approval: { labelKey: "apps.actionPolicyApproval", tone: "warning" },
  deny: { labelKey: "apps.actionPolicyDeny", tone: "neutral" }
};

/**
 * What a place says a call of an action would come to. The Actions side of a draft says what
 * the draft does with it: a changing action is not carried out there whatever the policy
 * says, and a reading one that would run can be tested. Everywhere else it is the policy's
 * word.
 */
export function appActionOutcome(
  action: Pick<AppAction, "effect" | "policy">,
  /** The place shows the draft as its frame runs it: in safe mode. */
  safeMode: boolean
): AppActionOutcome {
  if (!safeMode) {
    return policyOutcomes[action.policy];
  }
  if (action.effect === "changing") {
    return { labelKey: "apps.actionNotCarriedOutInDraft", tone: "neutral" };
  }
  return action.policy === "allow"
    ? { labelKey: "apps.actionTestableInDraft", tone: "success" }
    : policyOutcomes[action.policy];
}

export const appActionUnavailableKeys: Record<
  NonNullable<AppAction["unavailable"]>,
  TranslationKey
> = {
  connection_missing: "apps.actionConnectionMissing",
  connection_disabled: "apps.actionConnectionDisabled",
  operation_missing: "apps.actionOperationMissing",
  operation_disabled: "apps.actionOperationDisabled",
  not_exposed: "apps.actionNotExposed",
  data_store_missing: "apps.actionDataStoreMissing",
  workflows_off: "apps.actionWorkflowsOff"
};

/**
 * Whether the row offers the test: a reading action of a draft, and one that starts a
 * Workflow, to whoever writes the App. The test is a real call, so the instance asks every
 * right again when it is made. A draft starts no Workflow: it answers what it would have
 * started.
 */
export function appActionTestable(
  action: Pick<AppAction, "effect" | "kind">,
  view: AppMode,
  rights: Pick<AppRights, "write">
): boolean {
  return (
    rights.write && view === "draft" && (action.effect === "reading" || action.kind === "workflow")
  );
}

/** What an input cannot be sent for. Each names the parameter where one is at fault. */
export type AppActionInputProblem =
  | { kind: "not_json" }
  | { kind: "not_object" }
  | { kind: "missing"; name: string }
  | { kind: "unknown"; name: string }
  | { kind: "wrong_type"; name: string; expected: AppActionParameterType }
  | { kind: "not_allowed"; name: string };

const parameterTypes = ["string", "integer", "number", "boolean", "array"] as const;
export type AppActionParameterType = (typeof parameterTypes)[number];

export const appActionParameterTypeKeys: Record<AppActionParameterType, TranslationKey> = {
  string: "apps.actionInputTypeString",
  integer: "apps.actionInputTypeInteger",
  number: "apps.actionInputTypeNumber",
  boolean: "apps.actionInputTypeBoolean",
  array: "apps.actionInputTypeArray"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(definition: unknown): AppActionParameterType | undefined {
  const type = isRecord(definition) ? definition.type : undefined;
  return parameterTypes.find((candidate) => candidate === type);
}

function bound(definition: Record<string, unknown>, key: string): number | undefined {
  const value = definition[key];
  return typeof value === "number" ? value : undefined;
}

/** How one value fails the definition of its parameter, or nothing where it fits. */
function valueProblem(
  definition: unknown,
  value: unknown
): "wrong_type" | "not_allowed" | undefined {
  const type = typeOf(definition);
  if (!isRecord(definition) || type === undefined) {
    return undefined;
  }
  const within = (size: number, min: string, max: string) =>
    size >= (bound(definition, min) ?? -Infinity) && size <= (bound(definition, max) ?? Infinity);
  switch (type) {
    case "string": {
      if (typeof value !== "string") return "wrong_type";
      const allowed = Array.isArray(definition.enum) ? definition.enum : undefined;
      return (allowed === undefined || allowed.includes(value)) &&
        within(value.length, "minLength", "maxLength")
        ? undefined
        : "not_allowed";
    }
    case "integer":
    case "number": {
      const fits =
        typeof value === "number" &&
        (type === "integer" ? Number.isInteger(value) : Number.isFinite(value));
      if (!fits) return "wrong_type";
      return within(value, "minimum", "maximum") ? undefined : "not_allowed";
    }
    case "boolean":
      return typeof value === "boolean" ? undefined : "wrong_type";
    case "array": {
      if (!Array.isArray(value)) return "wrong_type";
      if (value.length > (bound(definition, "maxItems") ?? Infinity)) return "not_allowed";
      return value
        .map((entry: unknown) => valueProblem(definition.items, entry))
        .find((problem) => problem !== undefined);
    }
  }
}

/**
 * The input of a test as the dialog would send it: the typed text read as JSON and held
 * against the action's schema, the part of JSON Schema an action is written in. A schema of
 * another shape checks nothing here, and the instance decides.
 */
export function readAppActionInput(
  text: string,
  schema: unknown
): { ok: true; input: Record<string, unknown> } | { ok: false; problem: AppActionInputProblem } {
  let input: unknown;
  try {
    input = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return { ok: false, problem: { kind: "not_json" } };
  }
  if (!isRecord(input)) {
    return { ok: false, problem: { kind: "not_object" } };
  }
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const required =
    isRecord(schema) && Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [];
  const missing = required.find((name) => !Object.hasOwn(input, name));
  if (missing !== undefined) {
    return { ok: false, problem: { kind: "missing", name: missing } };
  }
  for (const [name, value] of Object.entries(input)) {
    if (!Object.hasOwn(properties, name)) {
      return { ok: false, problem: { kind: "unknown", name } };
    }
    const definition = properties[name];
    const problem = valueProblem(definition, value);
    if (problem === "wrong_type") {
      return {
        ok: false,
        problem: { kind: problem, name, expected: typeOf(definition) ?? "string" }
      };
    }
    if (problem === "not_allowed") {
      return { ok: false, problem: { kind: problem, name } };
    }
  }
  return { ok: true, input };
}

const emptyValues: Record<AppActionParameterType, unknown> = {
  string: "",
  integer: 0,
  number: 0,
  boolean: false,
  array: []
};

/**
 * The text the input of a test starts with: an object with each required parameter and an
 * empty value of its type, so the builder fills in values and types no names.
 */
export function appActionInputStart(schema: unknown): string {
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const required = isRecord(schema) && Array.isArray(schema.required) ? schema.required : [];
  const start = Object.fromEntries(
    required.flatMap((name: unknown) => {
      const type = typeof name === "string" ? typeOf(properties[name]) : undefined;
      return type === undefined ? [] : [[name, emptyValues[type]]];
    })
  );
  return JSON.stringify(start, null, 2);
}

/**
 * How many characters of a result the test dialog shows. A longer one is cut here and marked:
 * the dialog is for reading what an action answers, not for holding a whole export.
 */
const APP_ACTION_RESULT_SHOWN_MAX_CHARS = 20_000;

/** What an action answered, as formatted JSON, cut at the cap. */
export function formatAppActionResult(result: unknown): {
  text: string;
  truncated: boolean;
  /** How many characters the whole result has. */
  length: number;
} {
  const whole = JSON.stringify(result ?? null, null, 2);
  return {
    text: whole.slice(0, APP_ACTION_RESULT_SHOWN_MAX_CHARS),
    truncated: whole.length > APP_ACTION_RESULT_SHOWN_MAX_CHARS,
    length: whole.length
  };
}

/** How a test ended, as the dialog shows it. */
export type AppActionTestOutcome =
  | { status: "done"; runId: string; result: unknown }
  | { status: "pending_approval"; runId: string }
  /** The draft carried nothing out: `message` says what it would have done, with `input`. */
  | { status: "dry_run"; message: string; input: unknown; runId?: never }
  | {
      /** `denied` is a refusal for a right or by the policy; everything else failed. */
      status: "denied" | "failed";
      /**
       * The sentence of the instance, or the interface's own for a missing right to use a
       * Connection. Absent where the call never reached the instance.
       */
      message?: string;
      runId?: string;
    };

/**
 * The colour of each way a test ends. A refusal is red here, where the builder just asked
 * and did not get: the list of runs in Instance > Operations shows the same refusal quietly,
 * as a call that is over and needs nobody.
 */
export const appActionTestTones: Record<AppActionTestOutcome["status"], BadgeTone> = {
  done: "success",
  pending_approval: "warning",
  dry_run: "info",
  denied: "danger",
  failed: "danger"
};

/** The codes of a refused call. Every other code is a failure. */
const REFUSAL_CODES: readonly string[] = ["forbidden", "policy_denied", "guardrail_blocked"];

/** The outcome of a call the frame call client answered. */
export function appActionTestOutcome(
  answer:
    | {
        ok: true;
        result:
          | { runId: string; status: "done" | "pending_approval"; result?: unknown }
          | { status: "dry_run"; message: string; result: unknown };
      }
    | { ok: false; error: { code: string; message: string; runId?: string } }
): AppActionTestOutcome {
  if (answer.ok) {
    const { result } = answer;
    switch (result.status) {
      case "dry_run":
        return { status: "dry_run", message: result.message, input: result.result };
      case "done":
        return { status: "done", runId: result.runId, result: result.result };
      case "pending_approval":
        return { status: "pending_approval", runId: result.runId };
    }
  }
  const { code, message, runId } = answer.error;
  return {
    status: REFUSAL_CODES.includes(code) ? "denied" : "failed",
    // `failed` is the client's own word for a call that got no answer of the instance.
    ...(code === "failed" ? {} : { message }),
    ...(runId === undefined ? {} : { runId })
  };
}

/**
 * How long a test dialog uses one address of the draft's frame: the lifetime of its token
 * less the margin a mounted preview renews with. A dialog left open over that asks again.
 */
const TEST_FRAME_SERVES_MS = PAGE_ADDRESS_LIFETIME_MS - PAGE_ADDRESS_RENEWAL_MARGIN_MS;

/**
 * What a test dialog calls through, made from one address of the draft's frame and kept
 * while that address serves. Asked after the address expired, it asks for a new one, so a
 * dialog that stayed open for an hour still tests. The time is this device's alone, counted
 * from the asking, as a mounted preview counts it.
 */
export function keptWhileItServes<Frame>(
  ask: () => Promise<Frame>,
  now: () => number = Date.now
): () => Promise<Frame> {
  let held: { frame: Frame; servesUntil: number } | undefined;
  return async () => {
    const askedAt = now();
    if (!held || askedAt >= held.servesUntil) {
      held = { frame: await ask(), servesUntil: askedAt + TEST_FRAME_SERVES_MS };
    }
    return held.frame;
  };
}
