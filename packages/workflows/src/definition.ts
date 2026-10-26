import {
  AGENTS_RUN_OPERATION,
  RUN_AGENT_TOOL_NAME,
  WORKFLOW_KINDS,
  WORKFLOW_DATASET_KEY,
  WORKFLOW_FILE_KEY,
  WORKFLOW_EXECUTED_STEP_TYPES,
  WORKFLOW_START_KEY_INPUT,
  WORKFLOW_STEP_TYPES,
  readYamlData,
  workflowBlockIssues,
  workflowLimitsSchema,
  workflowLiteralOrReferenceSchema,
  workflowOnFailureSchema,
  workflowRetentionSchema,
  type JsonValue,
  type WorkflowManifest,
  type WorkflowReference,
  type WorkflowStep
} from "@work-shape/catalyst-core";
import { createHash } from "node:crypto";
import { z } from "zod";
import { workflowValueSchema } from "./dataset-schema";
import { sourceReferences } from "./text-join";
import {
  holdsBrokenDatasetReference,
  holdsFileKey,
  jsonObjectSchema,
  jsonValueSchema
} from "./json";
import { stepStructuralIssues, stepUnsupportedIssues, workflowStepSchema } from "./steps";
import { notSupported } from "./steps/module";
import type { WorkflowDefinitionIssue } from "./definition-issue";
import {
  WORKFLOW_DATASET_MAX_BYTES,
  WORKFLOW_DEFINITION_MAX_STEPS,
  WORKFLOW_MANIFEST_MAX_BYTES,
  WORKFLOW_MANIFEST_MAX_NESTING
} from "./limits";

export { WORKFLOW_LIMIT_ABOVE_CEILING, type WorkflowDefinitionIssue } from "./definition-issue";

// `workflow.yaml` as a definition the engine runs: its shape, and what must hold between its
// steps before a run is started from it. Nothing here reads a file or a store. Saving a
// definition, publishing one and starting a run all ask `parseWorkflowManifest`.

export type WorkflowDefinitionResult =
  { ok: true; manifest: WorkflowManifest } | { ok: false; issues: WorkflowDefinitionIssue[] };

/** The id of a Workflow: part of `workflow.<id>.start`, so it holds no dot. */
const WORKFLOW_ID = /^[a-z][a-z0-9_-]{0,62}$/u;

// Strict, so a file that carries a `wiring`, an edge or a position is refused: the steps run
// in the order of the list and a block holds its own.
const manifestSchema = z.strictObject({
  id: z.string().regex(WORKFLOW_ID, "A Workflow id is lowercase letters, digits, '_' and '-'"),
  name: z.string().min(1),
  description: z.string().optional(),
  runAs: z.string().min(1).optional(),
  kind: z.enum(WORKFLOW_KINDS).optional(),
  inputs: jsonObjectSchema,
  outputs: jsonObjectSchema,
  labels: z.record(z.string().min(1), workflowLiteralOrReferenceSchema).optional(),
  onFailure: workflowOnFailureSchema.optional(),
  retention: workflowRetentionSchema.optional(),
  limits: workflowLimitsSchema.optional(),
  types: z.record(z.string().min(1), jsonObjectSchema).optional(),
  tools: z.array(z.string().min(1)).optional(),
  packages: z.array(z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u)).optional(),
  steps: z.array(workflowStepSchema).min(1)
});

/**
 * What the file form holds and this engine does not run, each by the name of its field. The
 * reserved blocks `condition` and `parallel` are not named here: `workflowBlockIssues` refuses
 * them, and what they hold is not read.
 */
function unsupportedIssues(manifest: WorkflowManifest): WorkflowDefinitionIssue[] {
  const issues: WorkflowDefinitionIssue[] = [];
  if (manifest.onFailure !== undefined && manifest.onFailure !== "notify") {
    issues.push(notSupported("onFailure", "onFailure: workflow.<id> (EW-13 failure Workflow)"));
  }
  // The dataset-byte raise remains reserved; paging minutes use the operator ceiling.
  const { datasetBytes } = manifest.limits ?? {};
  if (datasetBytes !== undefined && datasetBytes > WORKFLOW_DATASET_MAX_BYTES) {
    issues.push(notSupported("limits.datasetBytes", "datasets above their default size"));
  }
  const known: readonly string[] = WORKFLOW_STEP_TYPES;
  const executed: readonly string[] = WORKFLOW_EXECUTED_STEP_TYPES;
  const walk = (steps: readonly WorkflowStep[], path: string) => {
    steps.forEach((step, position) => {
      const at = `${path}[${position}]`;
      if (known.includes(step.type) && !executed.includes(step.type)) {
        issues.push(notSupported(`${at}.type`, `a step of the type '${step.type}'`));
      }
      issues.push(...stepUnsupportedIssues(step, at));
      if (step.type === "loop") {
        walk(step.steps, `${at}.steps`);
      }
    });
  };
  walk(manifest.steps, "steps");
  return issues;
}

