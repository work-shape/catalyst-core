import { Command } from "cmdk";
import { Check, Plus, Search } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject
} from "react";
import { cn } from "../cn";
import { useScrollEdgeFade } from "../scroll-edge-fade";
import { useOverlayContainer, useUiLabels } from "../ui-root";
import { menuGroupHeadingClassName, menuRowClassName } from "./dropdown-menu";
import { ANCHORED_COLLISION_PADDING, anchoredPanelClassName } from "./popover";

export interface PickerOption {
  value: string;
  /** The object's name. It is shown as text and searched. */
  label: string;
  /** One line under the name. It is shown as text and searched. */
  description?: string;
  /** An avatar or an icon before the name. */
  leading?: ReactNode;
  /** A chip or a badge after the name. */
  trailing?: ReactNode;
  disabled?: boolean;
  /** Why the option cannot be chosen now. It takes the description's place. */
  disabledReason?: string;
}

export interface PickerOptionGroup {
  heading: string;
  options: readonly PickerOption[];
}

export interface PickerCreateRow {
  /** Names what is created: "Create new agent". */
  label: string;
  /** Called with what the search field holds, so the new object can start with that name. */
  onSelect(search: string): void;
}

interface PickerBaseProps {
  /** The one element that opens the picker, usually a Button. */
  children: ReactNode;
  /** Options and groups of options. They show in this order, also while searching. */
  options: readonly (PickerOption | PickerOptionGroup)[];
  /**
   * Shows a search field that narrows the options to those containing what is typed. Without
   * it, typing moves to the first option whose name starts with what was typed.
   */
  search?: boolean;
  /** Names the list for assistive technology: "Select agent". */
  label?: string;
  /** Shows each description in full over several lines instead of cutting it to one. */
  wrapDescriptions?: boolean;
  /**
   * For a trigger that gives no hint of what it opens, such as an icon alone: a mouse pointing
   * at it opens the picker and leaving closes it. Focus stays where it was until the trigger is
   * pressed by keyboard or an arrow key moves into the list.
   */
  openOnHover?: boolean;
  /** A last row, pinned under the list, that creates a new object. */
  create?: PickerCreateRow;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}

export interface PickerSingleProps extends PickerBaseProps {
  multiple?: false;
  value: string | undefined;
  /** Choosing an option closes the picker. */
  onValueChange(value: string): void;
}

export interface PickerMultipleProps extends PickerBaseProps {
  multiple: true;
  value: readonly string[];
  /** Choosing an option adds or removes it and the picker stays open. */
  onValueChange(value: string[]): void;
}

export type PickerProps = PickerSingleProps | PickerMultipleProps;

// cmdk needs a value per row; no option can carry this one.
const CREATE_ROW_VALUE = "\u0000create";

/** A pause this long between two keys starts a new word for the type-ahead. */
const TYPE_AHEAD_RESET_MS = 700;

/**
 * A picker opened under the pointer stays this long once the pointer has left, so the pointer
 * can cross the gap between the trigger and the list.
 */
const HOVER_CLOSE_DELAY_MS = 150;

/** The row of a list that takes the arrow keys: the menu row with the hover fill when active. */
export const pickerRowClassName = cn(
  menuRowClassName,
  "data-[selected=true]:bg-state-hover data-[disabled=true]:text-muted-foreground"
);

/**
 * Chooses one object or several from a list: an agent, a workspace, an asset. The arrow keys
 * move through the options, Enter chooses, typing narrows the list or moves to a name, and
 * Escape closes the picker and returns focus to its trigger. A picker for one object opens on
 * the chosen option.
 */
