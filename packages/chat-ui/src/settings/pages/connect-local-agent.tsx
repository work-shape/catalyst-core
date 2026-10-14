import { useState } from "react";
import {
  Banner,
  CommandLine,
  PageHeader,
  Section,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
  TextLink
} from "@vivd-catalyst/ui";
import { usePlatformContextQuery } from "../../api/workspace-queries";
import { instanceUrl } from "../../control-plane/personal-api-keys-model";
import { useTranslation, type TranslationKey } from "../../i18n";
import { workspaceRoutePath } from "../../routes";
import { useSettingsPage } from "../settings-page-context";

/** The tools `catalyst setup` writes a skill for, by the word the command takes. */
export const LOCAL_AGENT_TOOLS = ["claude-code", "codex", "other"] as const;
export type LocalAgentTool = (typeof LOCAL_AGENT_TOOLS)[number];

const toolNames: Record<LocalAgentTool, { label: string } | { labelKey: TranslationKey }> = {
  "claude-code": { label: "Claude Code" },
  codex: { label: "Codex" },
  other: { labelKey: "localAgent.other" }
};

/**
 * The one command that connects a local agent: it installs the CLI of the instance's own
 * release and runs `catalyst setup` for the tool against the instance's address.
 */
export function localAgentCommand(tool: LocalAgentTool, version: string, url: string): string {
  return `npm install --global @work-shape/catalyst-cli@${version} && catalyst setup ${tool} --instance ${url}`;
}

/**
 * You > Connect a local agent: the person picks Claude Code, Codex or another tool and copies
 * one command. Nothing here is a secret, so the page issues nothing: no key and no connect code
 * exists until the command runs. It reads only the instance's release from its context.
 */
export function ConnectLocalAgentPage() {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const [tool, setTool] = useState<LocalAgentTool>("claude-code");
  const contextQuery = usePlatformContextQuery({ apiBaseUrl, authScope, client, enabled: true });
  const version = contextQuery.data?.release.version;
  return (
    <ConnectLocalAgentView
      tool={tool}
      onToolChange={setTool}
      command={
        version === undefined
          ? undefined
          : localAgentCommand(tool, version, instanceUrl(apiBaseUrl, window.location.origin))
      }
      failed={contextQuery.isError}
    />
  );
}

export function ConnectLocalAgentView({
  tool,
  onToolChange,
  command,
  failed
}: {
  tool: LocalAgentTool;
  onToolChange(tool: LocalAgentTool): void;
  /** Absent while the instance's release is read. */
  command: string | undefined;
  failed: boolean;
}) {
  const { t } = useTranslation();
  const name = (choice: LocalAgentTool) => {
    const entry = toolNames[choice];
    return "label" in entry ? entry.label : t(entry.labelKey);
  };
  const toolInSentence = tool === "other" ? t("localAgent.otherTool") : name(tool);

  return (
    <>
      <PageHeader
        title={t("settings.connectLocalAgent")}
        description={t("localAgent.description")}
      />
      <Section layout="stacked" title={t("localAgent.tool")}>
        <div className="grid justify-items-start">
          <SegmentedControl
            label={t("localAgent.tool")}
            value={tool}
            onValueChange={(value) => {
              const next = LOCAL_AGENT_TOOLS.find((candidate) => candidate === value);
              if (next) onToolChange(next);
            }}
          >
            {LOCAL_AGENT_TOOLS.map((choice) => (
              <SegmentedControlItem key={choice} value={choice}>
                {name(choice)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
      </Section>
      <Section
        layout="stacked"
        title={t("localAgent.command")}
        description={t("localAgent.commandHint")}
      >
        {failed ? (
          <Banner tone="danger">{t("settings.requestFailed")}</Banner>
        ) : command === undefined ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <CommandLine
            command={command}
            label={t("localAgent.commandLabel", { tool: name(tool) })}
          />
        )}
      </Section>
      <Section
        layout="stacked"
        title={t("localAgent.next")}
        description={
          <>
            {t("localAgent.nextDescription", { tool: toolInSentence })}{" "}
            <TextLink
              href={workspaceRoutePath({ kind: "settings", group: "you", page: "api-keys" })}
            >
              {t("localAgent.keysLink")}
            </TextLink>
          </>
        }
      />
    </>
  );
}
