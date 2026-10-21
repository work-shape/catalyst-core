import {
  Button,
  Input,
  SourcedValueField,
  type PickerOptionGroup,
  type SourcedValue,
  type SourcedValueKind
} from "@work-shape/catalyst-ui";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "../../shared/i18n";
import { findStep, type WorkflowManifest } from "./step-edits";
import type { WorkflowStepFacts } from "./workflow-views";

// The values a step takes from earlier steps, as the Settings tab picks them (workflow-canvas
// 9.4): a field of a result before it, offered by the step's name and the field's. The manifest
// names a field by a reference of a step id and a dotted path; the form never shows either.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The key of a field among the options of a picker. A step id holds no `#`. */
export const fieldKey = (field: { step: string; path: string }) => `${field.step}#${field.path}`;

function fieldOfKey(key: string): { step: string; path: string } | undefined {
  const at = key.indexOf("#");
  return at <= 0 ? undefined : { step: key.slice(0, at), path: key.slice(at + 1) };
}

/** The properties of an object schema, by name, in their order. */
function properties(schema: unknown): [string, Record<string, unknown>][] {
  const found = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  return Object.entries(found).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1])
  );
}

/** The schema at a dotted path of an object schema, where the schema says it. */
function schemaAt(schema: unknown, path: string): unknown {
  let current = schema;
  for (const part of path === "" ? [] : path.split(".")) {
    current = properties(current).find(([name]) => name === part)?.[1];
  }
  return current;
}

const isList = (schema: Record<string, unknown>) =>
  schema.type === "array" || (Array.isArray(schema.type) && schema.type.includes("array"));

/** What a step returns, as a schema, where the definition or the instance says it. */
function resultSchema(
  manifest: WorkflowManifest,
  step: Readonly<Record<string, unknown>>,
  facts: WorkflowStepFacts | undefined
): unknown {
  const id = text(step.id) ?? "";
  if (step.type === "trigger") {
    return { type: "object", properties: { input: manifest.inputs ?? {} } };
  }
  return isRecord(step.outputSchema) ? step.outputSchema : facts?.[id]?.outputSchema;
}

interface Scope {
  /** The steps before it whose results it may read, nearest last. */
  before: Readonly<Record<string, unknown>>[];
  /** The loops around it, innermost last. */
  loops: Readonly<Record<string, unknown>>[];
}

/**
 * What a step may read: the steps before it in its list and before each block around it, and
 * the entry of each loop around it. A step inside an earlier block runs once per entry or on
 * one path, so nothing after the block reads it.
 */
function scopeOf(manifest: WorkflowManifest, id: string): Scope | undefined {
  const walk = (list: unknown, outer: Scope): Scope | undefined => {
    if (!Array.isArray(list)) return undefined;
    const before = [...outer.before];
    for (const step of list) {
      if (!isRecord(step)) continue;
      if (step.id === id) return { before, loops: outer.loops };
      const inner: Scope = {
        before,
        loops: step.type === "loop" ? [...outer.loops, step] : outer.loops
      };
      const lists = [
        step.steps,
        step.then,
        step.else,
        ...(Array.isArray(step.branches)
          ? step.branches.map((branch) => (isRecord(branch) ? branch.steps : undefined))
          : [])
      ];
      for (const inside of lists) {
        const found = walk(inside, { before: [...inner.before], loops: inner.loops });
        if (found !== undefined) return found;
      }
      before.push(step);
    }
    return undefined;
  };
  return walk(manifest.steps, { before: [], loops: [] });
}

/**
 * The fields of earlier results a step may take, one group per step, nearest first. `lists`
 * keeps only the fields that hold a list, for what a loop runs over.
 */
