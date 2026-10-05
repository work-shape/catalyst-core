import { Ban, Check, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import type { ConversationListItem } from "@vivd-catalyst/api-client";
import { useTranslation, type TranslationKey } from "../i18n";
import { Input } from "../ui/input";
import { cn } from "../ui/cn";
import { useScrollEdgeFade } from "../ui/scroll-edge-fade";
import {
  collaborationWorkspaceAccentAttributes,
  collaborationWorkspaceAccentColors,
  type CollaborationWorkspaceAccentColor
} from "./collaboration-workspace-accent";
import {
  collaborationWorkspaceEmojiChoices,
  collaborationWorkspaceEmojiSuggestions
} from "./collaboration-workspace-emoji";

export type CollaborationWorkspaceVisibility = "discoverable" | "private";
export type ConversationVisibility = ConversationListItem["visibility"];

const accentLabelKeys: Record<CollaborationWorkspaceAccentColor, TranslationKey> = {
  garnet: "collaborationWorkspaceAccentGarnet",
  ruby: "collaborationWorkspaceAccentRuby",
  mahogany: "collaborationWorkspaceAccentMahogany",
  copper: "collaborationWorkspaceAccentCopper",
  amber: "collaborationWorkspaceAccentAmber",
  olive: "collaborationWorkspaceAccentOlive",
  jade: "collaborationWorkspaceAccentJade",
  emerald: "collaborationWorkspaceAccentEmerald",
  teal: "collaborationWorkspaceAccentTeal",
  turquoise: "collaborationWorkspaceAccentTurquoise",
  azure: "collaborationWorkspaceAccentAzure",
  sapphire: "collaborationWorkspaceAccentSapphire",
  indigo: "collaborationWorkspaceAccentIndigo",
  violet: "collaborationWorkspaceAccentViolet",
  magenta: "collaborationWorkspaceAccentMagenta",
  rose: "collaborationWorkspaceAccentRose",
  stone: "collaborationWorkspaceAccentStone",
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

  return (
    <ChoiceField
      name="collaboration-workspace-visibility"
      legend={t("collaborationWorkspaceVisibilityLabel")}
      value={value}
      disabled={disabled}
      options={[
        {
          value: "discoverable",
          label: t("collaborationWorkspaceVisibilityDiscoverable"),
          hint: t("collaborationWorkspaceVisibilityDiscoverableHint")
        },
        {
          value: "private",
          label: t("collaborationWorkspaceVisibilityPrivate"),
          hint: t("collaborationWorkspaceVisibilityPrivateHint")
        }
      ]}
      onChange={onChange}
    />
  );
}

/** What a Shared Workspace stamps onto the conversations started in it. */
export function CollaborationWorkspaceConversationVisibilityField({
  value,
  disabled,
  onChange
}: {
  value: ConversationVisibility;
  disabled?: boolean;
  onChange(value: ConversationVisibility): void;
}) {
  const { t } = useTranslation();

  return (
    <ChoiceField
      name="collaboration-workspace-conversation-visibility"
      legend={t("collaborationWorkspaceConversationVisibilityLabel")}
      help={t("collaborationWorkspaceConversationVisibilityHelp")}
      value={value}
      disabled={disabled}
      options={[
        {
          value: "workspace",
          label: t("collaborationWorkspaceConversationVisibilityWorkspace"),
          hint: t("collaborationWorkspaceConversationVisibilityWorkspaceHint")
        },
        {
          value: "private",
          label: t("collaborationWorkspaceConversationVisibilityPrivate"),
          hint: t("collaborationWorkspaceConversationVisibilityPrivateHint")
        }
      ]}
      onChange={onChange}
    />
  );
}

/** A radio group drawn as bordered cards, each with a label and one hint line. */
export function ChoiceField<Value extends string>({
  name,
  legend,
  help,
  value,
  options,
  disabled,
  onChange
}: {
  name: string;
  legend: string;
  help?: string;
  value: Value;
  options: Array<{ value: Value; label: string; hint: string }>;
  disabled?: boolean;
  onChange(value: Value): void;
}) {
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="pb-2 text-sm font-medium">{legend}</legend>
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
            name={name}
            className="mt-1 size-4 accent-[var(--primary)]"
            checked={value === option.value}
            value={option.value}
            onChange={() => onChange(option.value)}
          />
          <span className="grid gap-1">
            <span className="text-sm font-medium">{option.label}</span>
            <span className="text-xs leading-5 text-muted-foreground">{option.hint}</span>
          </span>
        </label>
      ))}
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
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
  /*
   * Collapsed on every dialog opening: both dialogs mount their surface fresh,
   * so the initial state is all the reset this needs.
   */
  const [moreOpen, setMoreOpen] = useState(false);
  const emojiInputId = "collaboration-workspace-emoji";
  const emojiGridId = "collaboration-workspace-emoji-grid";

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
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label={t("collaborationWorkspaceEmojiSuggestions")}
        >
          <button
            type="button"
            disabled={disabled}
            aria-pressed={value === ""}
            aria-label={t("collaborationWorkspaceEmojiNone")}
            title={t("collaborationWorkspaceEmojiNone")}
            data-testid="collaboration-workspace-emoji-none"
            className={cn(
              "grid size-8 place-items-center rounded-md border border-dashed text-muted-foreground outline-none transition-colors",
              "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50",
              value === "" && "border-ring border-solid bg-accent"
            )}
            onClick={() => onChange("")}
          >
            <Ban size={14} aria-hidden="true" />
          </button>
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
          <button
            type="button"
            disabled={disabled}
            aria-expanded={moreOpen}
            aria-controls={emojiGridId}
            data-testid="collaboration-workspace-emoji-more"
            className={cn(
              "flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium outline-none transition-colors",
              "text-muted-foreground hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40",
              "disabled:opacity-50",
              moreOpen && "border-ring bg-accent text-foreground"
            )}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <span>
              {moreOpen
                ? t("collaborationWorkspaceEmojiLess")
                : t("collaborationWorkspaceEmojiMore")}
            </span>
            {moreOpen ? (
              <ChevronUp size={12} aria-hidden="true" />
            ) : (
              <ChevronDown size={12} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      {moreOpen ? (
        <CollaborationWorkspaceEmojiGrid
          id={emojiGridId}
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}
    </div>
  );
}

/**
 * The full emoji list behind the "More" toggle. Tiles behave exactly like the
 * quick picks, so the live avatar preview and the free-text field stay in sync.
 */
export function CollaborationWorkspaceEmojiGrid({
  id,
  value,
  disabled,
  onChange
}: {
  id?: string;
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  const { t } = useTranslation();
  const fade = useScrollEdgeFade<HTMLDivElement>();

  return (
    /*
      The frame carries the rounded border; the scrolling grid sits inside its
      padding so the scrollbar thumb never runs under the corner radius.

      The height is an exact row count so the cut never lands mid-emoji: a h-7
      tile plus a gap-1 row gap is a 2rem pitch, and the p-1 top padding shifts
      every row boundary by the same 0.25rem the bottom padding gives back. Six
      rows therefore end at 6 * 2rem + 0.25rem, exactly where row seven starts.
      The edge fade then says whether row seven exists at all.
    */
    <div className="rounded-md border p-1">
      <div
        ref={fade.ref}
        style={fade.style}
        id={id}
        role="group"
        aria-label={t("collaborationWorkspaceEmojiMoreLabel")}
        data-testid="collaboration-workspace-emoji-grid"
        data-overflow-below={fade.overflow.below ? "true" : "false"}
        className="chat-scrollbar max-h-[12.25rem] overflow-y-auto p-1"
        onScroll={fade.onScroll}
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(1.75rem,1fr))] content-start gap-1">
          {collaborationWorkspaceEmojiChoices.map((emoji) => (
            <button
              key={emoji}
              type="button"
              disabled={disabled}
              aria-pressed={value === emoji}
              data-testid="collaboration-workspace-emoji-choice"
              className={cn(
                "grid h-7 w-full place-items-center rounded-md border text-base outline-none transition-colors",
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
        /*
          Fixed 2rem columns so the swatches line up in a grid rather than a
          ragged wrap. The cap is nine columns exactly (9 x 2rem + 8 x 0.5rem),
          which splits the palette into even rows on a roomy dialog and lets
          auto-fill drop to fewer columns on a narrow one.
        */
        className="grid max-w-[22rem] grid-cols-[repeat(auto-fill,2rem)] gap-2"
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
