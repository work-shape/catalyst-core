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
 * reader may read, a check box per operation agents may call, and under them the names the
 * agent holds that no group offers. Those stay until the reader removes them.
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
  const kept = [...view.unavailable, ...view.unchecked];
  // An instance that answers nothing of Connections shows the group only for what the agent holds.
  if (read.status !== "ready" && kept.length === 0) {
    return null;
  }
  const keptReason =
    read.status === "ready"
      ? t("connections.toolUnavailable")
      : read.status === "loading"
        ? t("connections.toolsLoading")
        : t("connections.toolsUnknown");

  return (
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
      {kept.length > 0 ? (
        <ul
          aria-label={
            read.status === "ready" ? t("configUnavailableSelections") : t("connections.toolsHeld")
          }
          className="grid gap-2"
        >
          {kept.map((toolName) => (
            <li
              key={toolName}
              {...(read.status === "ready"
                ? { "data-unavailable-option": toolName }
                : { "data-held-option": toolName })}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
            >
              <Chip
                size="sm"
                className="max-w-full font-mono"
                onRemove={
                  disabled ? undefined : () => onChange(toggleToolName(selected, toolName, false))
                }
              >
                <span className="break-all">{toolName}</span>
              </Chip>
              <span className="text-caption text-muted-foreground">{keptReason}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </fieldset>
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