export function Picker(props: PickerProps) {
  const {
    children,
    options,
    search = false,
    label,
    wrapDescriptions = false,
    openOnHover = false,
    create,
    open,
    defaultOpen = false,
    onOpenChange,
    side,
    align = "start",
    className
  } = props;
  const labels = useUiLabels("Picker");
  const container = useOverlayContainer("Picker");
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  // The row the arrow keys are on, once the keyboard, the pointer or the search has moved it.
  const [activeValue, setActiveValue] = useState<string>();
  const contentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeAhead = useRef({ text: "", at: 0 });
  // Set when the active row moved without cmdk's own arrow keys, which scroll by themselves.
  const revealsActiveRow = useRef(false);
  const hover = useRef<{
    /** What the mouse is over. */
    over: "trigger" | "panel" | undefined;
    closeTimer: number | undefined;
  }>({ over: undefined, closeTimer: undefined });
  // Opening moves focus into the picker, except under a mouse that only points at the trigger.
  const takesFocusOnOpen = useRef(true);
  // Closing returns focus to the trigger. Under `openOnHover` only when the picker had it.
  const returnsFocusOnClose = useRef(true);
  const isOpen = open ?? uncontrolledOpen;

  const cancelHoverClose = () => {
    window.clearTimeout(hover.current.closeTimer);
    hover.current.closeTimer = undefined;
  };
  useEffect(() => {
    const state = hover.current;
    return () => window.clearTimeout(state.closeTimer);
  }, []);

  const changeOpen = (next: boolean) => {
    cancelHoverClose();
    setUncontrolledOpen(next);
    revealsActiveRow.current = next;
    if (!next) {
      setQuery("");
      setActiveValue(undefined);
      typeAhead.current = { text: "", at: 0 };
      returnsFocusOnClose.current =
        !openOnHover || (contentRef.current?.contains(document.activeElement) ?? false);
      // A panel that goes away under the pointer reports no leave.
      if (hover.current.over === "panel") {
        hover.current.over = undefined;
      }
    }
    onOpenChange?.(next);
  };
  const isChosen = (option: PickerOption) =>
    props.multiple ? props.value.includes(option.value) : props.value === option.value;
  const choose = (option: PickerOption) => {
    if (props.multiple) {
      props.onValueChange(
        isChosen(option)
          ? props.value.filter((value) => value !== option.value)
          : [...props.value, option.value]
      );
      return;
    }
    props.onValueChange(option.value);
    changeOpen(false);
  };

  const visible = filterEntries(options, query);
  const choosable = visible
    .flatMap((entry) => (isGroup(entry) ? entry.options : [entry]))
    .filter((option) => !isDisabled(option));
  const chosenValue = props.multiple ? undefined : props.value;
  // cmdk takes the first row when it is handed none.
  const startValue = choosable.find((option) => option.value === chosenValue)?.value ?? "";

  const shownActiveValue = activeValue ?? startValue;

  const focusList = () => {
    (search ? contentRef.current?.querySelector("input") : listRef.current)?.focus();
  };
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (search) {
      return;
    }
    if (event.key === "Tab") {
      // Nothing in the list takes Tab, so it leaves the picker by closing it.
      event.preventDefault();
      changeOpen(false);
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const previous = typeAhead.current;
    const text =
      (event.timeStamp - previous.at > TYPE_AHEAD_RESET_MS ? "" : previous.text) +
      event.key.toLocaleLowerCase();
    if (text.trim() === "") {
      return;
    }
    typeAhead.current = { text, at: event.timeStamp };
    const match = typeAheadMatch(choosable, text, shownActiveValue);
    if (match) {
      revealsActiveRow.current = true;
      setActiveValue(match.value);
    }
  };

  const followMouse =
    (part: "trigger" | "panel", entered: boolean) => (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== "mouse") {
        return;
      }
      cancelHoverClose();
      if (!entered) {
        if (hover.current.over === part) {
          hover.current.over = undefined;
        }
        hover.current.closeTimer = window.setTimeout(() => {
          // The keyboard may be on an option: the picker then stays until focus leaves it too.
          if (!contentRef.current?.contains(document.activeElement)) {
            changeOpen(false);
          }
        }, HOVER_CLOSE_DELAY_MS);
        return;
      }
      hover.current.over = part;
      if (!isOpen) {
        takesFocusOnOpen.current = false;
        changeOpen(true);
      }
    };
  const pressTrigger = (event: ReactMouseEvent<HTMLElement>) => {
    const byKeyboard = event.detail === 0;
    const pointedAt = hover.current.over === "trigger";
    if (isOpen && pointedAt) {
      // The mouse that opened the picker keeps it open under a click.
      event.preventDefault();
      if (byKeyboard) {
        focusList();
      }
      return;
    }
    takesFocusOnOpen.current = byKeyboard || !pointedAt;
  };
  const arrowIntoList = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    if (isOpen) {
      focusList();
      return;
    }
    takesFocusOnOpen.current = true;
    changeOpen(true);
  };
  const hoverTriggerProps = openOnHover
    ? {
        onPointerEnter: followMouse("trigger", true),
        onPointerLeave: followMouse("trigger", false),
        onClick: pressTrigger
      }
    : {};
  const hoverContentProps = openOnHover
    ? { onPointerEnter: followMouse("panel", true), onPointerLeave: followMouse("panel", false) }
    : {};

  const fade = useScrollEdgeFade<HTMLDivElement>([visible.length, query, isOpen]);
  const renderOption = (option: PickerOption) => {
    const secondLine = option.disabledReason ?? option.description;
    return (
      <Command.Item
        key={option.value}
        value={option.value}
        disabled={isDisabled(option)}
        className={pickerRowClassName}
        onSelect={() => choose(option)}
      >
        {option.leading}
        <span className="grid min-w-0 flex-1">
          <span className="truncate">{option.label}</span>
          {secondLine === undefined ? null : (
            <span
              className={cn(
                "text-caption text-muted-foreground",
                wrapDescriptions ? "wrap-anywhere" : "truncate"
              )}
            >
              {secondLine}
            </span>
          )}
        </span>
        {option.trailing}
        {isChosen(option) ? <Check aria-hidden="true" /> : null}
      </Command.Item>
    );
  };

  return (
    <PopoverPrimitive.Root open={isOpen} onOpenChange={changeOpen}>
      <PopoverPrimitive.Trigger asChild onKeyDown={arrowIntoList} {...hoverTriggerProps}>
        {children}
      </PopoverPrimitive.Trigger>
      {container ? (
        <PopoverPrimitive.Portal container={container}>
          <PopoverPrimitive.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={ANCHORED_COLLISION_PADDING}
            className={cn(
              anchoredPanelClassName,
              "flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-76 max-w-(--radix-popover-content-available-width) flex-col overflow-hidden",
              className
            )}
            ref={contentRef}
            {...hoverContentProps}
            onOpenAutoFocus={(event) => {
              // Without a search field the list itself takes the keys.
              if (!search || !takesFocusOnOpen.current) {
                event.preventDefault();
              }
              if (!search && takesFocusOnOpen.current) {
                listRef.current?.focus();
              }
              takesFocusOnOpen.current = true;
            }}
            onCloseAutoFocus={(event) => {
              if (!returnsFocusOnClose.current) {
                event.preventDefault();
              }
            }}
          >
            <Command
              shouldFilter={false}
              loop
              value={shownActiveValue}
              className="flex min-h-0 flex-1 flex-col"
              onValueChange={setActiveValue}
              onKeyDown={onListKeyDown}
            >
              {search ? (
                <PickerSearchField
                  value={query}
                  label={labels.search}
                  placeholder={labels.search}
                  onValueChange={setQuery}
                />
              ) : null}
              <Command.List
                ref={listRef}
                label={label}
                className="flex min-h-0 flex-1 flex-col outline-none *:flex *:min-h-0 *:flex-1 *:flex-col"
              >
                <div
                  ref={fade.ref}
                  style={fade.style}
                  className="min-h-0 flex-1 overflow-y-auto p-1 [scrollbar-width:thin]"
                  onScroll={fade.onScroll}
                >
                  {visible.map((entry) =>
                    isGroup(entry) ? (
                      <Command.Group
                        key={entry.heading}
                        heading={<div className={menuGroupHeadingClassName}>{entry.heading}</div>}
                      >
                        {entry.options.map(renderOption)}
                      </Command.Group>
                    ) : (
                      renderOption(entry)
                    )
                  )}
                  {visible.length === 0 ? (
                    <p className="px-2 py-6 text-center text-body text-muted-foreground">
                      {labels.noResults}
                    </p>
                  ) : null}
                </div>
                {create === undefined ? null : (
                  <div className="shrink-0 border-t p-1">
                    <Command.Item
                      value={CREATE_ROW_VALUE}
                      className={pickerRowClassName}
                      onSelect={() => {
                        create.onSelect(query.trim());
                        changeOpen(false);
                      }}
                    >
                      <Plus aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{create.label}</span>
                    </Command.Item>
                  </div>
                )}
              </Command.List>
              <ActiveRowName
                value={shownActiveValue}
                listRef={listRef}
                reveals={revealsActiveRow}
              />
            </Command>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      ) : null}
    </PopoverPrimitive.Root>
  );
}

