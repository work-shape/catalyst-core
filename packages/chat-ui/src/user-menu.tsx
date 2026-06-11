import { useEffect, useRef, useState } from "react";
import { LogOut, Settings } from "lucide-react";
import type { ApiUser } from "@vivd-catalyst/api-client";
import { avatarGradient } from "./avatar-gradient";
import { useTranslation } from "./i18n";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";

export function UserMenu({
  user,
  signingOut,
  onOpenSettings,
  onSignOut,
  placement = "bottom",
  align = "end"
}: {
  user: ApiUser | undefined;
  signingOut: boolean;
  onOpenSettings: () => void;
  onSignOut: () => void;
  placement?: "top" | "bottom";
  align?: "start" | "end";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const label = user?.displayLabel ?? user?.email ?? t("userFallback");
  const initials = getInitials(label);

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
    <div ref={rootRef} className="relative flex min-w-0 flex-1 items-center">
      <button
        type="button"
        className={cn(
          "flex h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors",
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
        )}
        aria-label={t("accountMenuLabel", { label })}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        <span
          style={{ background: avatarGradient(label) }}
          className="grid size-8 shrink-0 place-items-center rounded-full border border-white/45 text-xs font-semibold text-white shadow-xs"
          aria-hidden="true"
        >
          {initials}
        </span>
        <span className="truncate text-xs text-muted-foreground">{label}</span>
      </button>

      {open ? (
        <div
          className={[
            "absolute z-50 w-64 rounded-md border bg-popover p-2 text-popover-foreground shadow-lg",
            placement === "top" ? "bottom-[calc(100%+0.5rem)]" : "top-[calc(100%+0.5rem)]",
            align === "start" ? "left-0" : "right-0"
          ].join(" ")}
        >
          <div className="min-w-0 border-b px-2 pb-2">
            <p className="truncate text-sm font-medium">{label}</p>
            {user?.email ? <p className="truncate text-xs text-muted-foreground">{user.email}</p> : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            className="mt-2 h-9 w-full justify-start text-muted-foreground"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            <Settings size={16} aria-hidden="true" />
            <span>{t("settings")}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-9 w-full justify-start text-muted-foreground hover:text-destructive"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            disabled={signingOut}
          >
            <LogOut size={16} aria-hidden="true" />
            <span>{signingOut ? t("signingOut") : t("signOut")}</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function getInitials(label: string): string {
  const words = label
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const initials = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : label.slice(0, 2);
  return initials.toUpperCase() || "U";
}
