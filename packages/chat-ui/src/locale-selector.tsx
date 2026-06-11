import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Languages } from "lucide-react";
import type { LocaleCode } from "@agent-chat-platform/api-client";
import { useTranslation } from "./i18n";
import { cn } from "./ui/cn";

export function LocaleSelector({
  locales,
  selectedLocale,
  onSelectLocale
}: {
  locales: LocaleCode[];
  selectedLocale: LocaleCode;
  onSelectLocale(locale: LocaleCode): void;
}) {
  const { t, localeName } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={cn(
          "inline-flex h-10 items-center gap-2 rounded-md border bg-background/95 px-3 text-sm font-medium text-foreground shadow-sm backdrop-blur transition-colors outline-none",
          "hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        )}
        aria-label={t("language")}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        <Languages size={16} className="shrink-0 text-primary" aria-hidden="true" />
        <span className="uppercase">{selectedLocale}</span>
        <ChevronDown
          size={15}
          className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-50 grid w-44 gap-1 rounded-md border bg-popover p-1.5 text-popover-foreground shadow-lg"
        >
          {locales.map((locale) => {
            const selected = locale === selectedLocale;
            return (
              <button
                key={locale}
                type="button"
                role="option"
                aria-selected={selected}
                className={cn(
                  "grid min-h-10 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm outline-none transition-colors",
                  "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                  selected && "bg-accent text-accent-foreground"
                )}
                onClick={() => {
                  onSelectLocale(locale);
                  setOpen(false);
                }}
              >
                <Check
                  size={15}
                  className={cn("text-primary", !selected && "opacity-0")}
                  aria-hidden="true"
                />
                <span>{localeName(locale)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
