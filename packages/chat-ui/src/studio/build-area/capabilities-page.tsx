import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import type { CapabilityPackage, ToolGroupName } from "@work-shape/catalyst-api-client";
import { TOOL_GROUPS } from "@work-shape/catalyst-core";
import {
  Badge,
  Button,
  EmptyState,
  IconTile,
  InlineError,
  List,
  ListRow,
  PageHeader,
  RegistryIcon,
  SkeletonList,
  SkillIcon
} from "@work-shape/catalyst-ui";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { AGENTS_BUILD_PATH, useBuildNavigation } from "../../shared/build-route";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { moduleTexts } from "../../shared/module-texts";
import { useSettingsPage } from "../../shared/settings-page-context";
import { instanceSentence } from "./build-refusals";

// Studio's "Fähigkeiten" page (TOOLS-2): what this instance's agents can be given, one row per
// package ("Paket"): the general skills and tools first, then one per module, and the instance's
// own tools last. A row folds out its skills, its tools and the agents that use them, each agent
// a link to its page. A module that is off reaches only an instance admin, marked so. The page
// changes nothing: a module is switched in the deployment's config, a tool given on the agent page.

/** The path segment of the page in Studio, below the kinds. */
export const CAPABILITIES_BUILD_PATH = "capabilities";

/** The icon and the sentence of each module whose tools an agent can be given. */
const MODULE_FACES: Partial<Record<string, { icon: string; text: TranslationKey }>> = {
  apps: { icon: "app", text: "capabilities.moduleApps" },
  assetManagement: { icon: "agent", text: "capabilities.moduleAssetManagement" },
  connections: { icon: "connection", text: "capabilities.moduleConnections" },
  workflows: { icon: "workflow", text: "capabilities.moduleWorkflows" },
  dataStores: { icon: "datastore", text: "capabilities.moduleDataStores" },
  knowledge: { icon: "knowledge_base", text: "capabilities.moduleKnowledge" }
};

/** The name of each group of the general tools, as the agent page names its packages. */
const GROUP_TITLES: Record<ToolGroupName, TranslationKey> = {
  documents: "configToolGroupDocuments",
  web: "configToolGroupWeb",
  files: "configToolGroupFiles",
  results: "configToolGroupResults",
  skills: "configToolGroupSkills",
  platform: "configToolGroupPlatform",
  instance: "configToolGroupInstance"
};

type CapabilityTool = CapabilityPackage["tools"][number];

export function CapabilitiesPage() {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  // Under the assets' key: a save of an agent changes who uses what, and reads this again.
  const query = useQuery({
    queryKey: [...workspaceQueryKeys.assets(apiBaseUrl, authScope), "capabilities"],
    queryFn: ({ signal }) => client.platform.capabilities.get({ signal }),
    retry: false
  });
  const packages = query.data?.packages;
  return (
    <>
      <PageHeader title={t("capabilities.title")} description={t("capabilities.description")} />
      {query.error ? (
        <InlineError className="flex flex-wrap items-center justify-between gap-2">
          <span>{instanceSentence(query.error, t) ?? t("capabilities.loadFailed")}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              query.refetch().catch(() => undefined);
            }}
          >
            {t("tryAgain")}
          </Button>
        </InlineError>
      ) : packages === undefined ? (
        <SkeletonList rows={6} />
      ) : packages.length === 0 ? (
        <EmptyState layout="inline">{t("capabilities.empty")}</EmptyState>
      ) : (
        <List aria-label={t("capabilities.title")} data-capabilities="">
          {packages.map((item) => (
            <PackageRow key={packageKey(item)} item={item} />
          ))}
        </List>
      )}
    </>
  );
}

/** `general`, `own` or `module:<name>`: what a row is found by. */
function packageKey(item: CapabilityPackage): string {
  return item.kind === "module" ? `module:${item.module ?? ""}` : item.kind;
}

function PackageRow({ item }: { item: CapabilityPackage }) {
  const { t } = useTranslation();
  const face = usePackageFace(item);
  const counts = [
    item.tools.length > 0 ? count(t, "tools", item.tools.length) : undefined,
    item.skills.length > 0 ? count(t, "skills", item.skills.length) : undefined,
    item.enabled ? count(t, "agents", item.agents.length) : undefined
  ].filter((part) => part !== undefined);
  return (
    <ListRow
      data-capability-package={packageKey(item)}
      data-capability-enabled={item.enabled ? "true" : "false"}
      // The row that is folded out and what it holds read as one.
      className="rounded-md data-[state=open]:bg-muted"
      expandable
      leading={
        <IconTile accent={item.enabled}>
          <RegistryIcon name={face.icon} family="tool" />
        </IconTile>
      }
      title={face.title}
      description={face.text}
      descriptionWraps
      chips={
        item.kind !== "module" ? undefined : item.enabled ? (
          <Badge tone="success" size="sm" dot>
            {t("capabilities.on")}
          </Badge>
        ) : (
          <Badge size="sm" data-capability-off="">
            {t("capabilities.off")}
          </Badge>
        )
      }
      actionsVisible
      actions={
        <span className="hidden text-caption text-muted-foreground tabular-nums sm:inline">
          {counts.join(" · ")}
        </span>
      }
    >
      <div role="group" aria-label={face.title} className="grid min-w-0 gap-4 pb-2 pl-9">
        {item.skills.length > 0 ? (
          <Part title={t("capabilities.skills")}>
            <ul className="grid gap-2">
              {item.skills.map((skill) => (
                <li
                  key={skill.name}
                  data-capability-skill={skill.name}
                  className="flex min-w-0 items-start gap-2"
                >
                  <SkillIcon icon={skill.icon} size="sm" className="mt-0.5" />
                  <Named title={skill.title.trim() || skill.name} summary={skill.summary} />
                </li>
              ))}
            </ul>
          </Part>
        ) : null}
        {item.tools.length > 0 ? (
          <Part title={t("capabilities.tools")}>
            {item.kind === "general" ? (
              <GroupedTools tools={item.tools} />
            ) : (
              <Tools tools={item.tools} />
            )}
          </Part>
        ) : null}
        {item.enabled ? (
          <Part title={t("capabilities.usedBy")}>
            <UsedBy agents={item.agents} />
          </Part>
        ) : null}
      </div>
    </ListRow>
  );
}

