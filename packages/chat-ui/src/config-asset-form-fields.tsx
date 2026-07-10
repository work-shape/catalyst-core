import { Plus } from "lucide-react";
import type { AgentFormState, LocalizedPair } from "./config-assets-model";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";

export function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function LocalizedField({
  label,
  required,
  value,
  onChange
}: {
  label: string;
  required?: boolean;
  value: LocalizedPair;
  onChange(value: LocalizedPair): void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1">
          <Input
            value={value.en}
            required={required && !value.de.trim()}
            placeholder="English"
            onChange={(event) => onChange({ ...value, en: event.target.value })}
          />
          <span className="px-1 text-[10px] text-muted-foreground uppercase">en</span>
        </div>
        <div className="grid gap-1">
          <Input
            value={value.de}
            placeholder="Deutsch"
            onChange={(event) => onChange({ ...value, de: event.target.value })}
          />
          <span className="px-1 text-[10px] text-muted-foreground uppercase">de</span>
        </div>
      </div>
    </div>
  );
}

export function CheckboxGroup({
  label,
  options,
  selected,
  emptyHint,
  hint,
  onChange
}: {
  label: string;
  options: string[];
  selected: string[];
  emptyHint: string;
  hint?: string;
  onChange(selected: string[]): void;
}) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="text-sm font-medium">{label}</legend>
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {options.map((option) => (
            <label key={option} className="inline-flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                className="accent-primary"
                checked={selected.includes(option)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option]
                      : selected.filter((entry) => entry !== option)
                  )
                }
              />
              <span className="font-mono text-xs">{option}</span>
            </label>
          ))}
        </div>
      )}
      {hint ? <p className="text-xs text-amber-600">{hint}</p> : null}
    </fieldset>
  );
}

export function InitialPromptsEditor({
  prompts,
  onChange
}: {
  prompts: AgentFormState["initialPrompts"];
  onChange(prompts: AgentFormState["initialPrompts"]): void;
}) {
  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Initial prompts</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([
              ...prompts,
              { title: { en: "", de: "" }, prompt: { en: "", de: "" } }
            ])
          }
        >
          <Plus size={14} aria-hidden="true" />
          Add prompt
        </Button>
      </div>
      {prompts.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Optional suggestion cards shown on the empty conversation screen.
        </p>
      ) : null}
      {prompts.map((prompt, index) => (
        <div key={index} className="grid gap-2 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Prompt {index + 1}</span>
            <button
              type="button"
              className="text-xs text-muted-foreground transition-colors hover:text-destructive"
              onClick={() => onChange(prompts.filter((_, promptIndex) => promptIndex !== index))}
            >
              Remove
            </button>
          </div>
          <LocalizedField
            label="Title"
            value={prompt.title}
            onChange={(title) =>
              onChange(
                prompts.map((entry, promptIndex) =>
                  promptIndex === index ? { ...entry, title } : entry
                )
              )
            }
          />
          <LocalizedField
            label="Prompt"
            value={prompt.prompt}
            onChange={(promptValue) =>
              onChange(
                prompts.map((entry, promptIndex) =>
                  promptIndex === index ? { ...entry, prompt: promptValue } : entry
                )
              )
            }
          />
        </div>
      ))}
    </section>
  );
}

export function DeleteDialog({
  open,
  onOpenChange,
  subject,
  onConfirm
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  subject: string;
  onConfirm(): void;
}) {
  return (
    <Dialog open={open} title={`Delete ${subject}?`} onClose={() => onOpenChange(false)}>
      <div className="grid gap-4 p-5">
        <p className="text-sm text-muted-foreground">
          The {subject} stops being available for new conversations right away. Its revision history
          is kept, so it can be restored later.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={onConfirm}>
            Delete
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
