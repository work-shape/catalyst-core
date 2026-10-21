import { useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { cn } from "../cn";
import { Chip } from "../status/chip";
import { useFieldControl } from "./field-control";
import { fieldFrameClassName } from "./input";

export interface ChipInputProps {
  /** The values, each shown as a chip in the order given. */
  value: readonly string[];
  onChange(value: readonly string[]): void;
  /** What the empty field asks for. */
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  required?: boolean;
  "aria-describedby"?: string;
  className?: string;
}

/** Characters that end one value in typed or pasted text. */
const SEPARATORS = /[,;\n\t]/u;

/**
 * A field that holds a list of short texts as chips. Enter, a comma or leaving the field adds
 * what was typed; pasted text is split at commas, semicolons and line breaks; Backspace in the
 * empty field removes the last chip. A value is held once.
 */
export function ChipInput({
  value,
  onChange,
  placeholder,
  disabled = false,
  invalid,
  id,
  required,
  "aria-describedby": describedBy,
  className
}: ChipInputProps) {
  const control = useFieldControl({ id, invalid, required, "aria-describedby": describedBy });
  const [draft, setDraft] = useState("");
  const add = (texts: readonly string[]) => {
    const next = [...value];
    for (const text of texts.map((entry) => entry.trim()).filter(Boolean)) {
      if (!next.includes(text)) next.push(text);
    }
    if (next.length !== value.length) onChange(next);
  };
  const commit = () => {
    if (draft.trim() === "") return;
    add([draft]);
    setDraft("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      if (draft.trim() === "") return;
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!SEPARATORS.test(text)) return;
    event.preventDefault();
    add([draft, ...text.split(SEPARATORS)]);
    setDraft("");
  };

  return (
    <div
      data-chip-input=""
      className={cn(
        fieldFrameClassName,
        "flex min-h-control-md flex-wrap items-center gap-1.5 px-2 py-1.5 focus-within:focus-field",
        control["aria-invalid"] && "border-destructive",
        disabled && "pointer-events-none cursor-not-allowed opacity-50",
        className
      )}
    >
      {value.map((entry) => (
        <Chip
          key={entry}
          onRemove={disabled ? undefined : () => onChange(value.filter((item) => item !== entry))}
        >
          {entry}
        </Chip>
      ))}
      <input
        {...control}
        value={draft}
        disabled={disabled}
        placeholder={value.length === 0 ? placeholder : undefined}
        className="h-6 min-w-24 flex-1 bg-transparent px-1 text-body text-foreground outline-none placeholder:text-muted-foreground"
        onChange={(event) => {
          const text = event.target.value;
          if (SEPARATORS.test(text)) {
            add(text.split(SEPARATORS).slice(0, -1));
            setDraft(text.split(SEPARATORS).at(-1) ?? "");
          } else {
            setDraft(text);
          }
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={commit}
      />
    </div>
  );
}
