import { AtSign, Braces, Building2, User, UserPlus } from "lucide-react";
import { useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { Picker, type PickerOption, type PickerOptionGroup } from "../overlays/picker";
import { Chip } from "../status/chip";
import { useUiLabels } from "../ui-root";
import { Field } from "./field";
import { useFieldControl } from "./field-control";
import { fieldFrameClassName } from "./input";

/** What a recipient is: a person or a workspace of the directory, an address, a step's value. */
export type RecipientKind = "person" | "workspace" | "address" | "picked";

/** One recipient of the field. */
export interface RecipientItem {
  kind: RecipientKind;
  /** The directory entry's value, the address as typed, or the picked option. */
  value: string;
  /** What the chip says: a name, an address, a step's field. */
  label: string;
  /** Why this recipient cannot be sent to. The chip is marked and the sentence stands under it. */
  invalid?: string;
}

/** A person or a workspace the field may add. */
export interface RecipientDirectoryEntry {
  kind: "person" | "workspace";
  value: string;
  label: string;
  description?: string;
}

export interface RecipientFieldProps {
  label: string;
  value: readonly RecipientItem[];
  onChange(value: RecipientItem[]): void;
  /** The people and workspaces "Add people" offers. */
  directory?: readonly RecipientDirectoryEntry[];
  /** The values of earlier steps "Insert a value" offers, such as lists of addresses. */
  fields?: readonly (PickerOption | PickerOptionGroup)[];
  /**
   * A value of a step takes the field alone: picking one replaces the other recipients, and
   * while one is there nothing else is added.
   */
  pickedAlone?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  readOnly?: boolean;
  onBlur?(): void;
}

/** Characters that end one address in typed or pasted text. */
const SEPARATORS = /[\s,;]+/u;

const icons = { person: User, workspace: Building2, address: AtSign, picked: Braces } as const;

/**
 * Whom a mail goes to: people and workspaces from a directory, addresses typed in, and values
 * of earlier steps, each a chip that can be removed. A recipient the caller marks invalid shows
 * its sentence under the field. It knows no rule of its own about who may be sent to.
 */
export function RecipientField({
  label,
  value,
  onChange,
  directory = [],
  fields = [],
  pickedAlone = false,
  hint,
  error,
  required = false,
  optional = false,
  readOnly = false,
  onBlur
}: RecipientFieldProps) {
  const labels = useUiLabels("RecipientField");
  const alone = pickedAlone && value.some((item) => item.kind === "picked");
  const has = (kind: RecipientKind, entry: string) =>
    value.some((item) => item.kind === kind && item.value === entry);
  const add = (items: readonly RecipientItem[]) => {
    const next = [...value];
    for (const item of items) {
      if (!next.some((kept) => kept.kind === item.kind && kept.value === item.value))
        next.push(item);
    }
    if (next.length !== value.length) onChange(next);
  };
  const addresses = (text: string) =>
    text
      .split(SEPARATORS)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((address): RecipientItem => ({ kind: "address", value: address, label: address }));
  const kindWords: Record<RecipientKind, string> = {
    person: labels.recipientPerson,
    workspace: labels.recipientWorkspace,
    address: labels.recipientAddress,
    picked: labels.valuePicked
  };
  const directoryGroups: PickerOptionGroup[] = [
    { heading: labels.recipientPeople, kind: "person" as const },
    { heading: labels.recipientWorkspaces, kind: "workspace" as const }
  ]
    .map(({ heading, kind }) => ({
      heading,
      options: directory
        .filter((entry) => entry.kind === kind)
        .map((entry) => ({
          value: `${kind}:${entry.value}`,
          label: entry.label,
          ...(entry.description === undefined ? {} : { description: entry.description })
        }))
    }))
    .filter((group) => group.options.length > 0);
  const chosen = value
    .filter((item) => item.kind === "person" || item.kind === "workspace")
    .map((item) => `${item.kind}:${item.value}`);
  const fieldNames = new Map(
    fields
      .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
      .map((option) => [option.value, option.label])
  );
  const invalid = value.filter((item) => item.invalid !== undefined);

  const actions =
    readOnly || alone ? null : (
      <span className="flex items-center gap-1">
        {directoryGroups.length === 0 ? null : (
          <Picker
            multiple
            label={labels.recipientAdd}
            options={directoryGroups}
            value={chosen}
            search
            onValueChange={(values) => {
              const kept = value.filter(
                (item) =>
                  (item.kind !== "person" && item.kind !== "workspace") ||
                  values.includes(`${item.kind}:${item.value}`)
              );
              const added = values
                .filter((entry) => !chosen.includes(entry))
                .flatMap((entry): RecipientItem[] => {
                  const found = directory.find((item) => `${item.kind}:${item.value}` === entry);
                  return found === undefined
                    ? []
                    : [{ kind: found.kind, value: found.value, label: found.label }];
                });
              onChange([...kept, ...added]);
            }}
          >
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-caption">
              <UserPlus aria-hidden />
              {labels.recipientAdd}
            </Button>
          </Picker>
        )}
        {fields.length === 0 ? null : (
          <Picker
            label={labels.insertValue}
            options={fields}
            value={undefined}
            search
            onValueChange={(option) => {
              const item: RecipientItem = {
                kind: "picked",
                value: option,
                label: fieldNames.get(option) ?? option
              };
              if (pickedAlone) onChange([item]);
              else if (!has("picked", option)) onChange([...value, item]);
            }}
          >
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-caption">
              <Braces aria-hidden />
              {labels.insertValue}
            </Button>
          </Picker>
        )}
      </span>
    );

  return (
    <Field
      data-slot="recipient-field"
      className="min-w-0"
      label={label}
      labelEnd={actions}
      hint={alone && hint === undefined ? labels.recipientPickedAlone : hint}
      error={error}
      required={required}
      optional={optional}
    >
      <>
        <RecipientChips
          value={value}
          readOnly={readOnly}
          alone={alone}
          kindWords={kindWords}
          placeholder={labels.recipientTypeAddress}
          onRemove={(item) => onChange(value.filter((kept) => kept !== item))}
          onRemoveLast={() => onChange(value.slice(0, -1))}
          onAddresses={(text) => add(addresses(text))}
          onBlur={onBlur}
        />
        {invalid.length === 0 ? null : (
          <ul className="grid gap-0.5" data-recipient-invalid="">
            {invalid.map((item) => (
              <li key={`${item.kind}:${item.value}`} className="text-caption text-destructive">
                {item.label}: {item.invalid}
              </li>
            ))}
          </ul>
        )}
      </>
    </Field>
  );
}

/** The chips and the place to type an address, inside the Field. */
function RecipientChips({
  value,
  readOnly,
  alone,
  kindWords,
  placeholder,
  onRemove,
  onRemoveLast,
  onAddresses,
  onBlur
}: {
  value: readonly RecipientItem[];
  readOnly: boolean;
  alone: boolean;
  kindWords: Record<RecipientKind, string>;
  placeholder: string;
  onRemove(item: RecipientItem): void;
  onRemoveLast(): void;
  onAddresses(text: string): void;
  onBlur: (() => void) | undefined;
}) {
  // The typing place holds no recipient itself, so it is never required.
  const { required: _required, ...control } = useFieldControl({});
  const [draft, setDraft] = useState("");
  const commit = () => {
    if (draft.trim() === "") return;
    onAddresses(draft);
    setDraft("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "," || event.key === ";" || event.key === " ") {
      if (draft.trim() === "") {
        if (event.key === "Enter") event.preventDefault();
        return;
      }
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      event.preventDefault();
      onRemoveLast();
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!SEPARATORS.test(text.trim())) return;
    event.preventDefault();
    onAddresses(`${draft} ${text}`);
    setDraft("");
  };
  return (
    <div
      data-recipient-chips=""
      className={cn(
        fieldFrameClassName,
        "flex min-h-control-md flex-wrap items-center gap-1.5 px-2 py-1.5 focus-within:focus-field",
        control["aria-invalid"] && "border-destructive",
        readOnly && "border-border"
      )}
    >
      {value.map((item) => {
        const Icon = icons[item.kind];
        return (
          <span
            key={`${item.kind}:${item.value}`}
            data-recipient={item.kind}
            data-invalid={item.invalid === undefined ? undefined : ""}
            className="contents"
          >
            <Chip
              className={cn(
                item.kind === "picked" &&
                  "border-primary-border bg-primary-soft text-primary-soft-foreground",
                item.invalid !== undefined &&
                  "border-destructive-border bg-destructive-soft text-destructive-soft-foreground"
              )}
              leading={<Icon aria-hidden />}
              onRemove={readOnly ? undefined : () => onRemove(item)}
            >
              <span className="sr-only">{kindWords[item.kind]}: </span>
              {item.label}
            </Chip>
          </span>
        );
      })}
      {readOnly || alone ? null : (
        <input
          {...control}
          type="email"
          inputMode="email"
          autoComplete="off"
          value={draft}
          placeholder={value.length === 0 ? placeholder : undefined}
          className="h-6 min-w-32 flex-1 bg-transparent px-1 text-body text-foreground outline-none placeholder:text-muted-foreground"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            commit();
            onBlur?.();
          }}
        />
      )}
    </div>
  );
}