export function earlierFields(
  manifest: WorkflowManifest,
  id: string,
  facts: WorkflowStepFacts | undefined,
  words: { entry(loop: string): string; input: string },
  only: { lists?: boolean } = {}
): PickerOptionGroup[] {
  const scope = scopeOf(manifest, id);
  if (scope === undefined) return [];
  const groups: PickerOptionGroup[] = [];
  const add = (heading: string, step: string, schema: unknown, prefix = "") => {
    const options = properties(schema)
      .filter(([, field]) => !only.lists || isList(field))
      .map(([name, field]) => ({
        value: fieldKey({ step, path: `${prefix}${name}` }),
        label: text(field.title) ?? name,
        ...(text(field.description) === undefined ? {} : { description: text(field.description) })
      }));
    if (options.length > 0) groups.push({ heading, options });
  };
  // The entry of each loop around the step: the fields of one item of the list it runs over.
  for (const loop of [...scope.loops].reverse()) {
    const item = loopItemSchema(manifest, loop, facts);
    add(words.entry(text(loop.itemName) ?? text(loop.name) ?? ""), text(loop.id) ?? "", item);
  }
  for (const step of [...scope.before].reverse()) {
    const stepId = text(step.id) ?? "";
    if (step.type === "trigger") {
      add(words.input, stepId, manifest.inputs, "input.");
    } else {
      add(text(step.name) ?? stepId, stepId, resultSchema(manifest, step, facts));
    }
  }
  return groups;
}

/** The schema of one item of the list a loop runs over, where the definition says it. */
function loopItemSchema(
  manifest: WorkflowManifest,
  loop: Readonly<Record<string, unknown>>,
  facts: WorkflowStepFacts | undefined
): unknown {
  const items = isRecord(loop.items) ? loop.items : undefined;
  const source = text(items?.step);
  const from = source === undefined ? undefined : findStep(manifest, source);
  const list =
    from === undefined
      ? undefined
      : schemaAt(resultSchema(manifest, from, facts), text(items?.path) ?? "");
  return isRecord(list) ? list.items : undefined;
}

/**
 * The schema of the field a reference names: of a loop's entry, of what the run was started
 * with, or of an earlier step's result. Nothing where no schema says it.
 */
export function pickedSchema(
  manifest: WorkflowManifest,
  facts: WorkflowStepFacts | undefined,
  ref: { step: string; path: string }
): Record<string, unknown> | undefined {
  const from = findStep(manifest, ref.step);
  if (from === undefined) return undefined;
  const whole =
    from.type === "loop"
      ? loopItemSchema(manifest, from, facts)
      : resultSchema(manifest, from, facts);
  const found = schemaAt(whole, ref.path);
  return isRecord(found) ? found : undefined;
}

/**
 * The schema of one named value: the kind of a fixed value, or the schema of the field it was
 * picked from. `kept` is what was written before; it stands where it still fits.
 */
export function rowSchema(
  row: MappingRow,
  kept: unknown,
  manifest: WorkflowManifest,
  facts: WorkflowStepFacts | undefined
): Record<string, unknown> {
  if (row.value.kind === "fixed") {
    const value = row.value.value;
    const type =
      typeof value === "string"
        ? "string"
        : typeof value === "number"
          ? "number"
          : typeof value === "boolean"
            ? "boolean"
            : undefined;
    if (isRecord(kept) && (type === undefined || kept.type === type)) return kept;
    return type === undefined ? {} : { type };
  }
  const field = fieldOfKey(pickedOption(row.value));
  const picked = field === undefined ? undefined : pickedSchema(manifest, facts, field);
  return picked ?? (isRecord(kept) ? kept : {});
}

const pickedOption = (sourced: SourcedValue) => (sourced.kind === "picked" ? sourced.option : "");

/** One field of a step's input as the manifest holds it: a value, a reference or a text. */
export type InputValue = Readonly<Record<string, unknown>>;

/** A fixed value the form can show: text, a number, yes or no. Anything else is the agent's. */
type Shown = string | number | boolean | null;

const shownValue = (value: unknown): value is Shown =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

/**
 * The manifest's value as the field shows it, or nothing for a value the form does not edit:
 * a text joined from parts, a list or a record. Those stay read-only with "Change with the
 * agent".
 */
export function sourcedOf(value: unknown): SourcedValue | undefined {
  if (value === undefined) return { kind: "fixed", value: "" };
  if (!isRecord(value)) return undefined;
  if ("value" in value) {
    return shownValue(value.value) ? { kind: "fixed", value: value.value } : undefined;
  }
  if (isRecord(value.ref)) {
    // A value to be picked from a step whose field is not chosen yet.
    if (value.ref.step === "") return { kind: "picked", option: "" };
    const step = text(value.ref.step);
    const path = typeof value.ref.path === "string" ? value.ref.path : undefined;
    return step === undefined || path === undefined
      ? undefined
      : { kind: "picked", option: fieldKey({ step, path }) };
  }
  return undefined;
}

