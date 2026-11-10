import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../cn";
import { Spinner } from "../feedback/spinner";
import { menuGroupHeadingClassName, menuRowClassName } from "./dropdown-menu";
import { anchoredListPanelClassName } from "./popover";

export interface SuggestionListOption {
  id: string;
  /** The object's name. */
  label: string;
  /** One line under the name, such as an email address. */
  description?: string;
  /** An avatar or an icon before the name. */
  leading?: ReactNode;
  /** A short word after the name, such as "has access". */
  trailing?: ReactNode;
  /** Shown and read out, never chosen. */
  disabled?: boolean;
}

export interface SuggestionListProps {
  /** The list's element id, which the text field names in `aria-controls`. */
  id: string;
  /** Names the list for assistive technology: "People". */
  label: string;
  options: readonly SuggestionListOption[];
  /** The option the keys stand on. The field keeps the focus and names it as active. */
  activeId?: string;
  /** The pointer moved onto an option. */
  onActiveChange?(id: string): void;
  onSelect(id: string): void;
  /** A group heading above the options, such as "Likely people". */
  heading?: string;
  /** The options are on their way: a small spinner shows beside the heading. */
  loading?: boolean;
  /** Stands in place of the options when there are none, such as why the list is empty. */
  empty?: ReactNode;
  /** A last part under the options, such as a way to do something else instead. */
  footer?: ReactNode;
  /**
   * `raised`: a panel that stands over what is below, placed by the caller, such as above a
   * message field. `inline`: the rows alone, within a dialog or a panel.
   */
  surface?: "raised" | "inline";
  className?: string;
}

/** The element id of an option, for the field's `aria-activedescendant`. */
export function suggestionOptionId(listId: string, optionId: string): string {
  return `${listId}-option-${optionId}`;
}

/**
 * The option `steps` away from the active one among those that can be chosen, wrapping round
 * at either end: what the arrow keys move to. The first one where none is active.
 */
export function nextSuggestion(
  options: readonly SuggestionListOption[],
  activeId: string | undefined,
  steps: number
): string | undefined {
  const choosable = options.filter((option) => !option.disabled);
  if (choosable.length === 0) return undefined;
  const at = choosable.findIndex((option) => option.id === activeId);
  if (at < 0) return (steps < 0 ? choosable.at(-1) : choosable[0])?.id;
  return choosable[(at + steps + choosable.length * Math.abs(steps)) % choosable.length]?.id;
}

/**
 * A list that a text field offers as one types, such as the people an @ names. The field keeps
 * the focus: it moves `activeId` with the arrow keys and chooses with Enter, and the list shows
 * the active option and keeps it in view. A pointer chooses without taking the focus away.
 */
export function SuggestionList({
  id,
  label,
  options,
  activeId,
  onActiveChange,
  onSelect,
  heading,
  loading = false,
  empty,
  footer,
  surface = "raised",
  className
}: SuggestionListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeId === undefined) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[id="${CSS.escape(suggestionOptionId(id, activeId))}"]`
    );
    row?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, id]);

  return (
    <div
      data-suggestion-list={surface}
      className={cn(
        "flex min-w-0 flex-col",
        surface === "raised" && cn(anchoredListPanelClassName, "max-h-72 w-72"),
        className
      )}
    >
      {heading !== undefined || loading ? (
        <div className={cn(menuGroupHeadingClassName, "flex items-center gap-2")}>
          <span className="min-w-0 flex-1 truncate">{heading}</span>
          {loading ? <Spinner size="xs" className="shrink-0" /> : null}
        </div>
      ) : null}
      <div
        ref={listRef}
        id={id}
        role="listbox"
        aria-label={label}
        aria-busy={loading || undefined}
        className={cn(
          "min-h-0 overflow-y-auto",
          surface === "raised" ? "px-1 pb-1" : "",
          options.length === 0 && "hidden"
        )}
      >
        {options.map((option) => {
          const active = option.id === activeId;
          return (
            <div
              key={option.id}
              id={suggestionOptionId(id, option.id)}
              role="option"
              aria-selected={active}
              aria-disabled={option.disabled || undefined}
              data-active={active ? "" : undefined}
              className={cn(
                menuRowClassName,
                "data-active:bg-state-hover",
                option.disabled ? "text-muted-foreground" : "cursor-pointer"
              )}
              // The field keeps the focus: a press here neither blurs it nor closes the list.
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => {
                if (!active && !option.disabled) onActiveChange?.(option.id);
              }}
              onClick={() => {
                if (!option.disabled) onSelect(option.id);
              }}
            >
              {option.leading}
              <span className="grid min-w-0 flex-1">
                <span className="truncate">{option.label}</span>
                {option.description === undefined ? null : (
                  <span className="truncate text-caption text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
              {option.trailing === undefined ? null : (
                <span className="shrink-0 text-caption text-muted-foreground">
                  {option.trailing}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {options.length === 0 && empty !== undefined ? (
        <div
          className={cn(
            "text-body text-muted-foreground",
            surface === "raised" ? "px-3 pt-1 pb-3" : "px-2 py-2"
          )}
          role="status"
        >
          {empty}
        </div>
      ) : null}
      {footer === undefined ? null : (
        <div className={cn("shrink-0 border-t", surface === "raised" ? "p-1" : "pt-1")}>
          {footer}
        </div>
      )}
    </div>
  );
}
