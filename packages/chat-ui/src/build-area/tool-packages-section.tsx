import { useState, type ReactNode } from "react";
import type { ConfigAssetReferences, ToolGroupName } from "@vivd-catalyst/api-client";
import {
  Badge,
  Button,
  Checkbox,
  Chip,
  ConnectionIcon,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  IconTile,
  Picker,
  PickerButton,
  RegistryIcon,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@vivd-catalyst/ui";
import { connectionCategory } from "../connection-facts";
import { useTranslation, type TranslationKey } from "../i18n";
import { useModuleName } from "../module-texts";
import { connectionToolsView, type ConnectionToolChoice } from "./connection-tools";
import {
  setPackageTools,
  toolPackages,
  type InstanceToolView,
  type ToolPackageView
} from "./instance-tools";
import { ToolChip, toggleToolName } from "./tool-group";

/** The title, sentence and icon of each package of the platform. */
const PACKAGE_TEXTS: Record<
  Exclude<ToolGroupName, "instance">,
  { title: TranslationKey; text: TranslationKey; icon: string }
> = {
  documents: {
    title: "configToolGroupDocuments",
    text: "configToolGroupDocumentsText",
    icon: "document"
  },
  web: { title: "configToolGroupWeb", text: "configToolGroupWebText", icon: "web" },
  files: { title: "configToolGroupFiles", text: "configToolGroupFilesText", icon: "code" },
  results: { title: "configToolGroupResults", text: "configToolGroupResultsText", icon: "result" },
  skills: { title: "configToolGroupSkills", text: "configToolGroupSkillsText", icon: "skill" },
  platform: {
    title: "configToolGroupPlatform",
    text: "configToolGroupPlatformText",
    icon: "guide"
  }
};

/** What a chip, its panel and its picker row show of one package, own tool or Connection. */
interface PackageFace {
  title: string;
  text?: string;
  /** The icon inside the chip. */
  chipIcon: ReactNode;
  /** The icon on its tile, in the panel and the picker. */
  tile: ReactNode;
}

/**
 * The tools of an agent, as its Skills are: a chip per package ("Paket") it uses, per own tool
 * of this instance and per Connection, and a picker that adds the others with all their tools
 * on. A chip shows how many of its tools are on while only some are; it opens a panel with its
 * tools as check boxes, the ones the agent holds because of something else as included. The
 * ids, effects and packages stand under "Technical details".
 */
export function ToolPackagesSection({
  references,
  selected,
  skillNames,
  connectionTools,
  isOtherSource,
  disabled,
  onChange
}: {
  references: ConfigAssetReferences | undefined;
  /** Every tool name the agent holds. */
  selected: readonly string[];
  skillNames: readonly string[];
  connectionTools: ConnectionToolChoice;
  /** A name a later group of the section shows: a tool of an App. */
  isOtherSource(name: string): boolean;
  disabled?: boolean;
  onChange(selected: string[]): void;
}) {
  const { locale, t } = useTranslation();
  const moduleName = useModuleName();
  const items = toolPackages({
    references,
    selected,
    skillNames,
    locale,
    connections: connectionTools.read,
    isOtherSource
  });
  const face = (item: ToolPackageView): PackageFace => {
    if (item.kind === "package" && item.group && item.group !== "instance") {
      const texts = PACKAGE_TEXTS[item.group];
      return {
        title: t(texts.title),
        text: t(texts.text),
        chipIcon: <RegistryIcon name={texts.icon} family="tool" />,
        tile: (
          <IconTile accent>
            <RegistryIcon name={texts.icon} family="tool" />
          </IconTile>
        )
      };
    }
    if (item.connection) {
      const category = connectionCategory(item.connection.connectorType);
      return {
        title: item.title ?? item.connection.name,
        chipIcon: (
          <RegistryIcon name={item.connection.service} fallback={category} family="service" />
        ),
        tile: <ConnectionIcon service={item.connection.service} category={category} />
      };
    }
    const icon = item.tools[0]?.icon;
    return {
      title: item.title ?? item.key,
      ...(item.summary ? { text: item.summary } : {}),
      chipIcon: <RegistryIcon name={icon} family="tool" />,
      tile: (
        <IconTile accent>
          <RegistryIcon name={icon} family="tool" />
        </IconTile>
      )
    };
  };
  const active = items.filter((item) => item.heldCount > 0);
  const offered = items.filter((item) => item.heldCount === 0 && item.choosable.length > 0);
  const stale = (references?.moduleOffTools ?? []).filter((tool) => selected.includes(tool.name));
  const connections = connectionToolsView(connectionTools.read, selected);
  const removeName = disabled
    ? undefined
    : (toolName: string) => onChange(toggleToolName(selected, toolName, false));

  const pickerGroups = (
    [
      ["package", t("configToolsPickerPackages")],
      ["own", t("configToolGroupInstance")],
      ["connection", t("connections.kind")]
    ] as const
  )
    .map(([kind, heading]) => ({
      heading,
      options: offered
        .filter((item) => item.kind === kind)
        .map((item) => {
          const { title, text, tile } = face(item);
          return {
            value: item.key,
            label: title,
            ...(text ? { description: text } : {}),
            keywords: item.tools.map((tool) => tool.name).join(" "),
            leading: tile,
            trailing: (
              <Badge size="sm">
                {item.tools.length === 1
                  ? t("configToolsCountOne")
                  : t("configToolsCount", { count: item.tools.length })}
              </Badge>
            )
          };
        })
    }))
    .filter((group) => group.options.length > 0);

  return (
    <div className="grid min-w-0 gap-3" data-tool-group="packages">
      {active.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("configToolsNone")}</p>
      ) : (
        <ul aria-label={t("configTools")} className="flex flex-wrap gap-2">
          {active.map((item) => (
            <li key={item.key} data-tool-package={item.key}>
              <PackageChip
                item={item}
                face={face(item)}
                selected={selected}
                disabled={disabled}
                link={item.connection ? connectionTools.place?.(item.connection.name) : undefined}
                onChange={onChange}
              />
            </li>
          ))}
        </ul>
      )}
      {stale.length > 0 ? (
        <ul aria-label={t("configUnavailableSelections")} className="grid gap-2">
          {stale.map((tool) => (
            <li
              key={tool.name}
              data-unavailable-option={tool.name}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
            >
              <ToolChip toolName={tool.name} remove={removeName} />
              <span className="text-caption text-muted-foreground">
                {t("configToolModuleOff", { module: moduleName(tool.module) })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {connections.unchecked.length > 0 ? (
        <ul aria-label={t("connections.toolsHeld")} className="grid gap-2">
          {connections.unchecked.map((toolName) => (
            <li
              key={toolName}
              data-held-option={toolName}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
            >
              <ToolChip toolName={toolName} remove={removeName} />
              <span className="text-caption text-muted-foreground">
                {t(
                  connectionTools.read.status === "loading"
                    ? "connections.toolsLoading"
                    : "connections.toolsUnknown"
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {connections.unavailable.length > 0 ? (
        <div className="grid gap-2" data-tool-group="unavailable">
          <p className="text-caption text-muted-foreground">
            {t("connections.toolsUnavailableText")}
          </p>
          <ul
            aria-label={t("connections.toolsUnavailableTitle")}
            className="flex min-w-0 flex-wrap gap-2"
          >
            {connections.unavailable.map((toolName) => (
              <li key={toolName} data-unavailable-option={toolName} className="min-w-0">
                <ToolChip toolName={toolName} remove={removeName} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!disabled && pickerGroups.length > 0 ? (
        <div>
          <Picker
            multiple
            search
            wrapDescriptions
            className="w-120"
            label={t("configToolsAdd")}
            options={pickerGroups}
            value={[]}
            onValueChange={(keys) => {
              const added = offered.find((item) => keys.includes(item.key));
              if (added) {
                onChange(setPackageTools(selected, added, true));
              }
            }}
          >
            <PickerButton
              label={t("configTools")}
              placeholder={t("configToolsAdd")}
              value={undefined}
            />
          </Picker>
        </div>
      ) : null}
      {items.length > 0 ? <TechnicalDetails items={items} faces={face} /> : null}
    </div>
  );
}

/** One chip, and the panel it opens with its tools. */
function PackageChip({
  item,
  face,
  selected,
  disabled,
  link,
  onChange
}: {
  item: ToolPackageView;
  face: PackageFace;
  selected: readonly string[];
  disabled?: boolean;
  link: { href: string; open(): void } | undefined;
  onChange(selected: string[]): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const total = item.tools.length;
  const choosableOn = item.choosable.filter((name) => selected.includes(name)).length;
  const allOn = choosableOn === item.choosable.length;
  const remove = () => {
    setOpen(false);
    onChange(setPackageTools(selected, item, false));
  };
  return (
    <Chip
      leading={face.chipIcon}
      trailing={item.heldCount < total ? `${item.heldCount}/${total}` : undefined}
      // What the agent holds because of something else cannot be removed here.
      onRemove={disabled || choosableOn === 0 ? undefined : remove}
      popover={{
        open,
        onOpenChange: setOpen,
        className: "w-90",
        content: (
          <div className="grid min-w-0 gap-4" data-tool-panel={item.key}>
            <div className="flex min-w-0 items-start gap-3">
              {face.tile}
              <div className="grid min-w-0 gap-0.5">
                <span className="text-label">{face.title}</span>
                {face.text ? (
                  <span className="text-caption text-muted-foreground">{face.text}</span>
                ) : null}
              </div>
            </div>
            {/* An own tool is one tool: the chip already names it. */}
            {item.kind === "own" ? null : (
              <div role="group" aria-label={face.title} className="grid min-w-0 gap-3">
                {item.tools.map((tool) =>
                  tool.includedBecause ? (
                    <IncludedTool key={tool.name} tool={tool} />
                  ) : (
                    <Checkbox
                      key={tool.name}
                      data-package-tool={tool.name}
                      checked={selected.includes(tool.name)}
                      disabled={disabled}
                      label={tool.title}
                      description={
                        tool.summary ? (
                          <span className="line-clamp-2">{tool.summary}</span>
                        ) : undefined
                      }
                      onCheckedChange={(checked) =>
                        onChange(toggleToolName(selected, tool.name, checked))
                      }
                    />
                  )
                )}
              </div>
            )}
            {disabled && !link ? null : (
              <div className="-mx-4 -mb-4 flex flex-wrap items-center justify-between gap-2 border-t px-2 py-2">
                {disabled || choosableOn === 0 ? (
                  <span />
                ) : (
                  <Button variant="ghost" size="sm" onClick={remove}>
                    {t(item.kind === "package" ? "configToolsRemovePackage" : "configToolsRemove")}
                  </Button>
                )}
                <span className="flex items-center gap-1">
                  {link ? (
                    <Button asChild variant="ghost" size="sm">
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
                  ) : null}
                  {disabled || item.kind === "own" ? null : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={allOn}
                      onClick={() => onChange(setPackageTools(selected, item, true))}
                    >
                      {t("configToolsAllOn")}
                    </Button>
                  )}
                </span>
              </div>
            )}
          </div>
        )
      }}
    >
      {face.title}
    </Chip>
  );
}

/** A tool the agent holds because of something else: no check box, the reason instead. */
function IncludedTool({ tool }: { tool: InstanceToolView }) {
  const { t } = useTranslation();
  return (
    <div data-included-tool={tool.name} className="grid min-w-0 gap-0.5 pl-6">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body">
        <span className="min-w-0 break-words">{tool.title}</span>
        <Badge size="sm">{t("configToolsIncluded")}</Badge>
      </span>
      <span className="text-caption text-muted-foreground">{t("configToolsIncludedSkills")}</span>
    </div>
  );
}

/** Every tool the section knows with its id, effect and package, closed by default. */
function TechnicalDetails({
  items,
  faces
}: {
  items: readonly ToolPackageView[];
  faces(item: ToolPackageView): PackageFace;
}) {
  const { t } = useTranslation();
  const moduleName = useModuleName();
  const effect = (tool: InstanceToolView) =>
    t(
      tool.effect === "reading"
        ? "configToolsEffectReading"
        : tool.effect === "changing"
          ? "configToolsEffectChanging"
          : "configToolsEffectUnknown"
    );
  return (
    <Disclosure data-tool-technical-details="">
      <DisclosureTrigger>{t("configToolsTechnical")}</DisclosureTrigger>
      <DisclosureContent>
        <Table density="compact" narrow="stack">
          <TableHeader>
            <TableRow>
              <TableHead>{t("configToolsTechnicalTool")}</TableHead>
              <TableHead>{t("configToolsTechnicalId")}</TableHead>
              <TableHead>{t("configToolsTechnicalEffect")}</TableHead>
              <TableHead>{t("configToolsTechnicalPackage")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.flatMap((item) =>
              item.tools.map((tool) => (
                <TableRow key={tool.name}>
                  <TableCell>{tool.title}</TableCell>
                  <TableCell>
                    <code className="font-mono break-all">{tool.name}</code>
                  </TableCell>
                  <TableCell>{effect(tool)}</TableCell>
                  <TableCell>
                    {tool.module
                      ? moduleName(tool.module)
                      : item.connection
                        ? faces(item).title
                        : t("configToolsTechnicalCore")}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </DisclosureContent>
    </Disclosure>
  );
}