/** The field's value as the manifest holds it. A pick of no field yet is no value. */
export function inputValueOf(value: SourcedValue): InputValue | undefined {
  if (value.kind === "fixed") return { value: value.value };
  const field = fieldOfKey(value.option);
  return field === undefined ? undefined : { ref: field };
}

/**
 * The field's value as the form keeps it while it is changed: what `inputValueOf` gives, and
 * a pick of no field yet as a reference to nothing, which holds the save back.
 */
export function draftValueOf(value: SourcedValue): InputValue {
  return (
    inputValueOf(value) ??
    (value.kind === "picked" ? { ref: { step: "", path: "" } } : { value: "" })
  );
}

/** How a fixed value is typed in, by what it holds now. */
export function kindOf(value: SourcedValue, long = false): SourcedValueKind {
  if (value.kind === "fixed") {
    if (typeof value.value === "number") return "number";
    if (typeof value.value === "boolean") return "boolean";
  }
  return long ? "textarea" : "text";
}

/** One named value of a mapping: a row of the result's values. */
export interface MappingRow {
  name: string;
  value: SourcedValue;
}

/** The rows of a mapping, or nothing where a value of it is one the form does not edit. */
export function rowsOf(mapping: unknown): MappingRow[] | undefined {
  const rows: MappingRow[] = [];
  for (const [name, value] of Object.entries(isRecord(mapping) ? mapping : {})) {
    const shown = sourcedOf(value);
    if (shown === undefined) return undefined;
    rows.push({ name, value: shown });
  }
  return rows;
}

/** The mapping of rows, where each row is named and has a value: else nothing. */
export function mappingOf(rows: readonly MappingRow[]): Record<string, InputValue> | undefined {
  const mapping: Record<string, InputValue> = {};
  for (const row of rows) {
    const value = inputValueOf(row.value);
    if (row.name.trim() === "" || value === undefined || Object.hasOwn(mapping, row.name)) {
      return undefined;
    }
    mapping[row.name.trim()] = value;
  }
  return mapping;
}

/** The rows of a mapping, each a name and a value of its own kind or from an earlier step. */
export function MappingRows({
  label,
  rows,
  options,
  errors,
  readOnly = false,
  onChange,
  onBlur
}: {
  label: string;
  rows: readonly MappingRow[];
  options: readonly PickerOptionGroup[];
  /** What the instance says of a row, by its name. */
  errors?: ReadonlyMap<string, string>;
  readOnly?: boolean;
  onChange(rows: MappingRow[]): void;
  onBlur?(): void;
}) {
  const { t } = useTranslation();
  const set = (index: number, row: MappingRow) =>
    onChange(rows.map((current, at) => (at === index ? row : current)));
  return (
    <fieldset className="grid min-w-0 gap-3" data-mapping-rows="">
      <legend className="mb-1 text-label">{label}</legend>
      {rows.map((row, index) => (
        <div
          key={index}
          className="grid min-w-0 gap-2 rounded-md border p-3"
          data-mapping-row={row.name}
        >
          <div className="flex min-w-0 items-end gap-2">
            <Input
              aria-label={t("workflows.settings.rowName")}
              className="min-w-0 flex-1"
              value={row.name}
              readOnly={readOnly}
              onBlur={onBlur}
              onChange={(event) => set(index, { ...row, name: event.target.value })}
            />
            {readOnly ? null : (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("workflows.settings.rowRemove", { name: row.name })}
                onClick={() => onChange(rows.filter((_, at) => at !== index))}
              >
                <Trash2 aria-hidden />
              </Button>
            )}
          </div>
          <SourcedValueField
            label={t("workflows.settings.rowValue", { name: row.name || "…" })}
            value={row.value}
            kind={kindOf(row.value)}
            options={options}
            readOnly={readOnly}
            error={errors?.get(row.name)}
            onBlur={onBlur}
            onChange={(value) => set(index, { ...row, value })}
          />
        </div>
      ))}
      {readOnly ? null : (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => onChange([...rows, { name: "", value: { kind: "fixed", value: "" } }])}
        >
          <Plus aria-hidden />
          {t("workflows.settings.rowAdd")}
        </Button>
      )}
    </fieldset>
  );
}
