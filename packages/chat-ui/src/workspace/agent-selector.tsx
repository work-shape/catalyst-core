import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from "react";
import { Bot, Check, ChevronDown } from "lucide-react";
import type { SafeConfig } from "@vivd-catalyst/api-client";
import { cn } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";

type Agent = SafeConfig["agents"][number];

/** The start page introduces the agent; the header of a conversation only keeps its icon. */
type AgentChipPlacement = "header" | "start-page";

/**
 * What an instance shows of its agents: `ui.showAgentName` puts the name beside
 * the icon on the start page, `ui.showAgentDescriptions` the descriptions in the
 * agent list.
 */
export interface AgentChipDisplay {
  showName: boolean;
  showDescriptions: boolean;
}

export function agentChipDisplayFor(
  ui: Pick<SafeConfig["ui"], "showAgentName" | "showAgentDescriptions"> | undefined
): AgentChipDisplay {
  return {
    showName: ui?.showAgentName ?? true,
    showDescriptions: ui?.showAgentDescriptions ?? false
  };
}

/**
 * The agent of a conversation as a chip.
 *
 * In the header of a conversation the chip is always the icon alone, and so it
 * is on the start page of an instance that hides the name. Pointing at the icon
 * opens the agent list: that is how the user learns which agent it is, so it
 * opens for a single agent too. With the name beside the icon on the start
 * page, several agents make the chip a picker that opens on click; a single one
 * leaves nothing to choose, so it is a plain label that looks the same.
 */
export function AgentSelector({
  agents,
  display,
  placement,
  selectedAgentName,
  onSelectAgent
}: {
  agents: SafeConfig["agents"];
  display: AgentChipDisplay;
  placement: AgentChipPlacement;
  selectedAgentName: string | undefined;
  onSelectAgent: (agentName: string) => void;
}) {
  const selectedAgent = agents.find((agent) => agent.name === selectedAgentName) ?? agents[0];

  const showName = display.showName && placement === "start-page";

  if (!selectedAgent) {
    return null;
  }
  if (showName && agents.length === 1) {
    return <AgentChip agentLabel={selectedAgent.displayName} showName />;
  }
  return (
    <AgentPicker
      agents={agents}
      display={{ ...display, showName }}
      placement={placement}
      selectedAgent={selectedAgent}
      onSelectAgent={onSelectAgent}
    />
  );
}

