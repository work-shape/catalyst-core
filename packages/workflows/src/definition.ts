import { createHash } from "node:crypto";
import {
  WORKFLOW_DATASET_KEY,
  WORKFLOW_ERROR_CODES,
  WORKFLOW_STEP_TYPES,
  readYamlData,
  workflowBlockIssues,
  workflowInputValueSchema,
  workflowLoopOptionsSchema,
  workflowOnFailureSchema,
  workflowPaginateSchema,
  workflowRetentionSchema,
  workflowScheduleOptionsSchema,
  workflowStepDatasetSchema,
  type JsonValue,
  type WorkflowBlockIssue,
  type WorkflowManifest,
  type WorkflowStep,
  type WorkflowStepType
} from "@vivd-catalyst/core";
import { z } from "zod";
import { codeFileIssue } from "./code-step";
import { parseCron } from "./cron";
import {
  holdsBrokenDatasetReference,
  jsonObjectSchema,
  jsonValueSchema,
  namesDatasetType
} from "./json";
import {
  WORKFLOW_DEFINITION_MAX_STEPS,
  WORKFLOW_MANIFEST_MAX_BYTES,
  WORKFLOW_MANIFEST_MAX_NESTING
} from "./limits";

// `workflow.yaml` as a definition the engine runs: its shape, and what must hold between its
// steps before a run is started from it. Nothing here reads a file or a store. Saving a
// definition, publishing one and starting a run all ask `parseWorkflowManifest`.

/** The step types this release executes. A definition that names another is not accepted. */
export const WORKFLOW_EXECUTED_STEP_TYPES = [
  "trigger",
  "operation",
  "loop",
  "code",
  "output"
] as const satisfies readonly WorkflowStepType[];

/**
 * One thing that keeps a definition from being run: where it is, and a sentence to show. An
 * issue the contract names carries its code: what `workflowBlockIssues` refuses, and
 * `not_supported_yet` for what the file form holds and this engine does not run.
 */
export interface WorkflowDefinitionIssue {
  path: string;
  message: string;
  code?: WorkflowBlockIssue["code"];
}

export type WorkflowDefinitionResult =
  { ok: true; manifest: WorkflowManifest } | { ok: false; issues: WorkflowDefinitionIssue[] };

/** The id of a Workflow: part of `workflow.<id>.start`, so it holds no dot. */
const WORKFLOW_ID = /^[a-z][a-z0-9_-]{0,62}$/u;
/** The id of a step: part of a step run's key, which separates with `.` and `[`. */
const STEP_ID = /^[a-z][a-z0-9_-]{0,62}$/u;

const referenceSchema = z.strictObject({ step: z.string().min(1), path: z.string() });
const inputMappingSchema = z.record(z.string().min(1), workflowInputValueSchema);
const stepId = z.string().regex(STEP_ID, "A step id is lowercase letters, digits, '_' and '-'");

/** What every step carries: its id, and what a person calls it and reads about it. */
const named = { id: stepId, name: z.string().min(1), description: z.string().optional() };
const declared = { inputSchema: jsonObjectSchema, outputSchema: jsonObjectSchema };

// Every step the file form holds, the reserved blocks among them, so that a file written for
// a later engine is read here and refused by name instead of as a file nobody understands.
const stepSchema: z.ZodType<WorkflowStep> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({
      ...named,
      type: z.literal("trigger"),
      triggers: z
        .array(
          z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("manual") }),
            z.strictObject({
              kind: z.literal("schedule"),
              cron: z.string().min(1),
              ...workflowScheduleOptionsSchema.shape
            }),
            z.strictObject({ kind: z.literal("parent") })
          ])
        )
        .min(1)
    }),
    z.strictObject({
      ...named,
      type: z.literal("operation"),
      operation: z.string().min(1),
      input: inputMappingSchema,
      dataset: workflowStepDatasetSchema.optional(),
      paginate: workflowPaginateSchema.optional()
    }),
    z.strictObject({
      ...named,
      type: z.literal("workflow"),
      workflow: z.string().min(1),
      input: inputMappingSchema,
      key: z.array(workflowInputValueSchema).optional()
    }),
    z.strictObject({
      ...named,
      type: z.literal("loop"),
      items: referenceSchema,
      itemName: z.string().min(1).optional(),
      itemLabel: z.string().min(1).optional(),
      ...workflowLoopOptionsSchema.shape,
      steps: z.array(stepSchema).min(1)
    }),
    z.strictObject({
      ...named,
      ...declared,
      type: z.literal("code"),
      file: z.string().min(1),
      input: inputMappingSchema
    }),
    z.strictObject({ ...named, type: z.literal("output"), input: inputMappingSchema }),
    z.strictObject({
      ...named,
      ...declared,
      type: z.literal("agent"),
      instructions: z.string().min(1),
      input: inputMappingSchema
    }),
    z.strictObject({
      ...named,
      type: z.literal("notify"),
      channel: z.enum(["inbox", "mail"]),
      input: inputMappingSchema
    }),
    z.strictObject({
      ...named,
      type: z.literal("condition"),
      when: z.strictObject({ ref: referenceSchema, op: z.string().min(1), value: jsonValueSchema }),
      then: z.array(stepSchema),
      else: z.array(stepSchema).optional()
    }),
    z.strictObject({
      ...named,
      type: z.literal("parallel"),
      branches: z.array(
        z.strictObject({ id: stepId, name: z.string().min(1), steps: z.array(stepSchema) })
      ),
      concurrency: z.number().int().min(1).optional()
    })
  ])
);

