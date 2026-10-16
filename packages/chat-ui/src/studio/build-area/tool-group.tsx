import { OPERATION_EFFECTS } from "@work-shape/catalyst-core";
import type { ReactNode } from "react";
import {
  Badge,
  Checkbox,
  Chip,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";

// What every source of tools in an agent's Tools section is built from: a folding sub-group
// of check boxes for one thing that brings tools, a Connection or an App, and the chip of a
// tool name the agent holds that no check box stands for.

/** One tool a sub-group offers. */
export interface ToolGroupTool {
  /** The name the agent lists. */
  toolName: string;
  /** What the check box is labelled with: the operation, or the action. */
  label: string;
  description?: string;
  effect: (typeof OPERATION_EFFECTS)[number];
}

/** A sub-group with more tools than this starts folded, with its count. */
const TOOL_GROUP_OPEN_MAX_TOOLS = 12;

/**
 * With more sub-groups than this in one source, a sub-group starts folded unless the agent
 * holds one of its tools, so a long list stays a list of lines.
 */
const TOOL_GROUPS_OPEN_MAX = 6;

/** Whether a sub-group starts unfolded. */
export function toolGroupStartsOpen(input: {
  toolCount: number;
  selectedCount: number;
  /** How many sub-groups the source shows. */
  groupCount: number;
}): boolean {
  return (
    input.toolCount <= TOOL_GROUP_OPEN_MAX_TOOLS &&
    (input.groupCount <= TOOL_GROUPS_OPEN_MAX || input.selectedCount > 0)
  );
}

/** The agent's tool names after one tool was ticked or unticked. The order of the rest stays. */
export function toggleToolName(
  selected: readonly string[],
  toolName: string,
  checked: boolean
): string[] {
  const rest = selected.filter((entry) => entry !== toolName);
  return checked ? [...rest, toolName] : rest;
}

/** A tool name the agent holds that no check box stands for. It can only be removed. */
export function ToolChip({
  toolName,
  remove
}: {
  toolName: string;
  remove: ((toolName: string) => void) | undefined;
}) {
  return (
    <Chip
      size="sm"
      className="max-w-full font-mono"
      onRemove={remove ? () => remove(toolName) : undefined}
    >
      <span className="break-all">{toolName}</span>
    </Chip>
  );
}

/**
 * The tools of one Connection or one App: its name with how many of its tools the agent
 * holds, and folded under it a check box per tool with its effect and its description.
 */
export function ToolGroup({
  source,
  title,
  tools,
  selected,
  startsOpen,
  disabled,
  footer,
  onChange
}: {
  /** Which kind of thing brings the tools, and its name: what a test finds the group by. */
  source: { kind: "connection" | "app"; name: string };
  title: string;
  tools: readonly ToolGroupTool[];
  /** Every tool name the agent holds. */
  selected: readonly string[];
  startsOpen: boolean;
  disabled?: boolean;
  /** Under the check boxes: the way to what brings the tools. */
  footer?: ReactNode;
  onChange(selected: string[]): void;
}) {
  const { t } = useTranslation();
  return (
    <Disclosure
      variant="outline"
      defaultOpen={startsOpen}
      {...{ [`data-${source.kind}-tools`]: source.name }}
    >
      <DisclosureTrigger>
        <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="min-w-0 break-words text-foreground">{title}</span>
          <span className="text-caption font-normal text-muted-foreground">
            {t("connections.toolsSelected", {
              selected: tools.filter((tool) => selected.includes(tool.toolName)).length,
              count: tools.length
            })}
          </span>
        </span>
      </DisclosureTrigger>
      <DisclosureContent>
        <div role="group" aria-label={title} className="grid min-w-0 gap-3">
          {tools.map((tool) => (
            <Checkbox
              key={tool.toolName}
              checked={selected.includes(tool.toolName)}
              disabled={disabled}
              {...{ [`data-${source.kind}-tool`]: tool.toolName }}
              label={
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <code className="min-w-0 font-mono break-all">{tool.label}</code>
                  <Badge size="sm" tone={tool.effect === "changing" ? "warning" : "neutral"}>
                    {t(
                      tool.effect === "changing"
                        ? "connections.effectChanging"
                        : "connections.effectReading"
                    )}
                  </Badge>
                </span>
              }
              description={
                tool.description ? (
                  <span className="line-clamp-2 whitespace-pre-line">{tool.description}</span>
                ) : undefined
              }
              onCheckedChange={(checked) =>
                onChange(toggleToolName(selected, tool.toolName, checked))
              }
            />
          ))}
        </div>
        {footer}
      </DisclosureContent>
    </Disclosure>
  );
}
