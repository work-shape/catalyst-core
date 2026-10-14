import { useId } from "react";
import type { ConfigAssetReferences, ToolGroupName } from "@vivd-catalyst/api-client";
import {
  Badge,
  Checkbox,
  Chip,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  IconTile,
  RegistryIcon,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@vivd-catalyst/ui";
import { useTranslation, type TranslationKey } from "../i18n";
import { useModuleName } from "../module-texts";
import {
  instanceToolGroups,
  switchToolGroup,
  type InstanceToolGroupView,
  type InstanceToolView
} from "./instance-tools";
import { toggleToolName } from "./tool-group";

/** The title, sentence and icon of each group. */
const GROUP_TEXTS: Record<
  ToolGroupName,
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
  },
  instance: {
    title: "configToolGroupInstance",
    text: "configToolGroupInstanceText",
    icon: "tool"
  }
};

/**
 * The instance's own tools in an agent's Tools section, by package: per group its icon, one
 * sentence and a switch for all its tools, and folded below each tool with its title and
 * summary. A tool the agent holds because of something else shows as included. The ids,
 * effects and packages stand under "Technical details" at the end.
 */
export function InstanceToolsGroup({
  references,
  selected,
  skillNames,
  isOtherSource,
  disabled,
  onChange
}: {
  references: ConfigAssetReferences | undefined;
  /** Every tool name the agent holds. */
  selected: readonly string[];
  skillNames: readonly string[];
  /** A name another group of the section shows: a tool of a Connection or an App. */
  isOtherSource(name: string): boolean;
  disabled?: boolean;
  onChange(selected: string[]): void;
}) {
  const { locale, t } = useTranslation();
  const moduleName = useModuleName();
  const groups = instanceToolGroups({ references, selected, skillNames, locale, isOtherSource });
  const stale = (references?.moduleOffTools ?? []).filter((tool) => selected.includes(tool.name));
  const headingId = useId();

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="grid min-w-0 gap-3"
      data-tool-group="instance"
    >
      <div className="grid gap-1">
        <h3 id={headingId} className="text-label">
          {t("configToolsOfInstance")}
        </h3>
        <p className="text-caption text-muted-foreground">{t("configToolsOfInstanceHint")}</p>
      </div>
      {groups.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("configNoTools")}</p>
      ) : null}
      {groups.map((group) => (
        <ToolGroupCard
          key={group.group}
          group={group}
          selected={selected}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
      {stale.length > 0 ? (
        <ul aria-label={t("configUnavailableSelections")} className="grid gap-2">
          {stale.map((tool) => (
            <li
              key={tool.name}
              data-unavailable-option={tool.name}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
            >
              <Chip
                size="sm"
                className="font-mono"
                onRemove={
                  disabled ? undefined : () => onChange(toggleToolName(selected, tool.name, false))
                }
              >
                {tool.name}
              </Chip>
              <span className="text-caption text-muted-foreground">
                {t("configToolModuleOff", { module: moduleName(tool.module) })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {groups.length > 0 ? <TechnicalDetails groups={groups} /> : null}
    </div>
  );
}

function ToolGroupCard({
  group,
  selected,
  disabled,
  onChange
}: {
  group: InstanceToolGroupView;
  selected: readonly string[];
  disabled?: boolean;
  onChange(selected: string[]): void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const texts = GROUP_TEXTS[group.group];
  const title = t(texts.title);
  return (
    <Disclosure variant="outline" data-instance-tool-group={group.group}>
      <div className="flex min-w-0 items-start gap-3 px-4">
        <IconTile>
          <RegistryIcon name={texts.icon} family="tool" />
        </IconTile>
        <div className="grid min-w-0 grow gap-0.5">
          <span id={titleId} className="text-label">
            {title}
          </span>
          <span className="text-caption text-muted-foreground">{t(texts.text)}</span>
        </div>
        <Switch
          aria-label={t("configToolsGroupSwitch", { group: title })}
          checked={group.state === "on"}
          mixed={group.state === "mixed"}
          disabled={disabled || group.choosable.length === 0}
          onCheckedChange={(on) => onChange(switchToolGroup(selected, group, on))}
        />
      </div>
      <DisclosureTrigger aria-describedby={titleId} className="mt-2">
        <span className="text-caption font-normal text-muted-foreground">
          {t("configToolsGroupCount", { held: group.heldCount, count: group.tools.length })}
        </span>
      </DisclosureTrigger>
      <DisclosureContent>
        <div role="group" aria-label={title} className="grid min-w-0 gap-3">
          {group.tools.map((tool) =>
            tool.includedBecause ? (
              <IncludedTool key={tool.name} tool={tool} />
            ) : (
              <Checkbox
                key={tool.name}
                data-instance-tool={tool.name}
                checked={selected.includes(tool.name)}
                disabled={disabled}
                label={tool.title}
                description={tool.summary}
                onCheckedChange={(checked) =>
                  onChange(toggleToolName(selected, tool.name, checked))
                }
              />
            )
          )}
        </div>
      </DisclosureContent>
    </Disclosure>
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
      {tool.summary ? (
        <span className="text-caption text-muted-foreground">{tool.summary}</span>
      ) : null}
      <span className="text-caption text-muted-foreground">{t("configToolsIncludedSkills")}</span>
    </div>
  );
}

/** Every tool of the groups with its id, effect and package, closed by default. */
function TechnicalDetails({ groups }: { groups: readonly InstanceToolGroupView[] }) {
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
            {groups.flatMap((group) =>
              group.tools.map((tool) => (
                <TableRow key={tool.name}>
                  <TableCell>{tool.title}</TableCell>
                  <TableCell>
                    <code className="font-mono break-all">{tool.name}</code>
                  </TableCell>
                  <TableCell>{effect(tool)}</TableCell>
                  <TableCell>
                    {tool.module ? moduleName(tool.module) : t("configToolsTechnicalCore")}
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
