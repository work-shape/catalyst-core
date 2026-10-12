import { createHash } from "node:crypto";
import {
  WORKFLOW_STEP_TYPES,
  type JsonValue,
  type WorkflowManifest,
  type WorkflowStep,
  type WorkflowStepType
} from "@vivd-catalyst/core";
import { JSON_SCHEMA, YAMLException, load } from "js-yaml";
import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "./json";
import {
  WORKFLOW_DEFINITION_MAX_STEPS,
  WORKFLOW_LOOP_MAX_DEPTH,
  WORKFLOW_MANIFEST_MAX_BYTES
} from "./limits";

// `workflow.yaml` as a definition the engine runs: its shape, and what must hold between its
// steps before a run is started from it. Nothing here reads a file or a store.

/** The step types this release executes. A definition that names another is not accepted. */
export const WORKFLOW_EXECUTED_STEP_TYPES = [
  "trigger",
  "operation",
  "loop",
  "output"
] as const satisfies readonly WorkflowStepType[];

/** One thing that keeps a definition from being run: where it is, and a sentence to show. */
export interface WorkflowDefinitionIssue {
  path: string;
  message: string;
}

export type WorkflowDefinitionResult =
  { ok: true; manifest: WorkflowManifest } | { ok: false; issues: WorkflowDefinitionIssue[] };

/** The id of a Workflow: part of `workflow.<id>.start`, so it holds no dot. */
const WORKFLOW_ID = /^[a-z][a-z0-9_-]{0,62}$/u;
/** The id of a step: part of a step run's key, which separates with `.` and `[`. */
const STEP_ID = /^[a-z][a-z0-9_-]{0,62}$/u;

const referenceSchema = z.strictObject({ step: z.string().min(1), path: z.string() });
const inputMappingSchema = z.record(
  z.string().min(1),
  z.union([z.strictObject({ value: jsonValueSchema }), z.strictObject({ ref: referenceSchema })])
);
const stepId = z.string().regex(STEP_ID, "A step id is lowercase letters, digits, '_' and '-'");

/** What every step carries: its id, and what a person calls it and reads about it. */
const named = { id: stepId, name: z.string().min(1), description: z.string().optional() };

const stepSchema: z.ZodType<WorkflowStep> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({
      ...named,
      type: z.literal("trigger"),
      triggers: z
        .array(
          z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("manual") }),
            z.strictObject({ kind: z.literal("schedule"), cron: z.string().min(1) })
          ])
        )
        .min(1)
    }),
    z.strictObject({
      ...named,
      type: z.literal("operation"),
      operation: z.string().min(1),
      input: inputMappingSchema
    }),
    z.strictObject({
      ...named,
      type: z.literal("loop"),
      items: referenceSchema,
      itemName: z.string().min(1).optional(),
      itemLabel: z.string().min(1).optional(),
      steps: z.array(stepSchema).min(1)
    }),
    z.strictObject({ ...named, type: z.literal("output"), input: inputMappingSchema })
  ])
);

const manifestSchema = z.strictObject({
  id: z.string().regex(WORKFLOW_ID, "A Workflow id is lowercase letters, digits, '_' and '-'"),
  name: z.string().min(1),
  description: z.string().optional(),
  runAs: z.string().min(1),
  inputs: jsonObjectSchema,
  outputs: jsonObjectSchema,
  tools: z.array(z.string().min(1)).optional(),
  steps: z.array(stepSchema).min(1),
  wiring: z.array(z.strictObject({ from: z.string().min(1), to: z.string().min(1) }))
});

/** The steps of a definition that this release does not execute, wherever they are nested. */
function unexecutedSteps(value: unknown, path: string): WorkflowDefinitionIssue[] {
  const steps = z.array(z.looseObject({ type: z.string() })).safeParse(value);
  if (!steps.success) return [];
  return steps.data.flatMap((step, index) => {
    const at = `${path}[${index}]`;
    const known = WORKFLOW_STEP_TYPES.some((type) => type === step.type);
    const executed = WORKFLOW_EXECUTED_STEP_TYPES.some((type) => type === step.type);
    const own =
      known && !executed
        ? [
            {
              path: `${at}.type`,
              message: `This release does not execute a step of the type '${step.type}'`
            }
          ]
        : [];
    return [...own, ...unexecutedSteps(step.steps, `${at}.steps`)];
  });
}

