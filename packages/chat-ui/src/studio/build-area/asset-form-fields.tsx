import { Plus, X } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import {
  Banner,
  Button,
  Checkbox,
  Chip,
  Field,
  FormNotice,
  IconButton,
  Input
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { AgentFormState, LocalizedPair } from "./asset-form-model";

type AssetLanguage = keyof LocalizedPair;

const AssetLanguageContext = createContext<AssetLanguage>("en");

/** Sets the language every localized field of the page shows. The page has one switch for it. */
export const AssetLanguageProvider = AssetLanguageContext.Provider;

/**
 * One text that is written per language. It shows the language the page is switched to. Left
 * empty there, people read the text of the other language, and the field says so.
 */
export function LocalizedField({
  label,
  required,
  readOnly,
  value,
  onChange
}: {
  label: string;
  required?: boolean;
  /** The text is shown to be read: the field keeps its full strength and asks for nothing. */
  readOnly?: boolean;
  value: LocalizedPair;
  onChange(value: LocalizedPair): void;
}) {
  const { t } = useTranslation();
  const language = useContext(AssetLanguageContext);
  const other = language === "en" ? "de" : "en";
  const fallback = value[language].trim() ? "" : value[other].trim();

  return (
    <Field
      label={label}
      required={required && !fallback && !readOnly}
      hint={
        fallback ? t(other === "en" ? "build.fallbackEnglish" : "build.fallbackGerman") : undefined
      }
    >
      <Input
        lang={language}
        value={value[language]}
        placeholder={fallback}
        readOnly={readOnly}
        onChange={(event) => onChange({ ...value, [language]: event.target.value })}
      />
    </Field>
  );
}

/** What a refused save says about one field, under that field. */
export function FieldRefusals({ messages }: { messages: readonly string[] }) {
  return messages.length > 0 ? (
    <div className="grid gap-1" data-field-refusal="">
      {messages.map((message) => (
        <FormNotice key={message} tone="error">
          {message}
        </FormNotice>
      ))}
    </div>
  ) : null;
}

export function CheckboxGroup({
  label,
  description,
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
  /**
   * One line under the label. With it the label is a heading that shows, for a group that
   * stands beside other groups of its section.
   */
  description?: string;
  options: readonly string[];
  /** Human-readable text for options that are ids rather than names. */
  optionLabel?: (option: string) => string;
  selected: readonly string[];
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
  const { t } = useTranslation();
  const stale = unavailable.filter((entry) => selected.includes(entry.option));

  return (
    <fieldset className="grid min-w-0 gap-3">
      <legend className={description ? "text-label" : "sr-only"}>{label}</legend>
      {description ? <p className="text-caption text-muted-foreground">{description}</p> : null}
      {options.length === 0 ? (
        <p className="text-body text-muted-foreground">{emptyHint}</p>
      ) : (
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {options.map((option) => (
            <Checkbox
              key={option}
              checked={selected.includes(option)}
              disabled={disabled}
              label={
                optionLabel ? optionLabel(option) : <code className="font-mono">{option}</code>
              }
              onCheckedChange={(checked) =>
                onChange(
                  checked ? [...selected, option] : selected.filter((entry) => entry !== option)
                )
              }
            />
          ))}
        </div>
      )}
      {stale.length > 0 ? (
        <ul aria-label={t("configUnavailableSelections")} className="grid gap-2">
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
  const replace = (index: number, patch: Partial<AgentFormState["initialPrompts"][number]>) =>
    onChange(prompts.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)));

  return (
    <div className="grid gap-4">
      {prompts.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("configOptionalPrompts")}</p>
      ) : null}
      {prompts.map((prompt, index) => (
        <PromptCard
          key={index}
          title={t("configPromptNumber", { number: index + 1 })}
          remove={
            disabled ? null : (
              <IconButton
                label={t("build.removePrompt", { number: index + 1 })}
                size="sm"
                onClick={() => onChange(prompts.filter((_, at) => at !== index))}
              >
                <X aria-hidden="true" />
              </IconButton>
            )
          }
        >
          <LocalizedField
            label={t("configTitle")}
            value={prompt.title}
            readOnly={disabled}
            onChange={(title) => replace(index, { title })}
          />
          <LocalizedField
            label={t("configPrompt")}
            value={prompt.prompt}
            readOnly={disabled}
            onChange={(value) => replace(index, { prompt: value })}
          />
        </PromptCard>
      ))}
      {disabled ? null : (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() =>
            onChange([...prompts, { title: { en: "", de: "" }, prompt: { en: "", de: "" } }])
          }
        >
          <Plus aria-hidden="true" />
          {t("configAddPrompt")}
        </Button>
      )}
    </div>
  );
}

function PromptCard({
  title,
  remove,
  children
}: {
  title: string;
  remove: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className="grid gap-3 rounded-md border p-4">
      <legend className="sr-only">{title}</legend>
      <div className="flex items-center justify-between gap-2">
        <span className="text-label text-muted-foreground">{title}</span>
        {remove}
      </div>
      {children}
    </fieldset>
  );
}
