import type { TranslationKey } from "../../shared/i18n";

// The start form of a Workflow, made from the JSON Schema of its published `inputs`: one field
// per property, the required ones first, and the check of what a person entered
// before it goes to the instance. The instance checks the input again on the start.

/** How a field is asked for. */
type StartFieldControl = "text" | "date" | "email" | "number" | "choice" | "yesNo";

/** What the form holds of a field while it is filled in: text, or on or off. */
export type StartFieldValue = string | boolean;

/** One input of a Workflow as a field of its start form. */
export interface StartField {
  /** The name of the property in the input. Never shown. */
  name: string;
  /** The schema's `title`, or the name as words. */
  label: string;
  /** The schema's `description`. */
  hint?: string;
  control: StartFieldControl;
  required: boolean;
  /** What the field holds when the form opens: the schema's `default`, or nothing. */
  initial: StartFieldValue;
  /** On a choice: the values to pick from, in their order. */
  options?: readonly string[];
  /** On a number: only whole numbers fit. */
  integer?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  /** A regular expression the text has to match, where the browser can read it. */
  pattern?: string;
}

/** The start form of one Workflow. */
export interface StartForm {
  fields: readonly StartField[];
  /**
   * Inputs the form has no field for, such as a list or an object. A required one keeps the
   * Workflow from being started here; an optional one is left out of the input.
   */
  unsupported: readonly { name: string; required: boolean }[];
}

/** The form of a Workflow that takes no input. */
export const NO_START_FORM: StartForm = { fields: [], unsupported: [] };

/** What is wrong with the value of a field, as a sentence of the interface. */
export interface StartFieldProblem {
  key: TranslationKey;
  /** The numbers the sentence names, formatted by the reader's locale where it is shown. */
  values?: Readonly<Record<string, number>>;
}

