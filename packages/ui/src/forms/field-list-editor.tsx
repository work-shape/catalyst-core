import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "../actions/button";
import { useUiLabels } from "../ui-root";
import { Field } from "./field";
import { Input } from "./input";
import { Select } from "./select";
import { Switch } from "./switch";

export interface FieldListKind {
  value: string;
  label: string;
  /** Allows one level of fields, for a record or a list of records. */
  children?: "record" | "records";
  /** A value that is one of a list of choices, which the editor asks for: "one of a, b, c". */
  choices?: boolean;
}

export interface FieldListItem {
  /** Stable identity while the name or position changes. */
  id: string;
  /** The field's key. With `titled`, the caller derives it and the editor only shows it. */
  name: string;
  /** What a person calls the field. With `titled`, the editor edits this and not the key. */
  title?: string;
  kind: string;
  required: boolean;
  description?: string;
  fields?: readonly FieldListItem[];
  /** The choices of a kind that has them, in their order. */
  choices?: readonly string[];
}

export interface FieldListEditorProps {
  label: string;
  value: readonly FieldListItem[];
  kinds: readonly FieldListKind[];
  onChange(value: readonly FieldListItem[]): void;
  error?: ReactNode;
  /** Errors keyed by stable item id, then by the field's property. */
  errors?: Readonly<
    Record<
      string,
      { name?: string; title?: string; kind?: string; description?: string; choices?: string }
    >
  >;
  readOnly?: boolean;
  /**
   * A person edits each field's title; its key (`name`) is the caller's to derive and shows
   * only as a small technical detail under the title, followed by `keyHint`.
   */
  titled?: boolean;
  /** What the key is for, after it, such as how later steps name the field. */
  keyHint?: string;
}

/**
 * A named list with button reordering, one nested level and choices for a kind that has them.
 * Conversion to schemas is the caller's.
 */