/**
 * One sequence of a definition in the order it runs: the steps at the top, or the steps of
 * one loop. `loop` is the id of that loop, and `parent` the sequence the loop is a step of.
 */
interface WorkflowSequence {
  loop?: string;
  parent?: WorkflowSequence;
  steps: readonly WorkflowStep[];
}

/** Where each step of a definition is: its sequence and its place in it. */
export type WorkflowStepIndex = ReadonlyMap<
  string,
  { step: WorkflowStep; sequence: WorkflowSequence; position: number }
>;

/**
 * The order of one sequence. Without a wire between two of its steps it runs as written.
 * With wires, they must chain every step of the sequence once; the order is then the chain.
 */
function orderOf(
  steps: readonly WorkflowStep[],
  wiring: WorkflowManifest["wiring"]
): readonly WorkflowStep[] | undefined {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const wires = wiring.filter((wire) => byId.has(wire.from) && byId.has(wire.to));
  if (wires.length === 0) return steps;
  const next = new Map(wires.map((wire) => [wire.from, wire.to]));
  const targets = new Set(wires.map((wire) => wire.to));
  if (wires.length !== steps.length - 1 || next.size !== wires.length) return undefined;
  if (targets.size !== wires.length) return undefined;
  const first = steps.filter((step) => !targets.has(step.id));
  const start = first[0];
  if (first.length !== 1 || !start) return undefined;
  const ordered: WorkflowStep[] = [];
  for (let step: WorkflowStep | undefined = start; step;) {
    ordered.push(step);
    if (ordered.length > steps.length) return undefined;
    const following: string | undefined = next.get(step.id);
    step = following === undefined ? undefined : byId.get(following);
  }
  return ordered.length === steps.length ? ordered : undefined;
}

/**
 * The steps of a checked definition by their ids, each with its sequence in running order.
 * A definition that passed `parseWorkflowManifest` always has one.
 */
export function indexWorkflowSteps(manifest: WorkflowManifest): WorkflowStepIndex {
  const index = new Map<
    string,
    { step: WorkflowStep; sequence: WorkflowSequence; position: number }
  >();
  const visit = (steps: readonly WorkflowStep[], loop?: string, parent?: WorkflowSequence) => {
    const sequence: WorkflowSequence = {
      ...(loop === undefined ? {} : { loop }),
      ...(parent === undefined ? {} : { parent }),
      steps: orderOf(steps, manifest.wiring) ?? steps
    };
    sequence.steps.forEach((step, position) => {
      index.set(step.id, { step, sequence, position });
      if (step.type === "loop") visit(step.steps, step.id, sequence);
    });
  };
  visit(manifest.steps);
  return index;
}