/** The search field over a list that takes the arrow keys. It sits on the list's top edge. */
export function PickerSearchField({
  value,
  label,
  placeholder,
  inputRef,
  onValueChange
}: {
  value: string;
  /** Names the field for assistive technology. */
  label: string;
  placeholder: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  onValueChange(value: string): void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-3 text-muted-foreground">
      <Search aria-hidden="true" className="size-4 shrink-0" />
      <Command.Input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        className="h-control-md min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
        onValueChange={onValueChange}
      />
    </div>
  );
}

/**
 * cmdk names the active row to assistive technology only once a key or the pointer has moved
 * it. The picker also opens on the chosen option and moves to a typed name, so it names the row
 * itself, on the element that has the keyboard. It stands after the list, so the list and its
 * rows are in the document, with their values, by the time it looks for one.
 */
function ActiveRowName({
  value,
  listRef,
  reveals
}: {
  value: string;
  listRef: RefObject<HTMLDivElement | null>;
  /** True when the row may be outside the list's scroller: on opening and after a typed name. */
  reveals: RefObject<boolean>;
}) {
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = Array.from(list?.querySelectorAll("[cmdk-item]") ?? []).find(
      (item) => item.getAttribute("data-value") === value
    );
    if (!list || !row) {
      return undefined;
    }
    const searchField = list.closest("[cmdk-root]")?.querySelector("[cmdk-input]");
    (searchField ?? list).setAttribute("aria-activedescendant", row.id);
    if (!reveals.current) {
      return undefined;
    }
    // A frame later the panel has its place and its height, so the scroller knows what it hides.
    const frame = window.requestAnimationFrame(() => {
      reveals.current = false;
      row.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  });
  return null;
}

