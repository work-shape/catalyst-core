import { Check } from "lucide-react";
import { useTranslation, type TranslationKey } from "../i18n";
import { Input } from "../ui/input";
import { cn } from "../ui/cn";
import {
  collaborationWorkspaceAccentAttributes,
  collaborationWorkspaceAccentColors,
  type CollaborationWorkspaceAccentColor
} from "./collaboration-workspace-accent";

export type CollaborationWorkspaceVisibility = "discoverable" | "private";

export const collaborationWorkspaceEmojiSuggestions = [
  "🚀",
  "📈",
  "🧭",
  "🧪",
  "🏗️",
  "💡",
  "📚",
  "🤝"
] as const;

const accentLabelKeys: Record<CollaborationWorkspaceAccentColor, TranslationKey> = {
  ruby: "collaborationWorkspaceAccentRuby",
  amber: "collaborationWorkspaceAccentAmber",
  emerald: "collaborationWorkspaceAccentEmerald",
  sapphire: "collaborationWorkspaceAccentSapphire",
  violet: "collaborationWorkspaceAccentViolet",
  rose: "collaborationWorkspaceAccentRose",
  teal: "collaborationWorkspaceAccentTeal",
  slate: "collaborationWorkspaceAccentSlate"
};

export function CollaborationWorkspaceVisibilityField({
  value,
  disabled,
  onChange
}: {
  value: CollaborationWorkspaceVisibility;
  disabled?: boolean;
  onChange(value: CollaborationWorkspaceVisibility): void;
}) {
  const { t } = useTranslation();
  const options: Array<{
    value: CollaborationWorkspaceVisibility;
    label: TranslationKey;
    hint: TranslationKey;
  }> = [
    {
      value: "discoverable",
      label: "collaborationWorkspaceVisibilityDiscoverable",
      hint: "collaborationWorkspaceVisibilityDiscoverableHint"
    },
    {
      value: "private",
      label: "collaborationWorkspaceVisibilityPrivate",
      hint: "collaborationWorkspaceVisibilityPrivateHint"
    }
  ];

  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="pb-2 text-sm font-medium">
        {t("collaborationWorkspaceVisibilityLabel")}
      </legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 rounded-md border p-3 transition-colors",
            value === option.value ? "border-ring bg-accent/50" : "hover:bg-accent/30"
          )}
        >
          <input
            type="radio"
            name="collaboration-workspace-visibility"
            className="mt-1 size-4 accent-[var(--primary)]"
            checked={value === option.value}
            value={option.value}
            onChange={() => onChange(option.value)}
          />
          <span className="grid gap-1">
            <span className="text-sm font-medium">{t(option.label)}</span>
            <span className="text-xs leading-5 text-muted-foreground">{t(option.hint)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function CollaborationWorkspaceEmojiField({
  value,
  disabled,
  onChange
}: {
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  const { t } = useTranslation();
  const emojiInputId = "collaboration-workspace-emoji";

  return (
    <div className="grid gap-2">
      <label className="text-sm font-medium" htmlFor={emojiInputId}>
        {t("collaborationWorkspaceEmojiLabel")}
      </label>
      <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
        <Input
          id={emojiInputId}
          value={value}
          maxLength={8}
          disabled={disabled}
          className="text-center text-lg"
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t("collaborationWorkspaceEmojiSuggestions")}
        >
          {collaborationWorkspaceEmojiSuggestions.map((emoji) => (
            <button
              key={emoji}
              type="button"
              disabled={disabled}
              aria-pressed={value === emoji}
              className={cn(
                "grid size-8 place-items-center rounded-md border text-base outline-none transition-colors",
                "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50",
                value === emoji && "border-ring bg-accent"
              )}
              onClick={() => onChange(value === emoji ? "" : emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CollaborationWorkspaceAccentField({
  value,
  disabled,
  onChange
}: {
  value: CollaborationWorkspaceAccentColor;
  disabled?: boolean;
  onChange(value: CollaborationWorkspaceAccentColor): void;
}) {
  const { t } = useTranslation();

  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium">{t("collaborationWorkspaceAccentLabel")}</span>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={t("collaborationWorkspaceAccentLabel")}
      >
        {collaborationWorkspaceAccentColors.map((accentColor) => {
          const accentAttributes = collaborationWorkspaceAccentAttributes(accentColor, {
            background: "var(--collaboration-workspace-accent-surface)",
            color: "var(--collaboration-workspace-accent-on-surface)"
          });
          const selected = value === accentColor;
          return (
            <button
              {...accentAttributes}
              key={accentColor}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              aria-label={t(accentLabelKeys[accentColor])}
              title={t(accentLabelKeys[accentColor])}
              data-testid={`collaboration-workspace-accent-${accentColor}`}
              className={cn(
                "grid size-8 place-items-center rounded-full outline-none transition-transform",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
                selected && "ring-2 ring-ring ring-offset-2 ring-offset-card"
              )}
              onClick={() => onChange(accentColor)}
            >
              {selected ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