/** What must hold between the steps of a definition whose shape is right. */
function structuralIssues(manifest: WorkflowManifest): WorkflowDefinitionIssue[] {
  const issues: WorkflowDefinitionIssue[] = [];
  const seen = new Set<string>();
  let count = 0;
  const walk = (steps: readonly WorkflowStep[], path: string, depth: number) => {
    if (orderOf(steps, manifest.wiring) === undefined) {
      issues.push({
        path: "wiring",
        message: `The wires between the steps of '${path}' do not chain each of them once`
      });
    }
    steps.forEach((step, position) => {
      const at = `${path}[${position}]`;
      count += 1;
      if (seen.has(step.id)) {
        issues.push({ path: `${at}.id`, message: `The step id '${step.id}' is used twice` });
      }
      seen.add(step.id);
      if (depth > 0 && (step.type === "trigger" || step.type === "output")) {
        issues.push({
          path: at,
          message: `A '${step.type}' step stands at the top, not in a loop`
        });
      }
      if (step.type === "loop") {
        if (depth >= WORKFLOW_LOOP_MAX_DEPTH) {
          issues.push({
            path: at,
            message: `Loops are nested at most ${WORKFLOW_LOOP_MAX_DEPTH} deep`
          });
          return;
        }
        walk(step.steps, `${at}.steps`, depth + 1);
      }
    });
  };
  walk(manifest.steps, "steps", 0);
  if (count > WORKFLOW_DEFINITION_MAX_STEPS) {
    issues.push({
      path: "steps",
      message: `A definition holds at most ${WORKFLOW_DEFINITION_MAX_STEPS} steps`
    });
  }
  if (issues.length > 0) return issues;

  const top = orderOf(manifest.steps, manifest.wiring) ?? manifest.steps;
  top.forEach((step, position) => {
    const first = position === 0;
    const last = position === top.length - 1;
    if ((step.type === "trigger") !== first) {
      issues.push({ path: "steps", message: "The one trigger step is the first step" });
    }
    if ((step.type === "output") !== last) {
      issues.push({ path: "steps", message: "The one output step is the last step" });
    }
  });
  const known = new Set(seen);
  for (const wire of manifest.wiring) {
    if (!known.has(wire.from) || !known.has(wire.to)) {
      issues.push({ path: "wiring", message: `A wire names a step that does not exist` });
      continue;
    }
    const index = indexWorkflowSteps(manifest);
    if (index.get(wire.from)?.sequence !== index.get(wire.to)?.sequence) {
      issues.push({
        path: "wiring",
        message: `The wire from '${wire.from}' to '${wire.to}' leaves its sequence`
      });
    }
  }
  if (issues.length > 0) return issues;

  // A reference names a step that ended before the one that reads it, or a loop around it.
  const index = indexWorkflowSteps(manifest);
  for (const [id, { step, sequence, position }] of index) {
    const references =
      step.type === "loop"
        ? [step.items]
        : step.type === "trigger"
          ? []
          : Object.values(step.input).flatMap((value) => ("ref" in value ? [value.ref] : []));
    for (const reference of references) {
      if (!isReachable(reference.step, sequence, position)) {
        issues.push({
          path: `steps.${id}`,
          message: `The step '${id}' refers to '${reference.step}', which has not run before it`
        });
      }
    }
  }
  return issues;
}

function isReachable(target: string, sequence: WorkflowSequence, position: number): boolean {
  if (sequence.steps.slice(0, position).some((step) => step.id === target)) return true;
  if (sequence.loop === undefined || sequence.parent === undefined) return false;
  if (sequence.loop === target) return true;
  const loopAt = sequence.parent.steps.findIndex((step) => step.id === sequence.loop);
  return isReachable(target, sequence.parent, loopAt);
}

/** Checks a value read from `workflow.yaml`. Answers the definition, or every issue found. */
export function parseWorkflowManifest(value: unknown): WorkflowDefinitionResult {
  const unexecuted = unexecutedSteps(z.looseObject({}).safeParse(value).data?.steps, "steps");
  if (unexecuted.length > 0) return { ok: false, issues: unexecuted };
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    };
  }
  const issues = structuralIssues(parsed.data);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, manifest: parsed.data };
}

/** Reads the text of `workflow.yaml` as data: the YAML schema used knows JSON types only. */
export function readWorkflowManifest(text: string): WorkflowDefinitionResult {
  if (Buffer.byteLength(text, "utf8") > WORKFLOW_MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      issues: [
        { path: "", message: `workflow.yaml is larger than ${WORKFLOW_MANIFEST_MAX_BYTES} bytes` }
      ]
    };
  }
  try {
    return parseWorkflowManifest(load(text, { schema: JSON_SCHEMA }));
  } catch (error) {
    if (!(error instanceof YAMLException)) throw error;
    return { ok: false, issues: [{ path: "", message: "workflow.yaml is not valid YAML" }] };
  }
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .flatMap((key) => {
        const field = value[key];
        return field === undefined ? [] : [[key, canonical(field)]];
      })
  );
}

/**
 * The fingerprint of a definition: the same for the same content, whatever the order of its
 * keys. A run keeps it as its revision until Workflows are stored as assets with revisions.
 */
export function workflowManifestFingerprint(manifest: WorkflowManifest): string {
  const content = canonical(jsonValueSchema.parse(manifest));
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
