import { Braces } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { Picker, type PickerOption, type PickerOptionGroup } from "../overlays/picker";
import { useUiLabels } from "../ui-root";
import { Field } from "./field";
import { useFieldControl } from "./field-control";
import { fieldFrameClassName } from "./input";

/** One part of a text: written text, or a value of an earlier step by its option. */
export type TemplatePart = string | { option: string };

/** The parts in their shortest form: no empty text, and no two texts side by side. */
export function normalizeTemplateParts(parts: readonly TemplatePart[]): TemplatePart[] {
  const joined: TemplatePart[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (part === "") continue;
      const last = joined.at(-1);
      if (typeof last === "string") joined[joined.length - 1] = last + part;
      else joined.push(part);
    } else {
      joined.push({ option: part.option });
    }
  }
  return joined;
}

function sameParts(a: readonly TemplatePart[], b: readonly TemplatePart[]): boolean {
  const left = normalizeTemplateParts(a);
  const right = normalizeTemplateParts(b);
  return (
    left.length === right.length &&
    left.every((part, index) => {
      const other = right[index];
      return typeof part === "string"
        ? part === other
        : typeof other !== "string" && other?.option === part.option;
    })
  );
}

/** The label of each option, by its value. */
function optionLabels(
  options: readonly (PickerOption | PickerOptionGroup)[]
): ReadonlyMap<string, string> {
  return new Map(
    options
      .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
      .map((option) => [option.value, option.label])
  );
}

/** The classes of a value's chip inside text: in the run it stands for what the step gave. */
const chipClassName =
  "mx-0.5 inline-flex max-w-full items-center rounded-full border border-primary-border bg-primary-soft px-1.5 align-baseline text-caption leading-5 font-medium text-primary-soft-foreground select-none";

/** A zero-width space keeps a place for the caret after a chip at the end of a line. */
const CARET_KEEPER = "​";

function chipNode(document: Document, option: string, label: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.templateOption = option;
  chip.className = chipClassName;
  chip.textContent = label;
  return chip;
}

/** Whether nothing but empty text follows a node in its parent. */
function endsLine(child: Node): boolean {
  for (let next = child.nextSibling; next !== null; next = next.nextSibling) {
    if (next.nodeType !== Node.TEXT_NODE) return false;
    if ((next.textContent ?? "").replaceAll(CARET_KEEPER, "") !== "") return false;
  }
  return true;
}

/** The parts the editor holds: its text, its chips, and its line breaks. */
function readParts(node: HTMLElement): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const walk = (parent: Node) => {
    parent.childNodes.forEach((child, index) => {
      if (child.nodeType === Node.TEXT_NODE) {
        parts.push((child.textContent ?? "").replaceAll(CARET_KEEPER, ""));
      } else if (child instanceof HTMLElement) {
        const option = child.dataset.templateOption;
        if (option !== undefined) {
          parts.push({ option });
        } else if (child.tagName === "BR") {
          // The break a browser keeps at the end of a line, so the line shows, is no line of
          // the text: "a<br>" is "a", "a<br><br>" is "a" and a new line, an emptied editor "".
          if (!endsLine(child)) parts.push("\n");
        } else {
          // A block a browser made for a new line.
          if (index > 0) parts.push("\n");
          walk(child);
        }
      }
    });
  };
  walk(node);
  return normalizeTemplateParts(parts);
}

function writeParts(
  node: HTMLElement,
  parts: readonly TemplatePart[],
  labelOf: (option: string) => string
) {
  const document = node.ownerDocument;
  node.replaceChildren(
    ...normalizeTemplateParts(parts).map((part) =>
      typeof part === "string"
        ? document.createTextNode(part)
        : chipNode(document, part.option, labelOf(part.option))
    )
  );
}

export interface TemplateTextProps {
  value: readonly TemplatePart[];
  /** The values of steps the parts name, by option, for the names of their chips. */
  options: readonly (PickerOption | PickerOptionGroup)[];
  className?: string;
}

