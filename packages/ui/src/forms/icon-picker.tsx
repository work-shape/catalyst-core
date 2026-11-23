import { useState, type ReactNode } from "react";
import { cn } from "../cn";
import { Popover, PopoverContent, PopoverTrigger } from "../overlays/popover";

export interface IconPickerOption {
  /** What is stored when the icon is chosen. */
  name: string;
  /** What the icon shows, for its tooltip and for assistive technology. */
  label: string;
  /** The icon as it is drawn, on its tile where it has one. */
  icon: ReactNode;
}

export interface IconPickerGroup {
  /** What the icons of the group have in common, such as "Documents". */
  label: string;
  options: readonly IconPickerOption[];
}

export interface IconPickerProps {
  /** What the icon belongs to, such as "Icon of suggestion 2". */
  label: string;
  /** The icons to choose from, group by group in the order they are shown. */
  groups: readonly IconPickerGroup[];
  /** The chosen icon. None means the default. */
  value?: string;
  /** The icon that shows while none is chosen. */
  defaultIcon: ReactNode;
  /** The name of the choice that takes the chosen icon away: "Default". */
  defaultLabel: string;
  disabled?: boolean;
  onChange(value: string | undefined): void;
  className?: string;
}

const optionClassName =
  "flex items-center justify-center rounded-md transition-colors hover:bg-state-hover focus-visible:focus-ring active:bg-state-pressed aria-pressed:bg-state-selected";

/**
 * A small button that shows an icon and opens the icons to choose another from, group by
 * group. The first choice is the default, which stores no icon. Choosing closes the panel.
 */
export function IconPicker({
  label,
  groups,
  value,
  defaultIcon,
  defaultLabel,
  disabled,
  onChange,
  className
}: IconPickerProps) {
  const [open, setOpen] = useState(false);
  const chosen = groups.flatMap((group) => group.options).find((option) => option.name === value);
  const choose = (next: string | undefined) => {
    onChange(next);
    setOpen(false);
  };
  const name = `${label}: ${chosen?.label ?? defaultLabel}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={name}
          aria-label={name}
          disabled={disabled}
          data-icon-picker={chosen?.name ?? ""}
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg border border-input bg-background shadow-control transition-colors hover:border-input-strong hover:bg-state-hover focus-visible:focus-ring active:bg-state-pressed disabled:pointer-events-none disabled:opacity-50 aria-expanded:border-input-strong",
            className
          )}
        >
          {chosen?.icon ?? defaultIcon}
        </button>
      </PopoverTrigger>
      <PopoverContent size="fit" className="p-2">
        <div role="group" aria-label={label} className="grid gap-2">
          <button
            type="button"
            aria-pressed={chosen === undefined}
            onClick={() => choose(undefined)}
            className={cn(optionClassName, "h-9 justify-start gap-2.5 px-1.5 text-label")}
          >
            {defaultIcon}
            {defaultLabel}
          </button>
          {groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label} className="grid gap-0.5">
              <span className="px-1.5 text-caption text-muted-foreground">{group.label}</span>
              <div className="grid grid-cols-8 gap-0.5">
                {group.options.map((option) => (
                  <button
                    key={option.name}
                    type="button"
                    title={option.label}
                    aria-label={option.label}
                    aria-pressed={option.name === chosen?.name}
                    data-icon-option={option.name}
                    onClick={() => choose(option.name)}
                    className={cn(optionClassName, "size-9")}
                  >
                    {option.icon}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
