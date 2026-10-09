import { Command } from "cmdk";
import { Check, Plus, Search } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useRef, useState, type ReactNode, type RefObject } from "react";
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
  /** Shows a search field that narrows the options to those containing what is typed. */
  search?: boolean;
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

/** The row of a list that takes the arrow keys: the menu row with the hover fill when active. */
export const pickerRowClassName = cn(
  menuRowClassName,
  "data-[selected=true]:bg-state-hover data-[disabled=true]:text-muted-foreground"
);

/**
 * Chooses one object or several from a list: an agent, a workspace, an asset. The arrow keys
 * move through the options, Enter chooses, typing narrows the list, and Escape closes the
 * picker and returns focus to its trigger.
 */
export function Picker(props: PickerProps) {
  const {
    children,
    options,
    search = false,
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
  const listRef = useRef<HTMLDivElement>(null);
  const isOpen = open ?? uncontrolledOpen;

  const changeOpen = (next: boolean) => {
    setUncontrolledOpen(next);
    if (!next) {
      setQuery("");
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
  const fade = useScrollEdgeFade<HTMLDivElement>([visible.length, query, isOpen]);
  const renderOption = (option: PickerOption) => {
    const secondLine = option.disabledReason ?? option.description;
    return (
      <Command.Item
        key={option.value}
        value={option.value}
        disabled={option.disabled ?? option.disabledReason !== undefined}
        className={pickerRowClassName}
        onSelect={() => choose(option)}
      >
        {option.leading}
        <span className="grid min-w-0 flex-1">
          <span className="truncate">{option.label}</span>
          {secondLine === undefined ? null : (
            <span className="truncate text-caption text-muted-foreground">{secondLine}</span>
          )}
        </span>
        {option.trailing}
        {isChosen(option) ? <Check aria-hidden="true" /> : null}
      </Command.Item>
    );
  };

  return (
    <PopoverPrimitive.Root open={isOpen} onOpenChange={changeOpen}>
      <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>
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
            onOpenAutoFocus={(event) => {
              // Without a search field the list itself takes the keys.
              if (!search) {
                event.preventDefault();
                listRef.current?.focus();
              }
            }}
          >
            <Command shouldFilter={false} loop className="flex min-h-0 flex-1 flex-col">
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