/**
 * The option a typed text moves to: the first whose name starts with it. The same letter typed
 * again moves on to the next name under that letter, after the active one, and wraps around.
 */
function typeAheadMatch(
  options: readonly PickerOption[],
  text: string,
  activeValue: string
): PickerOption | undefined {
  const startsWith = (prefix: string) => (option: PickerOption) =>
    option.label.toLocaleLowerCase().startsWith(prefix);
  const letter = text.charAt(0);
  if (text.length < 2 || Array.from(text).some((typed) => typed !== letter)) {
    return options.find(startsWith(text));
  }
  const active = options.findIndex((option) => option.value === activeValue);
  return [...options.slice(active + 1), ...options.slice(0, active + 1)].find(startsWith(letter));
}

function isDisabled(option: PickerOption): boolean {
  return option.disabled ?? option.disabledReason !== undefined;
}

function isGroup(entry: PickerOption | PickerOptionGroup): entry is PickerOptionGroup {
  return "options" in entry;
}

/** The entries whose name or description contains the query, in the caller's order. */
function filterEntries(
  entries: readonly (PickerOption | PickerOptionGroup)[],
  query: string
): (PickerOption | PickerOptionGroup)[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches = (option: PickerOption) =>
    needle === "" ||
    option.label.toLocaleLowerCase().includes(needle) ||
    (option.description?.toLocaleLowerCase().includes(needle) ?? false);
  const visible: (PickerOption | PickerOptionGroup)[] = [];
  for (const entry of entries) {
    if (!isGroup(entry)) {
      if (matches(entry)) {
        visible.push(entry);
      }
      continue;
    }
    const groupOptions = entry.options.filter(matches);
    if (groupOptions.length > 0) {
      visible.push({ heading: entry.heading, options: groupOptions });
    }
  }
  return visible;
}
