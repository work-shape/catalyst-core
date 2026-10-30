import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";
import { TextDiff } from "../data/text-diff";
import { SegmentedControl, SegmentedControlItem } from "../navigation/segmented-control";
import { useUiLabels } from "../ui-root";

/** Which version of a field's text shows: the draft to edit, what is live, or what changed. */
export type TextVersion = "draft" | "live" | "changes";

export interface TextVersionSwitchProps {
  /** The field's label: the switch is named after it. */
  label: string;
  value: TextVersion;
  onValueChange(value: TextVersion): void;
  /**
   * Offers "Changes" too. A text of one line leaves it out: its live version already shows
   * what changed.
   */
  changes?: boolean;
}

const VERSIONS: readonly TextVersion[] = ["draft", "live", "changes"];

/**
 * "Draft | Live | Changes" beside a field's label, as `Field`'s `labelEnd`: which version of
 * the text the field shows. It belongs to one `VersionedText`.
 */
export function TextVersionSwitch({
  label,
  value,
  onValueChange,
  changes = true
}: TextVersionSwitchProps) {
  const labels = useUiLabels("TextVersionSwitch");
  return (
    <SegmentedControl
      size="sm"
      label={labels.versionOf.replace("{label}", label)}
      value={value}
      data-text-version-switch=""
      onValueChange={(next) => onValueChange(VERSIONS.find((each) => each === next) ?? "draft")}
    >
      <SegmentedControlItem value="draft">{labels.versionDraft}</SegmentedControlItem>
      <SegmentedControlItem value="live">{labels.versionLive}</SegmentedControlItem>
      {changes ? (
        <SegmentedControlItem value="changes">{labels.versionChanges}</SegmentedControlItem>
      ) : null}
    </SegmentedControl>
  );
}

export interface VersionedTextProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** The field's label, which names the live text and the changes for assistive technology. */
  label: string;
  view: TextVersion;
  /** The text as it is live. */
  live: string;
  /** The text of the draft, which the control edits. */
  draft: string;
  /** The live text in the monospaced type, as a `Textarea` of the `code` variant has it. */
  mono?: boolean;
  /** The text as long as one line: the live text does not wrap, and is cut where it is long. */
  singleLine?: boolean;
  /** The control that edits the draft: a `Textarea` or an `Input`. */
  children: ReactNode;
}

/**
 * The box of a field that has a live version. The control that edits the draft keeps its place
 * and its height whichever version shows: the live text and the changed lines stand in the same
 * box, in the same type, and scroll inside it, so the page never grows. "Changes" shows only the
 * lines that differ.
 */
export function VersionedText({
  label,
  view,
  live,
  draft,
  mono = false,
  singleLine = false,
  className,
  children,
  ...props
}: VersionedTextProps) {
  const labels = useUiLabels("VersionedText");
  const covered = view !== "draft";
  return (
    <div data-versioned-text={view} className={cn("relative grid min-w-0", className)} {...props}>
      <div className={cn("grid min-w-0", covered && "invisible")} inert={covered}>
        {children}
      </div>
      {view === "live" ? (
        <div
          role="region"
          aria-label={`${label}: ${labels.versionLive}`}
          tabIndex={0}
          data-versioned-text-live=""
          className={cn(
            "absolute inset-0 overflow-auto rounded-md border border-border bg-muted/40 text-foreground outline-none focus-visible:focus-field",
            singleLine
              ? "flex items-center truncate px-3 whitespace-pre"
              : "px-3 py-2 whitespace-pre-wrap wrap-anywhere",
            mono ? "font-mono text-code" : "text-body"
          )}
        >
          {live}
        </div>
      ) : null}
      {view === "changes" ? (
        <div
          role="region"
          aria-label={`${label}: ${labels.versionChanges}`}
          tabIndex={0}
          data-versioned-text-changes=""
          className="absolute inset-0 overflow-auto rounded-md border border-border bg-background outline-none focus-visible:focus-field"
        >
          <TextDiff before={live} after={draft} context={0} />
        </div>
      ) : null}
    </div>
  );
}
