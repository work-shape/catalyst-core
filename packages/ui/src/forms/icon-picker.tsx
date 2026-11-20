import { useState } from "react";
import { IconButton } from "../actions/icon-button";
import { cn } from "../cn";
import { Popover, PopoverContent, PopoverTrigger } from "../overlays/popover";
import { RegistryIcon } from "../status/registry-icon";

export interface IconPickerOption {
  /** The key of the icon registry. */
  name: string;
  /** What the icon shows, for its tooltip and for assistive technology. */
  label: string;
}

export interface IconPickerProps {
  /** What the icon belongs to, such as "Icon of suggestion 2". */
  label: string;
  /** The icons to choose from, in the order they are shown. */
  options: readonly IconPickerOption[];
  /** The chosen icon. None means the default. */
  value?: string;
  /** The registry key of the icon that shows while none is chosen. */
  defaultIcon: string;
  /** The name of the choice that takes the chosen icon away: "Default". */
  defaultLabel: string;
  disabled?: boolean;
  onChange(value: string | undefined): void;
  className?: string;
}

const optionClassName =
  "flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:focus-ring active:bg-state-pressed aria-pressed:bg-state-selected aria-pressed:text-foreground [&_svg]:size-4.5";

/**
 * A small button that shows an icon and opens a grid of icons to choose another from. The first
 * choice is the default, which stores no icon. Choosing closes the grid. The icons come from
 * the icon registry by their keys, so a picker never offers what the page cannot draw.
 */
export function IconPicker({
  label,
  options,
  value,
  defaultIcon,
  defaultLabel,
  disabled,
  onChange,
  className
}: IconPickerProps) {
  const [open, setOpen] = useState(false);
  const chosen = options.find((option) => option.name === value);
  const choose = (next: string | undefined) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          label={`${label}: ${chosen?.label ?? defaultLabel}`}
          variant="outline"
          disabled={disabled}
          data-icon-picker={chosen?.name ?? ""}
          className={cn("rounded-md text-foreground", className)}
        >
          <RegistryIcon name={chosen?.name ?? defaultIcon} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent size="fit" className="p-2">
        <div role="group" aria-label={label} className="grid gap-1.5">
          <button
            type="button"
            aria-pressed={chosen === undefined}
            onClick={() => choose(undefined)}
            className={cn(optionClassName, "h-9 justify-start gap-2.5 px-2.5 text-label")}
          >
            <RegistryIcon name={defaultIcon} />
            {defaultLabel}
          </button>
          <div className="grid grid-cols-6 gap-0.5 border-t pt-1.5">
            {options.map((option) => (
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
                <RegistryIcon name={option.name} />
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
