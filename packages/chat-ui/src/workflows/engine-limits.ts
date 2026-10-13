import { ApiError } from "@vivd-catalyst/api-client";
import type { WorkflowStepKind, WorkflowUnsupported } from "./workflow-views";

// What the engine of an instance runs today, as far as a page can tell before a start is
// asked for. The contract has no read that says it, so the list below follows the engine by
// hand; the start is the authority, and what it refuses is read by `startRefusal`.

/** The kinds of step the engine runs. Every other kind is drawn and refused at the start. */
const RUN_STEP_KINDS: readonly WorkflowStepKind[] = ["trigger", "operation", "loop", "output"];

/** The fields of a definition, and of an operation step, the engine does not read yet. */
const UNREAD_FIELDS = ["labels", "onFailure", "retention", "types"] as const;
const UNREAD_STEP_FIELDS = ["dataset", "paginate"] as const;

/** The code the engine gives what a definition holds and it does not run. */
const NOT_SUPPORTED_YET = "not_supported_yet";
/** The reason the engine gives a start of a Workflow that no person starts. */
const NO_MANUAL_TRIGGER = "no_manual_trigger";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function nameOf(step: Record<string, unknown>): string {
  const name = typeof step.name === "string" ? step.name.trim() : "";
  return name !== "" ? name : typeof step.id === "string" ? step.id : "";
}

/**
 * What the engine does not run of a definition, in the order a reader meets it: the kinds of
 * step, the starts, the loops and the fields. Empty for a definition the engine runs.
 */
export function unsupportedByEngine(definition: Record<string, unknown>): WorkflowUnsupported[] {
  const steps: string[] = [];
  const collect: string[] = [];
  const concurrency: string[] = [];
  const fields = new Set<string>(UNREAD_FIELDS.filter((field) => definition[field] !== undefined));
  let schedule = false;
  let otherStart = false;

  const walk = (list: unknown) => {
    for (const step of records(list)) {
      const kind = typeof step.type === "string" ? step.type : "";
      if (!RUN_STEP_KINDS.some((run) => run === kind)) {
        steps.push(nameOf(step));
      }
      if (kind === "trigger") {
        for (const trigger of records(step.triggers)) {
          schedule ||= trigger.kind === "schedule";
          otherStart ||= trigger.kind !== "schedule" && trigger.kind !== "manual";
        }
      }
      if (kind === "operation") {
        for (const field of UNREAD_STEP_FIELDS) {
          if (step[field] !== undefined) {
            fields.add(field);
          }
        }
      }
      if (kind === "loop") {
        if (step.collect !== undefined) {
          collect.push(nameOf(step));
        }
        if (typeof step.concurrency === "number" && step.concurrency !== 1) {
          concurrency.push(nameOf(step));
        }
      }
      // What a block holds is refused with it, and a reader is told of each step.
      walk(step.steps);
      walk(step.then);
      walk(step.else);
      for (const branch of records(step.branches)) {
        walk(branch.steps);
      }
    }
  };
  walk(definition.steps);

  const found: WorkflowUnsupported[] = [];
  const add = (what: WorkflowUnsupported["what"], names: readonly string[], present = true) => {
    if (present && (names.length > 0 || what === "schedule" || what === "trigger")) {
      found.push({ what, names });
    }
  };
  add("steps", steps);
  add("schedule", [], schedule);
  add("trigger", [], otherStart);
  add("collect", collect);
  add("concurrency", concurrency);
  add("fields", [...fields]);
  return found;
}

/** Why the instance refused a start, where the page has a sentence of its own for it. */
export interface WorkflowStartRefusal {
  why: "notSupported" | "notByHand";
  /** What the instance said is wrong with the definition, in its own words. */
  issues: readonly string[];
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/**
 * Reads a refused start: a definition that holds what the engine does not run yet, with every
 * issue the instance names, or a Workflow that is not started by hand.
 */
export function startRefusal(error: unknown): WorkflowStartRefusal | undefined {
  if (!(error instanceof ApiError)) {
    return undefined;
  }
  const details = field(field(error.payload, "error"), "details");
  if (field(details, "reason") === NOT_SUPPORTED_YET) {
    const issues = field(details, "issues");
    return {
      why: "notSupported",
      issues: (Array.isArray(issues) ? issues : []).flatMap((issue: unknown) => {
        const message = field(issue, "message");
        return field(issue, "code") === NOT_SUPPORTED_YET && typeof message === "string"
          ? [message]
          : [];
      })
    };
  }
  return field(details, "reason") === NO_MANUAL_TRIGGER
    ? { why: "notByHand", issues: [] }
    : undefined;
}