// Strict, so a file that carries a `wiring`, an edge or a position is refused: the steps run
// in the order of the list and a block holds its own.
const manifestSchema = z.strictObject({
  id: z.string().regex(WORKFLOW_ID, "A Workflow id is lowercase letters, digits, '_' and '-'"),
  name: z.string().min(1),
  description: z.string().optional(),
  runAs: z.string().min(1),
  inputs: jsonObjectSchema,
  outputs: jsonObjectSchema,
  labels: inputMappingSchema.optional(),
  onFailure: workflowOnFailureSchema.optional(),
  retention: workflowRetentionSchema.optional(),
  types: z.record(z.string().min(1), jsonObjectSchema).optional(),
  tools: z.array(z.string().min(1)).optional(),
  steps: z.array(stepSchema).min(1)
});

const notSupported = (path: string, what: string): WorkflowDefinitionIssue => ({
  path,
  code: WORKFLOW_ERROR_CODES.notSupported,
  message: `This engine does not run ${what} yet (${WORKFLOW_ERROR_CODES.notSupported})`
});

/**
 * What the file form holds and this engine does not run, each by the name of its field. The
 * reserved blocks `condition` and `parallel` are not named here: `workflowBlockIssues` refuses
 * them, and what they hold is not read.
 */
function unsupportedIssues(manifest: WorkflowManifest): WorkflowDefinitionIssue[] {
  const issues: WorkflowDefinitionIssue[] = [];
  for (const field of ["labels", "onFailure", "retention", "types"] as const) {
    if (manifest[field] !== undefined) issues.push(notSupported(field, `'${field}'`));
  }
  const known: readonly string[] = WORKFLOW_STEP_TYPES;
  const executed: readonly string[] = WORKFLOW_EXECUTED_STEP_TYPES;
  const walk = (steps: readonly WorkflowStep[], path: string) => {
    steps.forEach((step, position) => {
      const at = `${path}[${position}]`;
      if (known.includes(step.type) && !executed.includes(step.type)) {
        issues.push(notSupported(`${at}.type`, `a step of the type '${step.type}'`));
      }
      if (step.type === "trigger") {
        // A trigger that is read and never fires would look like one that is kept.
        step.triggers.forEach((trigger, number) => {
          const here = `${at}.triggers[${number}]`;
          if (trigger.kind === "parent") {
            issues.push(notSupported(`${here}.kind`, "the trigger 'parent'"));
          }
          if (trigger.kind !== "schedule") return;
          // A schedule fires the latest of the due times it missed and skips a due time
          // that meets an open run. The other ways are read and not built.
          if (trigger.missed !== undefined && trigger.missed !== "last") {
            issues.push(notSupported(`${here}.missed`, `'missed: ${trigger.missed}'`));
          }
          if (trigger.overlap !== undefined && trigger.overlap !== "skip") {
            issues.push(notSupported(`${here}.overlap`, `'overlap: ${trigger.overlap}'`));
          }
        });
      }
      if (step.type === "operation") {
        for (const field of ["dataset", "paginate"] as const) {
          if (step[field] !== undefined) issues.push(notSupported(`${at}.${field}`, `'${field}'`));
        }
      }
      if (step.type === "code") {
        // A code step is handed JSON and returns JSON. Datasets come with the slice that
        // keeps them, and a script is not handed one before.
        for (const field of ["inputSchema", "outputSchema"] as const) {
          if (namesDatasetType(step[field])) {
            issues.push(notSupported(`${at}.${field}`, "a dataset in the schema of a code step"));
          }
        }
      }
      if (step.type === "loop") {
        // `collect` returns a dataset, and this engine keeps none.
        if (step.collect !== undefined) issues.push(notSupported(`${at}.collect`, "'collect'"));
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

/** The schema's properties that are named like the key that marks a dataset in step data. */
function datasetKeyIssues(manifest: WorkflowManifest): WorkflowDefinitionIssue[] {
  const properties = z.object({ properties: z.record(z.string(), z.unknown()) });
  return (["inputs", "outputs"] as const).flatMap((field) => {
    const read = properties.safeParse(manifest[field]);
    return read.success && Object.hasOwn(read.data.properties, WORKFLOW_DATASET_KEY)
      ? [{ path: field, message: `No field of '${field}' is named '${WORKFLOW_DATASET_KEY}'` }]
      : [];
  });
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
  for (const [id, { step, sequence }] of index) {
    if (step.type === "code") {
      const file = codeFileIssue(step.file);
      if (file) issues.push({ path: `steps.${id}.file`, message: file });
    }
    if (step.type === "trigger") {
      for (const trigger of step.triggers) {
        if (trigger.kind === "schedule" && !parseCron(trigger.cron)) {
          issues.push({
            path: `steps.${id}.triggers`,
            message: `'${trigger.cron}' is no cron expression of five fields: minute, hour, day of month, month and day of week`
          });
        }
      }
    }
    if (sequence.loop !== undefined && (step.type === "trigger" || step.type === "output")) {
      issues.push({
        path: `steps.${id}`,
        message: `A '${step.type}' step stands at the top, not in a loop`
      });
    }
    const mapped = "input" in step ? Object.entries(step.input) : [];
    for (const [field, source] of mapped) {
      // A literal is no dataset, so it never carries the key that marks one.
      if (source.value !== undefined && holdsBrokenDatasetReference(source.value)) {
        issues.push({
          path: `steps.${id}.input.${field}`,
          message: `The literal of '${field}' holds '${WORKFLOW_DATASET_KEY}' and is no reference to a dataset`
        });
      }
    }
    const references =
      step.type === "loop"
        ? [step.items]
        : mapped.flatMap(([, source]) => (source.ref ? [source.ref] : []));
    for (const reference of references) {
      if (!index.has(reference.step)) {
        issues.push({
          path: `steps.${id}`,
          message: `The step '${id}' refers to '${reference.step}', and no step has that id`
        });
      }
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
 * does not run and what else must hold between the steps.
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