/**
 * One list of a definition in the order it runs: the steps at the top, or the steps of one
 * loop. `loop` is the id of that loop, and `parent` the list the loop is a step of.
 */
interface WorkflowSequence {
  loop?: string;
  parent?: WorkflowSequence;
  steps: readonly WorkflowStep[];
}

/** Where each step of a definition is: its list and its place in it. */
export type WorkflowStepIndex = ReadonlyMap<
  string,
  { step: WorkflowStep; sequence: WorkflowSequence; position: number }
>;

/**
 * The steps of a definition by their ids, each with the list it runs in. What a reserved
 * block holds is not in it: the engine runs no step of one.
 */
export function indexWorkflowSteps(manifest: Pick<WorkflowManifest, "steps">): WorkflowStepIndex {
  const index = new Map<
    string,
    { step: WorkflowStep; sequence: WorkflowSequence; position: number }
  >();
  const visit = (steps: readonly WorkflowStep[], loop?: string, parent?: WorkflowSequence) => {
    const sequence: WorkflowSequence = {
      ...(loop === undefined ? {} : { loop }),
      ...(parent === undefined ? {} : { parent }),
      steps
    };
    steps.forEach((step, position) => {
      index.set(step.id, { step, sequence, position });
      if (step.type === "loop") visit(step.steps, step.id, sequence);
    });
  };
  visit(manifest.steps);
  return index;
}

/**
 * Non-loop steps needed after a loop, at every enclosing level. The next loop reserves
 * its own work; a cursor source need not know whether this is its last item.
 */
export function workflowLoopTailSteps(index: WorkflowStepIndex, loopId: string): number {
  let current = index.get(loopId);
  let total = 0;
  while (current) {
    for (const step of current.sequence.steps.slice(current.position + 1)) {
      if (step.type === "loop") break;
      total++;
    }
    current = current.sequence.loop ? index.get(current.sequence.loop) : undefined;
  }
  return total;
}

/** The schema's properties that are named like a key that marks a dataset or a file in step data. */
function datasetKeyIssues(manifest: WorkflowManifest): WorkflowDefinitionIssue[] {
  const properties = z.object({ properties: z.record(z.string(), z.unknown()) });
  const issues: WorkflowDefinitionIssue[] = (["inputs", "outputs"] as const).flatMap((field) => {
    const read = properties.safeParse(manifest[field]);
    if (!read.success) return [];
    return [WORKFLOW_DATASET_KEY, WORKFLOW_FILE_KEY]
      .filter((key) => Object.hasOwn(read.data.properties, key))
      .map((key) => ({ path: field, message: `No field of '${field}' is named '${key}'` }));
  });
  // The start takes the run key beside the inputs under this name, so no input has it.
  const inputs = properties.safeParse(manifest.inputs);
  if (inputs.success && Object.hasOwn(inputs.data.properties, WORKFLOW_START_KEY_INPUT)) {
    issues.push({
      path: `inputs.properties.${WORKFLOW_START_KEY_INPUT}`,
      message: `No input is named '${WORKFLOW_START_KEY_INPUT}': a start takes the run key under that name`
    });
  }
  return issues;
}

/**
 * What must hold between the steps of a definition beside what `workflowBlockIssues` checks:
 * how many there are, where the trigger and the output stand, and that a reference names a
 * step that exists.
 */
