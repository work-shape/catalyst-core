import { useEffect, useRef, useState } from "react";
import { LogOut, Settings } from "lucide-react";
import type { ApiUser } from "@agent-chat-platform/api-client";
import { avatarGradient } from "./avatar-gradient";
import { Button } from "./ui/button";

export function UserMenu({
  user,
  signingOut,
  onOpenSettings,
  onSignOut
}: {
  user: ApiUser | undefined;
  signingOut: boolean;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const label = user?.displayLabel ?? user?.email ?? "User";
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
    <div ref={rootRef} className="relative flex shrink-0 items-center">
      <button
        type="button"
        style={{ background: avatarGradient(label) }}
        className="grid size-9 place-items-center rounded-full border border-white/45 text-sm font-semibold text-white shadow-xs transition-[filter,box-shadow] outline-none hover:brightness-95 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        aria-label={`${label} account`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        {initials}
      </button>

      {open ? (
        <div className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-64 rounded-md border bg-popover p-2 text-popover-foreground shadow-lg">
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
            <span>Settings</span>
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
            <span>{signingOut ? "Signing out" : "Sign out"}</span>
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
