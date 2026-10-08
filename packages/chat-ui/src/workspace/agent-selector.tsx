import { useEffect, useRef, useState, type RefObject } from "react";
import { Bot, Check, ChevronDown } from "lucide-react";
import type { SafeConfig } from "@vivd-catalyst/api-client";
import { useTranslation } from "../i18n";
import { cn } from "../ui/cn";

type Agent = SafeConfig["agents"][number];

/** The header shares its row with other controls; the start page has the full width. */
type AgentChipPlacement = "header" | "start-page";

/** Finds the agent's name inside a chip; its value is the tone the name is shown in. */
export const AGENT_CHIP_NAME_SELECTOR = "[data-agent-chip-name]";

/**
 * On the start page the name leads; in the header it steps back behind the
 * conversation, and only pointing at the picker or focusing it brings it forward.
 */
const agentNameToneClassName = {
  strong: "font-semibold",
  subtle: cn(
    "font-medium text-muted-foreground transition-colors",
    "group-hover/agent-chip:text-foreground group-focus-visible/agent-chip:text-foreground"
  )
} as const;

/**
 * The agent of a conversation as a chip of icon and name. Several agents make
 * the chip a picker; a single one leaves nothing to choose, so it is a plain
 * label that looks the same.
 */
export function AgentSelector({
  agents,
  placement,
  contextLabel,
  selectedAgentName,
  onSelectAgent
}: {
  agents: SafeConfig["agents"];
  placement: AgentChipPlacement;
  contextLabel?: string;
  selectedAgentName: string | undefined;
  onSelectAgent: (agentName: string) => void;
}) {
  const selectedAgent = agents.find((agent) => agent.name === selectedAgentName) ?? agents[0];

  if (!selectedAgent) {
    return null;
  }
  if (agents.length === 1) {
    return (
      <AgentChip
        agentLabel={selectedAgent.displayName}
        contextLabel={contextLabel}
        placement={placement}
      />
    );
  }
  return (
    <AgentPicker
      agents={agents}
      contextLabel={contextLabel}
      placement={placement}
      selectedAgent={selectedAgent}
      onSelectAgent={onSelectAgent}
    />
  );
}

function AgentChip({
  agentLabel,
  contextLabel,
  placement,
  picker
}: {
  agentLabel: string;
  contextLabel?: string;
  placement: AgentChipPlacement;
  /** Makes the chip the button that opens the agent list. */
  picker?: {
    open: boolean;
    triggerRef: RefObject<HTMLButtonElement | null>;
    onToggle: () => void;
  };
}) {
  const { t } = useTranslation();
  const inHeader = placement === "header";
  const nameTone = inHeader ? "subtle" : "strong";
  const className = cn(
    "inline-flex min-w-0 items-center rounded-md text-left align-top text-foreground",
    // Below `sm` the header keeps only the icon; the name remains as the title
    // and for screen readers.
    inHeader
      ? "max-w-[min(32rem,calc(100vw-8.5rem))] max-sm:size-10 max-sm:justify-center sm:h-11 sm:gap-3 sm:px-2.5"
      : "h-11 max-w-[min(32rem,calc(100vw-2.5rem))] gap-3 px-2.5"
  );
  const content = (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[color-mix(in_srgb,var(--primary)_10%,var(--background))] text-primary">
        <Bot size={17} aria-hidden="true" />
      </span>
      <span className={cn("grid min-w-0 gap-0.5", inHeader && "max-sm:sr-only")}>
        <span
          className={cn("truncate text-sm", agentNameToneClassName[nameTone])}
          data-agent-chip-name={nameTone}
        >
          {agentLabel}
        </span>
        {contextLabel ? (
          <span className="hidden truncate text-xs font-normal text-muted-foreground sm:block">
            {contextLabel}
          </span>
        ) : null}
      </span>
      {picker ? (
        <ChevronDown
          size={15}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            inHeader && "max-sm:hidden",
            picker.open && "rotate-180"
          )}
          aria-hidden="true"
        />
      ) : null}
    </>
  );

  if (!picker) {
    return (
      <div className={className} title={agentLabel}>
        {content}
      </div>
    );
  }
  return (
    <button
      ref={picker.triggerRef}
      type="button"
      className={cn(
        className,
        "group/agent-chip transition-colors outline-none hover:bg-accent/70 focus-visible:ring-[3px] focus-visible:ring-ring/40"
      )}
      aria-label={`${t("selectAgent")}: ${agentLabel}`}
      title={agentLabel}
      aria-expanded={picker.open}
      aria-haspopup="listbox"
      onClick={picker.onToggle}
    >
      {content}
    </button>
  );
}

function AgentPicker({
  agents,
  contextLabel,
  placement,
  selectedAgent,
  onSelectAgent
}: {
  agents: SafeConfig["agents"];
  contextLabel?: string;
  placement: AgentChipPlacement;
  selectedAgent: Agent;
  onSelectAgent: (agentName: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: PointerEvent) {
      if (!(event.target instanceof Node && rootRef.current?.contains(event.target))) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
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
      <AgentChip
        agentLabel={selectedAgent.displayName}
        contextLabel={contextLabel}
        placement={placement}
        picker={{ open, triggerRef, onToggle: () => setOpen((currentOpen) => !currentOpen) }}
      />

      {open ? (
        <div
          className={cn(
            "absolute top-full z-50 pt-2",
            placement === "start-page" ? "left-1/2 -translate-x-1/2" : "left-0"
          )}
        >
          <div className="grid w-[min(19rem,calc(100vw-2rem))] gap-1 rounded-md border bg-popover p-1.5 text-popover-foreground shadow-lg">
            <div role="listbox" aria-label={t("selectAgent")} className="grid gap-1">
              {agents.map((agent) => {
                const selected = agent.name === selectedAgent.name;
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
                      triggerRef.current?.focus();
                    }}
                  >
                    <Check
                      size={15}
                      className={cn("text-primary", !selected && "opacity-0")}
                      aria-hidden="true"
                    />
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate font-medium">{agent.displayName}</span>
                      {agent.description ? (
                        <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                          {agent.description}
                        </span>
                      ) : null}
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