function structuralIssues(manifest: WorkflowManifest): WorkflowDefinitionIssue[] {
  const issues: WorkflowDefinitionIssue[] = [];
  const index = indexWorkflowSteps(manifest);
  if (index.size > WORKFLOW_DEFINITION_MAX_STEPS) {
    issues.push({
      path: "steps",
      message: `A definition holds at most ${WORKFLOW_DEFINITION_MAX_STEPS} steps`
    });
  }
  manifest.steps.forEach((step, position) => {
    if ((step.type === "trigger") !== (position === 0)) {
      issues.push({ path: "steps", message: "The one trigger step is the first step" });
    }
    if ((step.type === "output") !== (position === manifest.steps.length - 1)) {
      issues.push({ path: "steps", message: "The one output step is the last step" });
    }
  });
  // A Workflow step's agent never starts a subagent (CR-2).
  if (
    [...index.values()].some(({ step }) => step.type === "agent") &&
    manifest.tools?.some((tool) => tool === RUN_AGENT_TOOL_NAME || tool === AGENTS_RUN_OPERATION)
  ) {
    issues.push({ path: "tools", message: "An agent step cannot start subagents" });
  }
  for (const [id, { step, sequence }] of index) {
    issues.push(...stepStructuralIssues(step, id));
    if (sequence.loop !== undefined && (step.type === "trigger" || step.type === "output")) {
      issues.push({
        path: `steps.${id}`,
        message: `A '${step.type}' step stands at the top, not in a loop`
      });
    }
    const mapped =
      step.type === "notify"
        ? Object.entries({ title: step.title, text: step.text })
        : "input" in step
          ? Object.entries(step.input)
          : [];
    for (const [field, source] of mapped) {
      // A literal is no dataset, so it never carries the key that marks one.
      if (source.value !== undefined && holdsBrokenDatasetReference(source.value)) {
        issues.push({
          path: `steps.${id}.input.${field}`,
          message: `The literal of '${field}' holds '${WORKFLOW_DATASET_KEY}' and is no reference to a dataset`
        });
      }
      // A file belongs to one run, so no definition names one.
      if (source.value !== undefined && holdsFileKey(source.value)) {
        issues.push({
          path: `steps.${id}.input.${field}`,
          message: `The literal of '${field}' holds '${WORKFLOW_FILE_KEY}': a file of a run comes from a step, never from the definition`
        });
      }
    }
    if (step.type === "workflow" && Object.hasOwn(step.input, WORKFLOW_START_KEY_INPUT)) {
      issues.push({
        path: `steps.${id}.input.${WORKFLOW_START_KEY_INPUT}`,
        message: `The child's run key is set with the step's 'key', not as an input`
      });
    }
    const keyParts = step.type === "workflow" ? (step.key ?? []) : [];
    const references: { ref: WorkflowReference; field?: string; part?: number }[] =
      step.type === "loop"
        ? [{ ref: step.items }]
        : [
            ...mapped.flatMap(([field, source]) =>
              sourceReferences(source).map((found) => ({ ...found, field }))
            ),
            ...keyParts.flatMap((source) => (source.ref ? [{ ref: source.ref }] : []))
          ];
    for (const { ref: reference, field, part } of references) {
      if (index.has(reference.step)) continue;
      // A part of a text is named by its field and its number, so the author finds it.
      issues.push(
        part === undefined
          ? {
              path: `steps.${id}`,
              message: `The step '${id}' refers to '${reference.step}', and no step has that id`
            }
          : {
              path: `steps.${id}.input.${field}.text.${part - 1}`,
              message: `Part ${part} of '${field}' of the step '${id}' refers to '${reference.step}', and no step has that id`
            }
      );
    }
  }
  return [...issues, ...datasetKeyIssues(manifest)];
}

/** Whether no value of a file is nested deeper than `WORKFLOW_MANIFEST_MAX_NESTING`. */
function withinNesting(value: unknown): boolean {
  // A list of what is left to look at, so the check itself needs no stack.
  const open: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  for (let next = open.pop(); next !== undefined; next = open.pop()) {
    if (typeof next.value !== "object" || next.value === null) continue;
    if (next.depth >= WORKFLOW_MANIFEST_MAX_NESTING) return false;
    for (const child of Object.values(next.value)) {
      open.push({ value: child, depth: next.depth + 1 });
    }
  }
  return true;
}

/**
 * Checks a value read from `workflow.yaml`. Answers the definition, or every issue found: of
 * its shape first, then what the contract's block check refuses (`block_depth`,
 * `reference_out_of_scope`, `duplicate_step_id`, `not_supported_yet`), then what this engine
 * does not run and what else must hold between the steps, among it a step that names an
 * operation no step may call (`operation_not_callable`).
 */
export function parseWorkflowManifest(value: unknown): WorkflowDefinitionResult {
  // Before anything reads the value by recursion: the schema and the checks below follow a
  // file as deep as it goes, and a file deeper than the stack would end the process.
  if (!withinNesting(value)) {
    return {
      ok: false,
      issues: [
        {
          path: "",
          message: `workflow.yaml is nested deeper than ${WORKFLOW_MANIFEST_MAX_NESTING} levels`
        }
      ]
    };
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.join(".");
        // A step type the file form does not hold is one no release runs yet.
        return issue.code === "invalid_union" && issue.path.at(-1) === "type"
          ? notSupported(path, "a step of this type")
          : { path, message: issue.message };
      })
    };
  }
  const blocks = workflowBlockIssues(parsed.data.steps).map(
    ({ code, step, message }): WorkflowDefinitionIssue => ({ path: `steps.${step}`, code, message })
  );
  const unsupported = unsupportedIssues(parsed.data);
  if (blocks.length > 0 || unsupported.length > 0) {
    return { ok: false, issues: [...blocks, ...unsupported] };
  }
  const issues = structuralIssues(parsed.data);
  try {
    workflowValueSchema(parsed.data.inputs, parsed.data.types);
    workflowValueSchema(parsed.data.outputs, parsed.data.types);
    for (const row of Object.values(parsed.data.types ?? {}))
      workflowValueSchema({ type: "dataset", row }, parsed.data.types);
  } catch {
    issues.push({
      path: "types",
      message: "A dataset row schema cannot be checked or names no declared type"
    });
  }
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
  const read = readYamlData(text, "workflow.yaml", { refuseAliases: true });
  return read.ok
    ? parseWorkflowManifest(read.value)
    : { ok: false, issues: [{ path: "", message: read.issue.message }] };
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
 * keys. A source that stores no revisions names a revision by it.
 */
export function workflowManifestFingerprint(manifest: WorkflowManifest): string {
  const content = canonical(jsonValueSchema.parse(manifest));
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
