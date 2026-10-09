import { Command } from "cmdk";
import { useRef, type ReactNode } from "react";
import { useScrollEdgeFade } from "../scroll-edge-fade";
import { dialogWidthClassName, ModalSurface } from "./dialog";
import { menuGroupHeadingClassName } from "./dropdown-menu";
import { PickerSearchField, pickerRowClassName } from "./picker";

export interface CommandPaletteItem {
  /** Told to `onSelect`. No two items of a palette share one. */
  value: string;
  /** The name of the command or the object. It is shown as text. */
  label: string;
  /** An icon or an avatar before the name. */
  leading?: ReactNode;
  /** The keys that do the same, shown at the row's trailing edge. */
  shortcut?: ReactNode;
}

export interface CommandPaletteGroup {
  /** The group's name in sentence case. Without it the items stand first, unnamed. */
  heading?: string;
  items: readonly CommandPaletteItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  /** Names the palette and its search field, and is the field's placeholder. */
  label: string;
  /** What the search field holds. The caller narrows `groups` to it. */
  query: string;
  onQueryChange(query: string): void;
  /** Shown in this order. The palette does not filter them. */
  groups: readonly CommandPaletteGroup[];
  /** One sentence under the groups, such as "no results" or why the search failed. */
  message?: ReactNode;
  /** An item was chosen with Enter or a click. The caller closes the palette. */
  onSelect(value: string): void;
  onClose(): void;
}

/**
 * Finds a command or an object from anywhere: a dialog whose search field holds the focus over
 * the picker's list. The arrow keys move through the items, Enter chooses, and Escape closes
 * the palette and returns the focus to where it was. It stands near the top of the window so
 * the field stays in place while the list under it changes length.
 */
export function CommandPalette({
  open,
  label,
  query,
  onQueryChange,
  groups,
  message,
  onSelect,
  onClose
}: CommandPaletteProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const shown = groups.filter((group) => group.items.length > 0);
  const itemCount = shown.reduce((count, group) => count + group.items.length, 0);
  const fade = useScrollEdgeFade<HTMLDivElement>([itemCount, query, open]);
  const renderItem = (item: CommandPaletteItem) => (
    <Command.Item
      key={item.value}
      value={item.value}
      className={pickerRowClassName}
      onSelect={() => onSelect(item.value)}
    >
      {item.leading}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.shortcut === undefined ? null : (
        <kbd className="font-sans text-caption text-muted-foreground">{item.shortcut}</kbd>
      )}
    </Command.Item>
  );

  return (
    <ModalSurface
      open={open}
      label={label}
      // The list's own frame can take the focus and stands before the field.
      initialFocus={searchRef}
      className={`mt-[12dvh] mb-auto ${dialogWidthClassName("md")}`}
      onClose={onClose}
    >
      {/* The list exists only while the palette is open, so every opening starts at its top. */}
      {open ? (
        <Command
          shouldFilter={false}
          loop
          label={label}
          className="flex max-h-[min(28rem,70dvh)] flex-col"
        >
          <PickerSearchField
            inputRef={searchRef}
            value={query}
            label={label}
            placeholder={label}
            onValueChange={onQueryChange}
          />
          <Command.List className="flex min-h-0 flex-1 flex-col outline-none *:flex *:min-h-0 *:flex-1 *:flex-col">
            <div
              ref={fade.ref}
              style={fade.style}
              className="min-h-0 flex-1 overflow-y-auto p-1 [scrollbar-width:thin]"
              onScroll={fade.onScroll}
            >
              {shown.map((group) =>
                group.heading === undefined ? (
                  group.items.map(renderItem)
                ) : (
                  <Command.Group
                    key={group.heading}
                    heading={<div className={menuGroupHeadingClassName}>{group.heading}</div>}
                  >
                    {group.items.map(renderItem)}
                  </Command.Group>
                )
              )}
              {message === undefined ? null : (
                <p role="status" className="px-2 py-6 text-center text-body text-muted-foreground">
                  {message}
                </p>
              )}
            </div>
          </Command.List>
        </Command>
      ) : null}
    </ModalSurface>
  );
}
