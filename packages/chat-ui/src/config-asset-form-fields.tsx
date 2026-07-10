import { Plus } from "lucide-react";
import type { AgentFormState, LocalizedPair } from "./config-assets-model";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
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
        <label className="grid gap-1.5">
          <span className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
            EN · English
          </span>
          <Input
            value={value.en}
            required={required && !value.de.trim()}
            onChange={(event) => onChange({ ...value, en: event.target.value })}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
            DE · Deutsch
          </span>
          <Input
            value={value.de}
            onChange={(event) => onChange({ ...value, de: event.target.value })}
          />
        </label>
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
    <fieldset className="grid min-w-0 gap-2">
      <legend className="sr-only">{label}</legend>
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="flex items-center justify-between gap-3 border-b bg-muted/20 px-3 py-2">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {selected.length.toLocaleString()} selected
          </span>
        </div>
        {options.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">{emptyHint}</p>
        ) : (
          <div className="grid gap-px bg-border sm:grid-cols-2">
            {options.map((option) => {
              const checked = selected.includes(option);
              return (
                <label
                  key={option}
                  className={cn(
                    "flex min-h-10 min-w-0 items-center gap-2 bg-background px-3 py-2 text-sm transition-colors hover:bg-muted/40",
                    checked && "bg-primary/5"
                  )}
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-primary"
                    checked={checked}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...selected, option]
                          : selected.filter((entry) => entry !== option)
                      )
                    }
                  />
                  <span className="min-w-0 break-words font-mono text-xs leading-5">{option}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>
      {hint ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          {hint}
        </p>
      ) : null}
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
    <section className="grid gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Prompts</span>
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
        <div key={index} className="grid gap-3 rounded-lg border bg-muted/10 p-3 sm:p-4">
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
