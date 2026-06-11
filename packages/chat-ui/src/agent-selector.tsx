import { useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown } from "lucide-react";
import type { SafeConfig } from "@agent-chat-platform/api-client";
import { useTranslation } from "./i18n";
import { cn } from "./ui/cn";

export function AgentSelector({
  agents,
  selectedAgentName,
  onSelectAgent
}: {
  agents: SafeConfig["agents"];
  selectedAgentName: string | undefined;
  onSelectAgent: (agentName: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedAgent =
    agents.find((agent) => agent.name === selectedAgentName) ?? agents[0];

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
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        className={cn(
          "inline-flex h-10 max-w-[min(18rem,calc(100vw-8.5rem))] min-w-0 items-center gap-2 rounded-md bg-background/95 px-3 text-sm font-medium text-foreground shadow-sm backdrop-blur transition-colors outline-none",
          "hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
        )}
        aria-label={t("selectAgent")}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        <Bot size={16} className="shrink-0 text-primary" aria-hidden="true" />
        <span className="truncate">{selectedAgent?.displayName ?? t("agentFallback")}</span>
        <ChevronDown
          size={15}
          className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute left-0 top-[calc(100%+0.5rem)] z-50 grid w-[min(19rem,calc(100vw-2rem))] gap-1 rounded-md border bg-popover p-1.5 text-popover-foreground shadow-lg"
        >
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
      ) : null}
    </div>
  );
}
