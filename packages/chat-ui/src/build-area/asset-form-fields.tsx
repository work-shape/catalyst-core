import { Plus } from "lucide-react";
import { Banner, Button, Chip, cn, ConfirmDialog, Input } from "@vivd-catalyst/ui";
import {
  LANGUAGE_CODE_LABELS,
  type AgentFormState,
  type LocalizedPair
} from "./config-assets-model";
import { useTranslation } from "../i18n";

export { Field } from "@vivd-catalyst/ui";

export function LocalizedField({
  label,
  required,
  disabled,
  value,
  onChange
}: {
  label: string;
  required?: boolean;
  disabled?: boolean;
  value: LocalizedPair;
  onChange(value: LocalizedPair): void;
}) {
  const { t } = useTranslation();

  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1.5">
          <span className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
            {LANGUAGE_CODE_LABELS.en} · {t("configEnglishLanguage")}
          </span>
          <Input
            value={value.en}
            required={required && !value.de.trim()}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, en: event.target.value })}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
            {LANGUAGE_CODE_LABELS.de} · {t("configGermanLanguage")}
          </span>
          <Input
            value={value.de}
            disabled={disabled}
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
  optionLabel,
  selected,
  unavailable = [],
  emptyHint,
  hint,
  disabled,
  onChange
}: {
  label: string;
  options: string[];
  /** Human-readable text for options that are ids rather than names. */
  optionLabel?: (option: string) => string;
  selected: string[];
  /**
   * Selected entries that are no longer on offer, each with the reason. They are shown as
   * selected and can only be removed.
   */
  unavailable?: readonly { option: string; reason: string }[];
  emptyHint: string;
  hint?: string;
  disabled?: boolean;
  onChange(selected: string[]): void;
}) {
  const { locale, t } = useTranslation();
  const stale = unavailable.filter((entry) => selected.includes(entry.option));

  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="sr-only">{label}</legend>
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="flex items-center justify-between gap-3 border-b bg-muted/20 px-3 py-2">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("configSelectedCount", { count: selected.length.toLocaleString(locale) })}
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
                    checked && "bg-muted/30"
                  )}
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-primary"
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...selected, option]
                          : selected.filter((entry) => entry !== option)
                      )
                    }
                  />
                  <span
                    className={cn(
                      "min-w-0 break-words leading-5",
                      optionLabel ? "text-sm" : "font-mono text-xs"
                    )}
                  >
                    {optionLabel ? optionLabel(option) : option}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {stale.length > 0 ? (
          <ul
            aria-label={t("configUnavailableSelections")}
            className="grid gap-2 border-t px-3 py-2.5"
          >
            {stale.map((entry) => (
              <li
                key={entry.option}
                data-unavailable-option={entry.option}
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
              >
                <Chip
                  size="sm"
                  className="font-mono"
                  onRemove={
                    disabled
                      ? undefined
                      : () => onChange(selected.filter((option) => option !== entry.option))
                  }
                >
                  {entry.option}
                </Chip>
                <span className="text-caption text-muted-foreground">{entry.reason}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {hint ? <Banner tone="warning">{hint}</Banner> : null}
    </fieldset>
  );
}

export function InitialPromptsEditor({
  prompts,
  disabled,
  onChange
}: {
  prompts: AgentFormState["initialPrompts"];
  disabled?: boolean;
  onChange(prompts: AgentFormState["initialPrompts"]): void;
}) {
  const { t } = useTranslation();

  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{t("configPrompts")}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            onChange([...prompts, { title: { en: "", de: "" }, prompt: { en: "", de: "" } }])
          }
        >
          <Plus size={14} aria-hidden="true" />
          {t("configAddPrompt")}
        </Button>
      </div>
      {prompts.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("configOptionalPrompts")}</p>
      ) : null}
      {prompts.map((prompt, index) => (
        <div key={index} className="grid gap-3 rounded-lg border bg-muted/10 p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t("configPromptNumber", { number: index + 1 })}
            </span>
            <button
              type="button"
              className="text-xs text-muted-foreground transition-colors hover:text-destructive"
              disabled={disabled}
              onClick={() => onChange(prompts.filter((_, promptIndex) => promptIndex !== index))}
            >
              {t("configRemove")}
            </button>
          </div>
          <LocalizedField
            label={t("configTitle")}
            value={prompt.title}
            disabled={disabled}
            onChange={(title) =>
              onChange(
                prompts.map((entry, promptIndex) =>
                  promptIndex === index ? { ...entry, title } : entry
                )
              )
            }
          />
          <LocalizedField
            label={t("configPrompt")}
            value={prompt.prompt}
            disabled={disabled}
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
  kind,
  name,
  onConfirm
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  kind: "agent" | "skill";
  name: string;
  onConfirm(): void;
}) {
  const { t } = useTranslation();
  const title = t(kind === "agent" ? "configDeleteAgentTitle" : "configDeleteSkillTitle", {
    name
  });

  return (
    <ConfirmDialog
      open={open}
      title={title}
      confirmLabel={t("configDelete")}
      onConfirm={onConfirm}
      onClose={() => onOpenChange(false)}
    >
      {t(kind === "agent" ? "configDeleteAgentDescription" : "configDeleteSkillDescription")}
    </ConfirmDialog>
  );
}