/** A filled-in form: the input of the run, or what is wrong, by the name of the field. */
export type StartFormCheck =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; problems: ReadonlyMap<string, StartFieldProblem> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** An id as words: `client_id` is "Client id". */
export function nameFromId(id: string): string {
  const words = id.replace(/[_-]+/gu, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The one type a property names. A nullable type is that type; a choice of two is none. */
function typeOf(schema: Record<string, unknown>): string | undefined {
  if (typeof schema.type === "string") return schema.type;
  if (!Array.isArray(schema.type)) return undefined;
  const types = schema.type.filter((type) => type !== "null");
  return types.length === 1 && typeof types[0] === "string" ? types[0] : undefined;
}

/** A pattern the browser can compile. One it cannot is left to the instance to check. */
function readablePattern(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    new RegExp(value, "u");
    return value;
  } catch {
    return undefined;
  }
}

type FieldShape = Pick<
  StartField,
  | "control"
  | "initial"
  | "options"
  | "integer"
  | "minimum"
  | "maximum"
  | "exclusiveMinimum"
  | "exclusiveMaximum"
  | "minLength"
  | "maxLength"
  | "pattern"
>;

/** The rules a property sets beside its type, without the ones it does not set. */
function bounds(schema: Record<string, unknown>, keys: readonly (keyof FieldShape)[]) {
  const found: Partial<FieldShape> = {};
  for (const key of keys) {
    const value = key === "pattern" ? readablePattern(schema.pattern) : finite(schema[key]);
    if (value !== undefined) Object.assign(found, { [key]: value });
  }
  return found;
}

/** How one property is asked for, or nothing where the form has no field for it. */
function shapeOf(schema: Record<string, unknown>): FieldShape | undefined {
  const type = typeOf(schema);
  if (Array.isArray(schema.enum)) {
    const options = schema.enum.filter((option): option is string => typeof option === "string");
    // A choice of other values than words is the instance's to take, not this form's.
    if (options.length === 0 || options.length !== schema.enum.length) return undefined;
    const initial = typeof schema.default === "string" && options.includes(schema.default);
    return { control: "choice", options, initial: initial ? String(schema.default) : "" };
  }
  switch (type) {
    case "string": {
      const control =
        schema.format === "date" ? "date" : schema.format === "email" ? "email" : "text";
      return {
        control,
        initial: typeof schema.default === "string" ? schema.default : "",
        ...bounds(schema, ["minLength", "maxLength", "pattern"])
      };
    }
    case "number":
    case "integer": {
      const initial = finite(schema.default);
      return {
        control: "number",
        initial: initial === undefined ? "" : String(initial),
        ...(type === "integer" ? { integer: true } : {}),
        ...bounds(schema, ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"])
      };
    }
    case "boolean":
      return { control: "yesNo", initial: schema.default === true };
    default:
      return undefined;
  }
}

/**
 * The start form for the `inputs` of a Workflow, required fields first. A schema without properties asks for
 * nothing. A property the form cannot ask for is named in `unsupported`.
 */
export function startFormOf(inputs: unknown): StartForm {
  if (!isRecord(inputs) || !isRecord(inputs.properties)) {
    return NO_START_FORM;
  }
  const required = new Set(
    Array.isArray(inputs.required)
      ? inputs.required.filter((name): name is string => typeof name === "string")
      : []
  );
  const fields: StartField[] = [];
  const unsupported: { name: string; required: boolean }[] = [];
  for (const [name, property] of Object.entries(inputs.properties)) {
    const shape = isRecord(property) ? shapeOf(property) : undefined;
    if (shape === undefined || !isRecord(property)) {
      unsupported.push({ name, required: required.has(name) });
      continue;
    }
    const hint = text(property.description);
    fields.push({
      name,
      label: text(property.title) ?? nameFromId(name),
      ...(hint === undefined ? {} : { hint }),
      required: required.has(name),
      ...shape
    });
  }
  // The instance stores a definition as JSON whose keys it orders by itself, so the order of
  // `properties` is not the author's. A list keeps its order: the fields a start needs come
  // first, as `required` names them, and the others follow in the order that arrived.
  const position = [...required];
  return {
    fields: [
      ...fields
        .filter((field) => field.required)
        .sort((a, b) => position.indexOf(a.name) - position.indexOf(b.name)),
      ...fields.filter((field) => !field.required)
    ],
    unsupported
  };
}

/** The form can give every input a start needs: none it has no field for is required. */
export function startFormUsable(form: StartForm): boolean {
  return !form.unsupported.some((input) => input.required);
}

/** The values the form opens with, by the name of the field. */
export function initialStartValues(form: StartForm): Record<string, StartFieldValue> {
  return Object.fromEntries(form.fields.map((field) => [field.name, field.initial]));
}

/** The value of one field, read only from the values themselves and never their prototype. */
export function valueOf(
  values: Readonly<Record<string, StartFieldValue>>,
  name: string
): StartFieldValue | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

/** A date as the date field gives it: a day of the calendar. */
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
/** An address as the instance reads one: a name, an at sign and a domain with a dot. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function numberProblem(field: StartField, value: number): StartFieldProblem | undefined {
  if (field.integer === true && !Number.isInteger(value)) {
    return { key: "workflows.startForm.notWhole" };
  }
  if (field.minimum !== undefined && value < field.minimum) {
    return { key: "workflows.startForm.atLeast", values: { limit: field.minimum } };
  }
  if (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum) {
    return { key: "workflows.startForm.moreThan", values: { limit: field.exclusiveMinimum } };
  }
  if (field.maximum !== undefined && value > field.maximum) {
    return { key: "workflows.startForm.atMost", values: { limit: field.maximum } };
  }
  if (field.exclusiveMaximum !== undefined && value >= field.exclusiveMaximum) {
    return { key: "workflows.startForm.lessThan", values: { limit: field.exclusiveMaximum } };
  }
  return undefined;
}

function textProblem(field: StartField, value: string): StartFieldProblem | undefined {
  // The schema counts characters as code points, as the instance does.
  const length = [...value].length;
  if (field.minLength !== undefined && length < field.minLength) {
    return { key: "workflows.startForm.tooShort", values: { limit: field.minLength } };
  }
  if (field.maxLength !== undefined && length > field.maxLength) {
    return { key: "workflows.startForm.tooLong", values: { limit: field.maxLength } };
  }
  if (field.control === "date" && !DATE.test(value)) {
    return { key: "workflows.startForm.notDate" };
  }
  if (field.control === "email" && !EMAIL.test(value)) {
    return { key: "workflows.startForm.notEmail" };
  }
  if (field.pattern !== undefined && !new RegExp(field.pattern, "u").test(value)) {
    return { key: "workflows.startForm.notPattern" };
  }
  return undefined;
}

type FieldResult = { value: unknown } | { problem: StartFieldProblem } | { empty: true };

function checkField(field: StartField, raw: StartFieldValue | undefined): FieldResult {
  if (field.control === "yesNo") {
    return { value: raw === true };
  }
  const entered = typeof raw === "string" ? raw : "";
  // Text is taken as typed; only a field left blank counts as empty.
  if (entered.trim() === "") {
    return field.required
      ? {
          problem: {
            key:
              field.control === "choice"
                ? "workflows.startForm.choose"
                : "workflows.startForm.required"
          }
        }
      : { empty: true };
  }
  if (field.control === "choice") {
    return field.options?.includes(entered) === true
      ? { value: entered }
      : { problem: { key: "workflows.startForm.choose" } };
  }
  if (field.control === "number") {
    const value = Number(entered.trim());
    if (!Number.isFinite(value)) {
      return { problem: { key: "workflows.startForm.notNumber" } };
    }
    const problem = numberProblem(field, value);
    return problem === undefined ? { value } : { problem };
  }
  const problem = textProblem(field, entered);
  return problem === undefined ? { value: entered } : { problem };
}

/**
 * Checks what was entered against the form and makes the input of the run from it: numbers as
 * numbers, a yes or no as true or false, and an optional field left empty left out.
 */
export function checkStartForm(
  form: StartForm,
  values: Readonly<Record<string, StartFieldValue>>
): StartFormCheck {
  // Entries and not assignments: an input may be named `__proto__`.
  const input: [string, unknown][] = [];
  const problems = new Map<string, StartFieldProblem>();
  for (const field of form.fields) {
    const result = checkField(field, valueOf(values, field.name));
    if ("problem" in result) {
      problems.set(field.name, result.problem);
    } else if ("value" in result) {
      input.push([field.name, result.value]);
    }
  }
  return problems.size > 0
    ? { ok: false, problems }
    : { ok: true, input: Object.fromEntries(input) };
}

/** One value the instance refused at a start: its sentence and where in the input it is. */
export interface StartRefusalIssue {
  message: string;
  path: readonly unknown[];
}

/**
 * The refusal of a start, by field: each issue the instance named at the path of one field of
 * the form goes under it, every other one stands for the whole form.
 */
export function startRefusalByField(
  form: StartForm,
  issues: readonly StartRefusalIssue[]
): { fields: ReadonlyMap<string, string>; rest: string[] } {
  const names = new Set(form.fields.map((field) => field.name));
  const fields = new Map<string, string>();
  const rest: string[] = [];
  for (const issue of issues) {
    const [name] = issue.path;
    if (typeof name === "string" && names.has(name) && !fields.has(name)) {
      fields.set(name, issue.message);
    } else {
      rest.push(issue.message);
    }
  }
  return { fields, rest };
}
