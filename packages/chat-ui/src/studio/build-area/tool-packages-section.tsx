import type { ReactNode } from "react";
import type { Asset, ConfigAssetReferences, ToolGroupName } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Button,
  Checkbox,
  ConnectionIcon,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  IconTile,
  List,
  ListRow,
  RegistryIcon,
  SkeletonList,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn
} from "@work-shape/catalyst-ui";
import { connectionCategory } from "../../shared/connection-facts";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { useModuleName } from "../../shared/module-texts";
import { connectionToolsView, type ConnectionToolChoice } from "./connection-tools";
import {
  packageSwitchState,
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

/** What a row shows of one package, own tool or Connection. */
interface PackageFace {
  title: string;
  text?: string;
  /** The icon on its tile. `on` while the agent holds one of its tools. */
  tile(on: boolean): ReactNode;
}

/**
 * The tools of an agent as one row per package ("Paket") of the platform, then per own tool of
 * this instance and per Connection, those it uses none of too. A row shows its icon, name and
 * sentence, how many of its tools are on, and a switch that turns all of them on or off, mixed
 * while only some are; its chevron folds out its tools, each with a check box, the ones the
 * agent holds because of something else as included. The ids, effects and packages stand under
 * "Technical details".
 */
export function ToolPackagesSection({
  references,
  loading = false,
  selected,
  skillNames,
  connectionTools,
  unavailable = [],
  isOtherSource,
  disabled,
  onChange
}: {
  references: ConfigAssetReferences | undefined;
  /** The references are on their way: the section shows its loading layout until they arrive. */
  loading?: boolean;
  /** Every tool name the agent holds. */
  selected: readonly string[];
  skillNames: readonly string[];
  connectionTools: ConnectionToolChoice;
  /** The tools the stored agent names that this instance cannot run, with the reason. */
  unavailable?: NonNullable<Asset["unavailableTools"]>;
  /** A name a later group of the section shows: a tool of an App. */
  isOtherSource(name: string): boolean;
  disabled?: boolean;
  onChange(selected: string[]): void;
}) {
  const { locale, t } = useTranslation();
  const moduleName = useModuleName();
  if (loading) {
    // Before the references arrive no tool's package is known, and a tool would show by its id.
    return <SkeletonList rows={6} data-tool-loading="" />;
  }
  const items = toolPackages({
    references,
    selected,
    skillNames,
    locale,
    connections: connectionTools.read,
    unavailable: unavailable.map((tool) => tool.name),
    isOtherSource
  });
  const face = (item: ToolPackageView): PackageFace => {
    if (item.kind === "package" && item.group && item.group !== "instance") {
      const texts = PACKAGE_TEXTS[item.group];
      return {
        title: t(texts.title),
        text: t(texts.text),
        tile: (on) => (
          <IconTile accent={on}>
            <RegistryIcon name={texts.icon} family="tool" />
          </IconTile>
        )
      };
    }
    if (item.connection) {
      const { service, connectorType } = item.connection;
      return {
        title: item.title ?? item.connection.name,
        tile: () => (
          <ConnectionIcon service={service} category={connectionCategory(connectorType)} />
        )
      };
    }
    const icon = item.tools[0]?.icon;
    return {
      title: item.title ?? item.key,
      ...(item.summary ? { text: item.summary } : {}),
      tile: (on) => (
        <IconTile accent={on}>
          <RegistryIcon name={icon} family="tool" />
        </IconTile>
      )
    };
  };
  const stale = unavailable.filter((tool) => selected.includes(tool.name));
  const connections = connectionToolsView(connectionTools.read, selected);
  const removeName = disabled
    ? undefined
    : (toolName: string) => onChange(toggleToolName(selected, toolName, false));
  const rows = (kind: ToolPackageView["kind"], label: string) => {
    const of = items.filter((item) => item.kind === kind);
    return of.length === 0 ? null : (
      <List aria-label={label}>
        {of.map((item) => (
          <PackageRow
            key={item.key}
            item={item}
            face={face(item)}
            selected={selected}
            disabled={disabled}
            link={item.connection ? connectionTools.place?.(item.connection.name) : undefined}
            onChange={onChange}
          />
        ))}
      </List>
    );
  };
  const subheading = (kind: ToolPackageView["kind"], label: string) =>
    items.some((item) => item.kind === kind) ? (
      <h3 className="mt-2 text-caption text-muted-foreground">{label}</h3>
    ) : null;

  return (
    <div className="grid min-w-0 gap-1" data-tool-group="packages">
      {items.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("configNoTools")}</p>
      ) : null}
      {rows("package", t("configToolsPackages"))}
      {subheading("own", t("configToolGroupInstance"))}
      {rows("own", t("configToolGroupInstance"))}
      {subheading("connection", t("connections.kind"))}
      {rows("connection", t("connections.kind"))}
      {stale.length > 0 ? (
        <ul aria-label={t("configUnavailableSelections")} className="mt-2 grid gap-2">
          {stale.map((tool) => (
            <li
              key={tool.name}
              data-unavailable-option={tool.name}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
            >
              <ToolChip toolName={tool.name} remove={removeName} />
              <span className="text-caption text-muted-foreground">
                {tool.reason === "module_off"
                  ? t("configToolModuleOff", { module: moduleName(tool.module) })
                  : t("configToolUnknown")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {connections.unchecked.length > 0 ? (
        <ul aria-label={t("connections.toolsHeld")} className="mt-2 grid gap-2">
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
        <div className="mt-2 grid gap-2" data-tool-group="unavailable">
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
      {items.length > 0 ? <TechnicalDetails items={items} faces={face} /> : null}
    </div>
  );
}

/** One row, and the tools it folds out. */
function PackageRow({
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
  const total = item.tools.length;
  const state = packageSwitchState(item, selected);
  return (
    <ListRow
      data-tool-package={item.key}
      // The row that is folded out and its tools read as one.
      className="rounded-md data-[state=open]:bg-muted"
      expandable
      leading={face.tile(item.heldCount > 0)}
      title={face.title}
      description={face.text}
      descriptionWraps
      actionsVisible
      actions={
        <span className="flex items-center gap-3">
          <span
            data-tool-count=""
            className={cn(
              "text-caption tabular-nums",
              item.heldCount === 0
                ? "text-muted-foreground"
                : item.heldCount === total
                  ? "text-success-soft-foreground"
                  : "font-semibold text-primary-soft-foreground"
            )}
          >
            {item.heldCount}/{total}
          </span>
          <Switch
            aria-label={t("configToolsGroupSwitch", { group: face.title })}
            checked={state === "on"}
            mixed={state === "mixed"}
            disabled={disabled || item.choosable.length === 0}
            onCheckedChange={(on) => onChange(setPackageTools(selected, item, on))}
          />
        </span>
      }
    >
      <div role="group" aria-label={face.title} className="grid min-w-0 gap-3 pl-9">
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
                tool.summary ? <span className="line-clamp-2">{tool.summary}</span> : undefined
              }
              onCheckedChange={(checked) => onChange(toggleToolName(selected, tool.name, checked))}
            />
          )
        )}
        {link ? (
          <span>
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
          </span>
        ) : null}
      </div>
    </ListRow>
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