/** The title, sentence and icon of a row. */
function usePackageFace(item: CapabilityPackage): { title: string; text?: string; icon: string } {
  const { t } = useTranslation();
  if (item.kind === "general") {
    return { title: t("capabilities.general"), text: t("capabilities.generalText"), icon: "skill" };
  }
  if (item.kind === "own") {
    return { title: t("capabilities.own"), text: t("capabilities.ownText"), icon: "tool" };
  }
  const module = item.module ?? "";
  const face = MODULE_FACES[module];
  const texts = moduleTexts[module];
  return {
    title: texts ? t(texts.name) : module,
    ...(face ? { text: t(face.text) } : texts ? { text: t(texts.description) } : {}),
    icon: face?.icon ?? "tool"
  };
}

/** One part of a folded-out row under its small heading. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid min-w-0 gap-2">
      <h3 className="text-caption text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** A tool's or skill's name, and its sentence under it. */
function Named({ title, summary }: { title: string; summary?: string }) {
  return (
    <span className="grid min-w-0 gap-0.5">
      <span className="text-body break-words">{title}</span>
      {summary?.trim() ? (
        <span className="text-caption text-muted-foreground">{summary.trim()}</span>
      ) : null}
    </span>
  );
}

function Tools({ tools }: { tools: readonly CapabilityTool[] }) {
  const { locale } = useTranslation();
  return (
    <ul className="grid gap-2">
      {tools.map((tool) => (
        <li key={tool.name} data-capability-tool={tool.name} className="min-w-0">
          <Named
            title={tool.title?.[locale].trim() || tool.name}
            summary={tool.summary?.[locale]}
          />
        </li>
      ))}
    </ul>
  );
}

/** The general tools under the names the agent page gives their groups, in its order. */
function GroupedTools({ tools }: { tools: readonly CapabilityTool[] }) {
  const { t } = useTranslation();
  return (
    <div className="grid min-w-0 gap-3">
      {TOOL_GROUPS.map((group) => {
        const of = tools.filter((tool) => (tool.group ?? "instance") === group);
        return of.length === 0 ? null : (
          <div key={group} className="grid min-w-0 gap-2" data-capability-group={group}>
            <h4 className="text-caption font-medium">{t(GROUP_TITLES[group])}</h4>
            <Tools tools={of} />
          </div>
        );
      })}
    </div>
  );
}

/** The agents that use the package, each a link to its page. */
function UsedBy({ agents }: { agents: CapabilityPackage["agents"] }) {
  const { t } = useTranslation();
  const { href, open } = useBuildNavigation();
  if (agents.length === 0) {
    return <p className="text-body text-muted-foreground">{t("capabilities.usedByNone")}</p>;
  }
  return (
    <List aria-label={t("capabilities.usedBy")}>
      {agents.map((agent) => {
        const place = { kindPath: AGENTS_BUILD_PATH, name: agent.name };
        return (
          <ListRow
            key={agent.name}
            size="compact"
            data-capability-agent={agent.name}
            leading={<Bot aria-hidden="true" className="size-4 text-muted-foreground" />}
            title={agent.title.trim() || agent.name}
            link={
              <a
                href={href(place)}
                onClick={(event: MouseEvent) => {
                  if (
                    event.button === 0 &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey
                  ) {
                    event.preventDefault();
                    open(place);
                  }
                }}
              />
            }
          />
        );
      })}
    </List>
  );
}

/** Each count's words for many, and for one. */
const COUNT_WORDS = {
  tools: ["capabilities.toolCount", "capabilities.toolCountOne"],
  skills: ["capabilities.skillCount", "capabilities.skillCountOne"],
  agents: ["capabilities.agentCount", "capabilities.agentCountOne"]
} as const satisfies Record<string, readonly [TranslationKey, TranslationKey]>;

function count(
  t: ReturnType<typeof useTranslation>["t"],
  what: keyof typeof COUNT_WORDS,
  value: number
): string {
  const [many, one] = COUNT_WORDS[what];
  return value === 1 ? t(one) : t(many, { count: value });
}