/** A text with the values of steps it takes as chips, to be read and not changed. */
export function TemplateText({ value, options, className }: TemplateTextProps) {
  const labels = useUiLabels("TemplateText");
  const names = optionLabels(options);
  return (
    <span data-slot="template-text" className={cn("min-w-0 whitespace-pre-wrap", className)}>
      {normalizeTemplateParts(value).map((part, index) =>
        typeof part === "string" ? (
          // The parts have no id of their own; their order is the text's.
          <span key={index}>{part}</span>
        ) : (
          <span key={index} data-template-option={part.option} className={chipClassName}>
            {names.get(part.option) ?? labels.chooseValue}
          </span>
        )
      )}
    </span>
  );
}

export interface TemplateTextFieldProps {
  label: string;
  /** The text as parts: written text, and the values of steps it takes, in order. */
  value: readonly TemplatePart[];
  onChange(value: TemplatePart[]): void;
  /**
   * The values of earlier steps "Insert a value" offers, already scoped and named by the
   * caller, on their own or in groups.
   */
  options: readonly (PickerOption | PickerOptionGroup)[];
  /** Several lines, where Enter starts a new one. Without it the text is one line. */
  multiline?: boolean;
  /** How many lines a multiline field shows at least. */
  rows?: number;
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  readOnly?: boolean;
  /** At the end of the label's row, before "Insert a value", such as a switch to a preview. */
  labelEnd?: ReactNode;
  /** Shown in place of the text while given, such as a preview of what the text becomes. */
  view?: ReactNode;
  onBlur?(): void;
}

/**
 * A text in which the values of earlier steps stand as chips. "Insert a value" puts a chip
 * where the caret is; Backspace takes one out as one character. It gives and takes a list of
 * text and picked parts and knows no references, paths or schemas.
 */
