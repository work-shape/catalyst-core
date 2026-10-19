import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useId, useRef, type ReactNode } from "react";
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
}

export interface FieldListItem {
  /** Stable identity while the name or position changes. */
  id: string;
  name: string;
  kind: string;
  required: boolean;
  description?: string;
  fields?: readonly FieldListItem[];
}

export interface FieldListEditorProps {
  label: string;
  value: readonly FieldListItem[];
  kinds: readonly FieldListKind[];
  onChange(value: readonly FieldListItem[]): void;
  error?: ReactNode;
  /** Errors keyed by stable item id, then by the field's property. */
  errors?: Readonly<Record<string, { name?: string; kind?: string; description?: string }>>;
  readOnly?: boolean;
}

/** A named list with button reordering and one nested level. Conversion to schemas is the caller's. */
export function FieldListEditor({
  label,
  value,
  kinds,
  onChange,
  error,
  errors,
  readOnly = false
}: FieldListEditorProps) {
  const labels = useUiLabels("FieldListEditor");
  const prefix = useId();
  const nextId = useRef(0);
  const renderList = (
    items: readonly FieldListItem[],
    change: (items: readonly FieldListItem[]) => void,
    nested: boolean
  ): ReactNode => {
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
    return (
      <div className="grid min-w-0 gap-3">
        {items.map((item, index) => {
          const kind = allowedKinds.find((candidate) => candidate.value === item.kind);
          const name = item.name || `${labels.fieldName} ${index + 1}`;
          return (
            <fieldset
              key={item.id}
              className="grid min-w-0 gap-3 rounded-lg border p-3"
              data-field-id={item.id}
            >
              <legend className="px-1 text-label">{name}</legend>
              <Field label={labels.fieldName} error={errors?.[item.id]?.name}>
                <Input
                  value={item.name}
                  readOnly={readOnly}
                  onChange={(event) => update(item.id, { name: event.target.value })}
                />
              </Field>
              <Field label={labels.fieldKind} error={errors?.[item.id]?.kind}>
                <Select
                  value={item.kind}
                  disabled={readOnly}
                  onChange={(event) =>
                    update(item.id, { kind: event.target.value, fields: undefined })
                  }
                >
                  {allowedKinds.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
              </Field>
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
                <div className="flex gap-1">
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
                    onClick={() => change(items.filter((entry) => entry.id !== item.id))}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              )}
              {!nested && kind?.children !== undefined
                ? renderList(item.fields ?? [], (fields) => update(item.id, { fields }), true)
                : null}
            </fieldset>
          );
        })}
        {readOnly ? null : (
          <Button
            variant="outline"
            disabled={allowedKinds.length === 0}
            onClick={() => {
              const kind = allowedKinds[0];
              if (kind === undefined) return;
              change([
                ...items,
                { id: `${prefix}-${++nextId.current}`, name: "", kind: kind.value, required: false }
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
    <fieldset data-slot="field-list-editor" className="grid min-w-0 gap-3">
      <legend className="mb-2 text-label">{label}</legend>
      {renderList(value, onChange, false)}
      {error ? (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
