import { forwardRef, useState, type ComponentPropsWithoutRef } from "react";
import { Bot, ChevronDown } from "lucide-react";
import type { SafeConfig } from "@vivd-catalyst/api-client";
import { Button, cn, Picker, type PickerOption } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";

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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selectedAgent = agents.find((agent) => agent.name === selectedAgentName) ?? agents[0];

  const showName = display.showName && placement === "start-page";

  if (!selectedAgent) {
    return null;
  }
  if (showName && agents.length === 1) {
    return (
      <div className={chipClassName(true)} title={selectedAgent.displayName}>
        <AgentChipContent agentLabel={selectedAgent.displayName} showName />
      </div>
    );
  }
  return (
    <Picker
      label={t("selectAgent")}
      options={agentPickerOptions(agents, display.showDescriptions)}
      value={selectedAgent.name}
      open={open}
      // Without a name the icon gives no hint that it opens anything, so a mouse
      // pointing at it opens the list and leaving closes it.
      openOnHover={!showName}
      wrapDescriptions
      align={placement === "start-page" ? "center" : "start"}
      onOpenChange={setOpen}
      onValueChange={onSelectAgent}
    >
      <AgentChipButton agentLabel={selectedAgent.displayName} showName={showName} open={open} />
    </Picker>
  );
}

/** The agents as the options of the picker, each with its description where the instance shows them. */
export function agentPickerOptions(
  agents: SafeConfig["agents"],
  showDescriptions: boolean
): PickerOption[] {
  return agents.map((agent) => ({
    value: agent.name,
    label: agent.displayName,
    ...(showDescriptions && agent.description ? { description: agent.description } : {})
  }));
}

function chipClassName(showName: boolean): string {
  return cn(
    "inline-flex min-w-0 items-center rounded-md text-left align-top text-foreground",
    showName
      ? "h-11 max-w-[min(32rem,calc(100vw-2.5rem))] shrink justify-start gap-3 px-2.5"
      : "size-10 shrink-0 justify-center"
  );
}

/** The chip as the button that opens the agent list. The picker hands it the trigger's props. */
const AgentChipButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { agentLabel: string; showName: boolean; open: boolean }
>(function AgentChipButton({ agentLabel, showName, open, className, ...trigger }, ref) {
  const { t } = useTranslation();
  return (
    <Button
      ref={ref}
      variant="ghost"
      {...trigger}
      className={cn(chipClassName(showName), className)}
      aria-label={`${t("selectAgent")}: ${agentLabel}`}
      title={agentLabel}
    >
      <AgentChipContent agentLabel={agentLabel} showName={showName} picker={{ open }} />
    </Button>
  );
});

function AgentChipContent({
  agentLabel,
  showName,
  picker
}: {
  agentLabel: string;
  showName: boolean;
  /** Set where the chip opens the agent list. */
  picker?: { open: boolean };
}) {
  const iconOnlyOpen = !showName && picker?.open === true;
  return (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-foreground">
        {/*
          Alone, the icon is also the only sign that the list is open. Both
          icons stay mounted: replacing the one under a resting pointer makes
          the browser report the pointer as entering again, which would reopen
          a list that Escape just closed.
        */}
        <Bot className={cn("size-4", iconOnlyOpen && "hidden")} aria-hidden="true" />
        {showName ? null : (
          <ChevronDown className={cn("size-4", !iconOnlyOpen && "hidden")} aria-hidden="true" />
        )}
      </span>
      {showName ? (
        <span className="min-w-0 truncate text-label font-semibold">{agentLabel}</span>
      ) : null}
      {showName && picker ? (
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            picker.open && "rotate-180"
          )}
          aria-hidden="true"
        />
      ) : null}
    </>
  );
}
