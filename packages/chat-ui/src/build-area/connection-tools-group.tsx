import {
  Badge,
  Button,
  Checkbox,
  Chip,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger
} from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import {
  connectionToolsView,
  toggleToolName,
  type ConnectionToolChoice,
  type ConnectionToolGroupView
} from "./connection-tools";

/**
 * The tools of Connections in an agent's Tools section: one folding group per Connection the
 * reader may read, a check box per operation agents may call, and after them a group of its
 * own with the names the agent holds that nothing offers. Those stay until the reader removes
 * them.
 *
 * It is one group of the section beside the instance's own tools. A group for another source
 * of tools is a sibling of the same build: a labelled `fieldset` after this one.
 */
export function ConnectionToolsGroup({
  choice,
  selected,
  disabled,
  onChange
}: {
  choice: ConnectionToolChoice;
  /** Every tool name the agent holds. The group reads and changes those of Connections. */
  selected: readonly string[];
  disabled?: boolean;
  onChange(selected: string[]): void;
}) {
  const { t } = useTranslation();
  const { read, place } = choice;
  const view = connectionToolsView(read, selected);
  const remove = disabled
    ? undefined
    : (toolName: string) => onChange(toggleToolName(selected, toolName, false));
  // An instance that answers nothing of Connections shows the group only for what the agent holds.
  if (read.status !== "ready" && view.unchecked.length === 0) {
    return null;
  }

  return (
    <>
      <fieldset className="grid min-w-0 gap-3" data-tool-group="connections">
        <legend className="text-label">{t("connections.kind")}</legend>
        <p className="text-caption text-muted-foreground">{t("connections.toolsHint")}</p>
        {read.status === "ready" && view.groups.length === 0 ? (
          <p className="text-body text-muted-foreground">{t("connections.toolsEmpty")}</p>
        ) : null}
        {view.groups.map((group) => (
          <ConnectionGroup
            key={group.name}
            group={group}
            selected={selected}
            disabled={disabled}
            link={place?.(group.name)}
            onChange={onChange}
          />
        ))}
        {view.unchecked.length > 0 ? (
          <ul aria-label={t("connections.toolsHeld")} className="grid gap-2">
            {view.unchecked.map((toolName) => (
              <li
                key={toolName}
                data-held-option={toolName}
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
              >
                <ToolChip toolName={toolName} remove={remove} />
                <span className="text-caption text-muted-foreground">
                  {t(
                    read.status === "loading"
                      ? "connections.toolsLoading"
                      : "connections.toolsUnknown"
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </fieldset>
      {view.unavailable.length > 0 ? (
        // A group of its own at the end: what nothing offers belongs to no Connection shown.
        <fieldset className="grid min-w-0 gap-3" data-tool-group="unavailable">
          <legend className="text-label">{t("connections.toolsUnavailableTitle")}</legend>
          <p className="text-caption text-muted-foreground">
            {t("connections.toolsUnavailableText")}
          </p>
          <ul className="flex min-w-0 flex-wrap gap-2">
            {view.unavailable.map((toolName) => (
              <li key={toolName} data-unavailable-option={toolName} className="min-w-0">
                <ToolChip toolName={toolName} remove={remove} />
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
    </>
  );
}

/** A tool name the agent holds that no check box stands for. It can only be removed. */
function ToolChip({
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

function ConnectionGroup({
  group,
  selected,
  disabled,
  link,
  onChange
}: {
  group: ConnectionToolGroupView;
  selected: readonly string[];
  disabled?: boolean;
  link: { href: string; open(): void } | undefined;
  onChange(selected: string[]): void;
}) {
  const { t } = useTranslation();
  const title = group.title.trim() || group.name;
  return (
    <Disclosure variant="outline" defaultOpen={group.startsOpen} data-connection-tools={group.name}>
      <DisclosureTrigger>
        <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="min-w-0 break-words text-foreground">{title}</span>
          <span className="text-caption font-normal text-muted-foreground">
            {t("connections.toolsSelected", {
              selected: group.selectedCount,
              count: group.tools.length
            })}
          </span>
        </span>
      </DisclosureTrigger>
      <DisclosureContent>
        <div role="group" aria-label={title} className="grid min-w-0 gap-3">
          {group.tools.map((tool) => (
            <Checkbox
              key={tool.toolName}
              checked={selected.includes(tool.toolName)}
              disabled={disabled}
              data-connection-tool={tool.toolName}
              label={
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <code className="min-w-0 font-mono break-all">{tool.operation}</code>
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
        {link ? (
          <div>
            <Button asChild variant="link" size="sm" className="px-0">
              <a
                href={link.href}
                onClick={(event) => {
                  if (
                    event.button === 0 &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey
                  ) {
                    event.preventDefault();
                    link.open();
                  }
                }}
              >
                {t("connections.toolsOpenConnection")}
              </a>
            </Button>
          </div>
        ) : null}
      </DisclosureContent>
    </Disclosure>
  );
}