export function TemplateTextField({
  label,
  value,
  onChange,
  options,
  multiline = false,
  rows = 4,
  placeholder,
  hint,
  error,
  required = false,
  optional = false,
  readOnly = false,
  labelEnd,
  view,
  onBlur
}: TemplateTextFieldProps) {
  const labels = useUiLabels("TemplateTextField");
  const editor = useRef<HTMLDivElement>(null);
  const caret = useRef<Range | null>(null);
  const names = optionLabels(options);
  const labelOf = (option: string) => names.get(option) ?? labels.chooseValue;
  const namesKey = [...names].map(([option, name]) => `${option}=${name}`).join("\n");
  const labelOfRef = useRef(labelOf);
  labelOfRef.current = labelOf;

  // What the editor shows follows the value where it differs: a change from outside is drawn,
  // and a change typed here, which the value already holds, leaves the caret where it is.
  useLayoutEffect(() => {
    const node = editor.current;
    if (!node) return;
    if (!sameParts(readParts(node), value)) writeParts(node, value, labelOfRef.current);
  }, [value, view]);

  // The names of the chips follow the options, which may arrive after the text.
  useLayoutEffect(() => {
    const node = editor.current;
    if (!node) return;
    for (const chip of Array.from(node.querySelectorAll<HTMLElement>("[data-template-option]"))) {
      const name = labelOfRef.current(chip.dataset.templateOption ?? "");
      if (chip.textContent !== name) chip.textContent = name;
    }
  }, [namesKey, view]);

  // Where the caret was in the editor, for a value inserted from the picker, which takes the focus.
  useEffect(() => {
    const document = editor.current?.ownerDocument;
    if (!document) return;
    const remember = () => {
      const selection = document.getSelection();
      const node = editor.current;
      if (!selection || selection.rangeCount === 0 || !node) return;
      const range = selection.getRangeAt(0);
      if (node.contains(range.startContainer)) caret.current = range.cloneRange();
    };
    document.addEventListener("selectionchange", remember);
    return () => document.removeEventListener("selectionchange", remember);
  }, []);

  const emit = useCallback(() => {
    const node = editor.current;
    if (node) onChange(readParts(node));
  }, [onChange]);

  const insert = (option: string) => {
    const node = editor.current;
    if (!node) return;
    const document = node.ownerDocument;
    const chip = chipNode(document, option, labelOf(option));
    const kept = caret.current;
    const range = kept && node.contains(kept.startContainer) ? kept : document.createRange();
    if (range !== kept) {
      range.selectNodeContents(node);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(chip);
    let after: Node = chip;
    if (chip.nextSibling === null) {
      after = document.createTextNode(CARET_KEEPER);
      chip.after(after);
    }
    const next = document.createRange();
    if (after === chip) next.setStartAfter(chip);
    else next.setStart(after, 1);
    next.collapse(true);
    caret.current = next;
    emit();
    // The picker gives the focus back to its button as it closes; then the text takes it.
    requestAnimationFrame(() => {
      node.focus();
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(next);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && !multiline) event.preventDefault();
  };
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    // Only text is taken, and on one line only one line.
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    const pasted = multiline ? text : text.replace(/\s*[\r\n]+\s*/gu, " ");
    event.currentTarget.ownerDocument.execCommand("insertText", false, pasted);
  };

  const insertButton =
    readOnly || view !== undefined ? null : (
      <Picker
        label={labels.insertValue}
        options={options}
        value={undefined}
        search
        onValueChange={insert}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-caption"
          disabled={options.length === 0}
        >
          <Braces aria-hidden />
          {labels.insertValue}
        </Button>
      </Picker>
    );
  const end =
    labelEnd === undefined && insertButton === null ? undefined : (
      <span className="flex items-center gap-1">
        {labelEnd}
        {insertButton}
      </span>
    );

  return (
    <Field
      data-slot="template-text-field"
      className="min-w-0"
      label={label}
      labelEnd={end}
      hint={hint}
      error={error}
      required={required}
      optional={optional}
    >
      <>
        {view === undefined ? null : <div data-template-view="">{view}</div>}
        <TemplateEditor
          editorRef={editor}
          label={label}
          multiline={multiline}
          rows={rows}
          readOnly={readOnly}
          required={required}
          placeholder={placeholder}
          hidden={view !== undefined}
          onInput={emit}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={onBlur}
        />
      </>
    </Field>
  );
}

/** The editable text, inside its Field: it takes the field's id, message and invalid state. */
function TemplateEditor({
  editorRef,
  label,
  multiline,
  rows,
  readOnly,
  required,
  placeholder,
  hidden,
  onInput,
  onKeyDown,
  onPaste,
  onBlur
}: {
  editorRef: RefObject<HTMLDivElement | null>;
  label: string;
  multiline: boolean;
  rows: number;
  readOnly: boolean;
  required: boolean;
  placeholder: string | undefined;
  hidden: boolean;
  onInput(): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onPaste(event: ClipboardEvent<HTMLDivElement>): void;
  onBlur: (() => void) | undefined;
}) {
  const control = useFieldControl({});
  return (
    <div
      ref={editorRef}
      id={control.id}
      role="textbox"
      aria-label={label}
      aria-multiline={multiline}
      aria-readonly={readOnly || undefined}
      aria-required={required || undefined}
      aria-invalid={control["aria-invalid"]}
      aria-describedby={control["aria-describedby"]}
      contentEditable={readOnly ? false : "plaintext-only"}
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder}
      data-template-editor=""
      className={cn(
        fieldFrameClassName,
        hidden ? "hidden" : "block",
        "px-3 py-1.5 leading-6 break-words whitespace-pre-wrap outline-none focus:focus-field",
        "empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]",
        multiline ? "overflow-y-auto" : "min-h-control-md",
        readOnly && "border-border",
        control["aria-invalid"] && "border-destructive"
      )}
      style={multiline ? { minHeight: `${rows * 1.5 + 0.75}rem` } : undefined}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onBlur={onBlur}
    />
  );
}
