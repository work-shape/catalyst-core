import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Bot, Check, ChevronDown } from "lucide-react";
import type { SafeConfig } from "@vivd-catalyst/api-client";
import { useTranslation } from "../i18n";
import { cn } from "../ui/cn";

export function AgentSelector({
  agents,
  contextLabel,
  selectedAgentName,
  showName,
  onSelectAgent
}: {
  agents: SafeConfig["agents"];
  contextLabel?: string;
  selectedAgentName: string | undefined;
  showName: boolean;
  onSelectAgent: (agentName: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedAgent = agents.find((agent) => agent.name === selectedAgentName) ?? agents[0];

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

  const agentLabel = selectedAgent?.displayName ?? t("agentFallback");

  // Without a visible label the control is just an icon, so hovering it opens
  // the list — that is the only affordance telling it apart from a plain badge.
  function openOnHover(event: ReactPointerEvent<HTMLDivElement>) {
    if (!showName && event.pointerType === "mouse") {
      setOpen(true);
    }
  }

  function closeOnHoverOut(event: ReactPointerEvent<HTMLDivElement>) {
    if (!showName && event.pointerType === "mouse") {
      setOpen(false);
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative min-w-0"
      onPointerEnter={openOnHover}
      onPointerLeave={closeOnHoverOut}
    >
      <button
        type="button"
        className={cn(
          "inline-flex min-w-0 items-center rounded-md text-left text-foreground transition-colors outline-none",
          "hover:bg-accent/70 focus-visible:ring-[3px] focus-visible:ring-ring/40",
          showName
            ? "h-11 max-w-[min(32rem,calc(100vw-8.5rem))] gap-3 px-2.5"
            : "size-10 shrink-0 justify-center"
        )}
        aria-label={t("selectAgent")}
        title={showName ? undefined : agentLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[color-mix(in_srgb,var(--primary)_10%,var(--background))] text-primary">
          {!showName && open ? (
            <ChevronDown size={17} aria-hidden="true" />
          ) : (
            <Bot size={17} aria-hidden="true" />
          )}
        </span>
        {showName ? (
          <>
            <span className="grid min-w-0 gap-0.5">
              <span className="truncate text-sm font-semibold">{agentLabel}</span>
              {contextLabel ? (
                <span className="hidden truncate text-xs font-normal text-muted-foreground sm:block">
                  {contextLabel}
                </span>
              ) : null}
            </span>
            <ChevronDown
              size={15}
              className={cn(
                "shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180"
              )}
              aria-hidden="true"
            />
          </>
        ) : null}
      </button>

      {open ? (
        // The wrapper's padding is the gap to the trigger, so it stays inside
        // the hover area and the list does not close while moving into it.
        <div className="absolute left-0 top-full z-50 pt-2">
          <div className="grid w-[min(19rem,calc(100vw-2rem))] gap-1 rounded-md border bg-popover p-1.5 text-popover-foreground shadow-lg">
            {!showName && contextLabel ? (
              <span className="truncate px-2.5 pt-1 text-xs text-muted-foreground">
                {contextLabel}
              </span>
            ) : null}
            <div role="listbox" className="grid gap-1">
              {agents.map((agent) => {
                const selected = agent.name === selectedAgent?.name;
                return (
                  <button
                    key={agent.name}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={cn(
                      "grid min-h-10 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm outline-none transition-colors",
                      "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                      selected && "bg-accent text-accent-foreground"
                    )}
                    onClick={() => {
                      onSelectAgent(agent.name);
                      setOpen(false);
                    }}
                  >
                    <Check
                      size={15}
                      className={cn("text-primary", !selected && "opacity-0")}
                      aria-hidden="true"
                    />
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate font-medium">{agent.displayName}</span>
                      <span className="truncate text-xs text-muted-foreground">{agent.name}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