function AgentChip({
  agentLabel,
  showName,
  picker
}: {
  agentLabel: string;
  showName: boolean;
  /** Makes the chip the button that opens the agent list. */
  picker?: {
    open: boolean;
    triggerRef: RefObject<HTMLButtonElement | null>;
    onToggle: () => void;
  };
}) {
  const { t } = useTranslation();
  const iconOnlyOpen = !showName && picker?.open === true;
  const className = cn(
    "inline-flex min-w-0 items-center rounded-md text-left align-top text-foreground",
    showName
      ? "h-11 max-w-[min(32rem,calc(100vw-2.5rem))] gap-3 px-2.5"
      : "size-10 shrink-0 justify-center"
  );
  const content = (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-foreground">
        {/*
          Alone, the icon is also the only sign that the list is open. Both
          icons stay mounted: replacing the one under a resting pointer makes
          the browser report the pointer as entering again, which would reopen
          a list that Escape just closed.
        */}
        <Bot size={17} className={cn(iconOnlyOpen && "hidden")} aria-hidden="true" />
        {showName ? null : (
          <ChevronDown size={17} className={cn(!iconOnlyOpen && "hidden")} aria-hidden="true" />
        )}
      </span>
      {showName ? (
        <span className="min-w-0 truncate text-sm font-semibold">{agentLabel}</span>
      ) : null}
      {showName && picker ? (
        <ChevronDown
          size={15}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
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
        "transition-colors outline-none hover:bg-accent/70 focus-visible:ring-[3px] focus-visible:ring-ring/40"
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
  display,
  placement,
  selectedAgent,
  onSelectAgent
}: {
  agents: SafeConfig["agents"];
  display: AgentChipDisplay;
  placement: AgentChipPlacement;
  selectedAgent: Agent;
  onSelectAgent: (agentName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listMaxWidth = useAvailableListWidth(rootRef, placement, open);
  // Without a name the icon gives no hint that it opens anything, so a mouse
  // pointing at it opens the list and leaving closes it.
  const opensOnHover = !display.showName;
  const mouseOverRef = useRef(false);

  function followMouse(over: boolean) {
    return (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!opensOnHover || event.pointerType !== "mouse") {
        return;
      }
      mouseOverRef.current = over;
      // The keyboard may be on an agent in the list: the list then stays for
      // it, and closes once the focus leaves as well.
      if (over || !listRef.current?.contains(document.activeElement)) {
        setOpen(over);
      }
    };
  }

  function closeWhenFocusLeaves(event: ReactFocusEvent<HTMLDivElement>) {
    if (
      opensOnHover &&
      !mouseOverRef.current &&
      event.relatedTarget instanceof Node &&
      !event.currentTarget.contains(event.relatedTarget)
    ) {
      setOpen(false);
    }
  }

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
    <div
      ref={rootRef}
      className="relative min-w-0"
      onPointerEnter={followMouse(true)}
      onPointerLeave={followMouse(false)}
      onBlur={closeWhenFocusLeaves}
    >
      <AgentChip
        agentLabel={selectedAgent.displayName}
        showName={display.showName}
        picker={{
          open,
          triggerRef,
          // A click under the mouse that already opened the list keeps it open.
          onToggle: () => setOpen((currentOpen) => mouseOverRef.current || !currentOpen)
        }}
      />

      {open ? (
        // The wrapper's padding is the gap to the chip, so it stays inside the
        // hover area and the list does not close while the pointer moves into it.
        <div
          ref={listRef}
          className={cn(
            "absolute top-full z-50 pt-2",
            placement === "start-page" ? "left-1/2 -translate-x-1/2" : "left-0"
          )}
        >
          <AgentList
            agents={agents}
            maxWidth={listMaxWidth}
            selectedAgent={selectedAgent}
            showDescriptions={display.showDescriptions}
            onSelectAgent={(agentName) => {
              onSelectAgent(agentName);
              setOpen(false);
              triggerRef.current?.focus();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The list keeps this distance from the edge of the window, in pixels. */
const LIST_WINDOW_MARGIN = 16;

/**
 * The width the open list may take without leaving the window: from the chip's
 * left edge in the header, and to both sides of the chip's centre on the start
 * page.
 */
function useAvailableListWidth(
  rootRef: RefObject<HTMLDivElement | null>,
  placement: AgentChipPlacement,
  open: boolean
): number | undefined {
  const [width, setWidth] = useState<number>();

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    function measure() {
      const root = rootRef.current?.getBoundingClientRect();
      if (!root) {
        return;
      }
      const windowWidth = document.documentElement.clientWidth;
      const centre = root.left + root.width / 2;
      setWidth(
        Math.max(
          0,
          placement === "header"
            ? windowWidth - LIST_WINDOW_MARGIN - root.left
            : 2 * (Math.min(centre, windowWidth - centre) - LIST_WINDOW_MARGIN)
        )
      );
    }

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, placement, rootRef]);

  return open ? width : undefined;
}

/** The agents to choose from, each with its description where the instance shows them. */
export function AgentList({
  agents,
  maxWidth,
  selectedAgent,
  showDescriptions,
  onSelectAgent
}: {
  agents: SafeConfig["agents"];
  /** The room the list has where it hangs, in pixels. */
  maxWidth?: number;
  selectedAgent: Agent;
  showDescriptions: boolean;
  onSelectAgent: (agentName: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="grid w-[min(19rem,calc(100vw-2rem))] gap-1 rounded-md border bg-popover p-1.5 text-popover-foreground shadow-lg"
      style={{ maxWidth }}
    >
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
              onClick={() => onSelectAgent(agent.name)}
            >
              <Check
                size={15}
                className={cn("text-primary", !selected && "opacity-0")}
                aria-hidden="true"
              />
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate font-medium">{agent.displayName}</span>
                {showDescriptions && agent.description ? (
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
  );
}