export function FieldListEditor({
  label,
  value,
  kinds,
  onChange,
  error,
  errors,
  readOnly = false,
  titled = false,
  keyHint
}: FieldListEditorProps) {
  const labels = useUiLabels("FieldListEditor");
  const prefix = useId();
  const errorId = useId();
  const nextId = useRef(0);
  const rootRef = useRef<HTMLFieldSetElement>(null);
  // What takes the focus once a removed row is gone: its neighbour's Remove, or the list's Add.
  const focusNext = useRef<string>(undefined);
  useLayoutEffect(() => {
    const selector = focusNext.current;
    if (selector === undefined) return;
    focusNext.current = undefined;
    rootRef.current?.querySelector<HTMLElement>(selector)?.focus();
  });
  const removeSelector = (id: string) =>
    `[data-field-id="${CSS.escape(id)}"] > [data-field-actions] [data-field-remove]`;

  const renderChoices = (item: FieldListItem, update: (patch: Partial<FieldListItem>) => void) => {
    const choices = item.choices ?? [];
    const set = (next: readonly string[]) => update({ choices: next });
    const choiceError = errors?.[item.id]?.choices;
    const choiceErrorId = `${prefix}-${item.id}-choices`;
    return (
      <fieldset
        className="grid min-w-0 gap-2"
        data-field-choices=""
        aria-invalid={choiceError ? true : undefined}
        aria-describedby={choiceError ? choiceErrorId : undefined}
      >
        <legend className="mb-2 text-label">{labels.fieldChoices}</legend>
        {choices.map((choice, index) => {
          const name = `${labels.fieldChoice} ${index + 1}`;
          return (
            // A choice is its text and its place: the list is edited in place.
            <div key={index} className="flex min-w-0 items-center gap-1" data-choice={index}>
              <Input
                aria-label={name}
                className="min-w-0 flex-1"
                value={choice}
                readOnly={readOnly}
                onChange={(event) =>
                  set(choices.map((entry, at) => (at === index ? event.target.value : entry)))
                }
              />
              {readOnly ? null : (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${labels.remove}: ${choice || name}`}
                  data-choice-remove=""
                  onClick={() => {
                    const neighbour = index < choices.length - 1 ? index : index - 1;
                    focusNext.current =
                      neighbour < 0
                        ? `[data-field-id="${CSS.escape(item.id)}"] [data-choice-add]`
                        : `[data-field-id="${CSS.escape(item.id)}"] [data-choice="${neighbour}"] [data-choice-remove]`;
                    set(choices.filter((_, at) => at !== index));
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              )}
            </div>
          );
        })}
        {readOnly ? null : (
          <Button
            variant="outline"
            className="justify-self-start"
            data-choice-add=""
            onClick={() => set([...choices, ""])}
          >
            {labels.addChoice}
          </Button>
        )}
        {choiceError ? (
          <p id={choiceErrorId} role="alert" className="text-caption text-destructive">
            {choiceError}
          </p>
        ) : null}
      </fieldset>
    );
  };

  const renderList = (
    items: readonly FieldListItem[],
    change: (items: readonly FieldListItem[]) => void,
    parent: string | undefined
  ): ReactNode => {
    const nested = parent !== undefined;
    const allowedKinds = nested ? kinds.filter((kind) => kind.children === undefined) : kinds;
    const update = (id: string, patch: Partial<FieldListItem>) =>
      change(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    const move = (index: number, delta: number) => {
      const result = [...items];
      const item = result[index];
      if (item === undefined || index + delta < 0 || index + delta >= result.length) return;
      result.splice(index, 1);
      result.splice(index + delta, 0, item);
      change(result);
    };
    const remove = (index: number) => {
      const neighbour = items[index + 1] ?? items[index - 1];
      focusNext.current =
        neighbour === undefined
          ? `[data-field-add="${CSS.escape(parent ?? "")}"]`
          : removeSelector(neighbour.id);
      change(items.filter((_, at) => at !== index));
    };
    return (
      <div className="grid min-w-0 gap-3">
        {items.map((item, index) => {
          const kind = allowedKinds.find((candidate) => candidate.value === item.kind);
          const name = titled
            ? item.title || `${labels.field} ${index + 1}`
            : item.name || `${labels.fieldName} ${index + 1}`;
          return (
            <fieldset
              key={item.id}
              className="grid min-w-0 gap-3 rounded-lg border p-3"
              data-field-id={item.id}
            >
              <legend className="px-1 text-label">{name}</legend>
              {titled ? (
                <Field
                  label={labels.fieldTitle}
                  error={errors?.[item.id]?.title ?? errors?.[item.id]?.name}
                  hint={
                    item.name === "" ? undefined : (
                      <span data-field-key="">
                        {labels.fieldKey}: <code className="font-mono">{item.name}</code>
                        {keyHint === undefined ? null : ` · ${keyHint}`}
                      </span>
                    )
                  }
                >
                  <Input
                    value={item.title ?? ""}
                    readOnly={readOnly}
                    onChange={(event) => update(item.id, { title: event.target.value })}
                  />
                </Field>
              ) : (
                <Field label={labels.fieldName} error={errors?.[item.id]?.name}>
                  <Input
                    value={item.name}
                    readOnly={readOnly}
                    onChange={(event) => update(item.id, { name: event.target.value })}
                  />
                </Field>
              )}
              <Field label={labels.fieldKind} error={errors?.[item.id]?.kind}>
                <Select
                  value={item.kind}
                  disabled={readOnly}
                  onChange={(event) => {
                    const next = allowedKinds.find(
                      (candidate) => candidate.value === event.target.value
                    );
                    update(item.id, {
                      kind: event.target.value,
                      fields: undefined,
                      choices: next?.choices ? (item.choices ?? [""]) : undefined
                    });
                  }}
                >
                  {allowedKinds.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {kind?.choices ? renderChoices(item, (patch) => update(item.id, patch)) : null}
              <Field label={labels.required} layout="inline">
                <Switch
                  checked={item.required}
                  disabled={readOnly}
                  onCheckedChange={(required) => update(item.id, { required })}
                />
              </Field>
              <Field
                label={labels.fieldDescription}
                error={errors?.[item.id]?.description}
                optional
              >
                <Input
                  value={item.description ?? ""}
                  readOnly={readOnly}
                  onChange={(event) => update(item.id, { description: event.target.value })}
                />
              </Field>
              {readOnly ? null : (
                <div className="flex gap-1" data-field-actions="">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${labels.moveUp}: ${name}`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${labels.moveDown}: ${name}`}
                    disabled={index === items.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${labels.remove}: ${name}`}
                    data-field-remove=""
                    onClick={() => remove(index)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              )}
              {!nested && kind?.children !== undefined
                ? renderList(item.fields ?? [], (fields) => update(item.id, { fields }), item.id)
                : null}
            </fieldset>
          );
        })}
        {readOnly ? null : (
          <Button
            variant="outline"
            data-field-add={parent ?? ""}
            disabled={allowedKinds.length === 0}
            onClick={() => {
              const kind = allowedKinds[0];
              if (kind === undefined) return;
              change([
                ...items,
                {
                  id: `${prefix}-${++nextId.current}`,
                  name: "",
                  kind: kind.value,
                  required: false,
                  choices: kind.choices ? [""] : undefined
                }
              ]);
            }}
          >
            {labels.addField}
          </Button>
        )}
      </div>
    );
  };
  return (
    <fieldset
      ref={rootRef}
      data-slot="field-list-editor"
      className="grid min-w-0 gap-3"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="mb-2 text-label">{label}</legend>
      {renderList(value, onChange, undefined)}
      {error ? (
        <p id={errorId} role="alert" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
