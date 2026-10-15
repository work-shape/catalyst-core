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
} from "@work-shape/catalyst-ui";
import { usePlatformContextQuery } from "../../../shared/api/workspace-queries";
import { instanceUrl } from "../../control-plane/personal-api-keys-model";
import { useTranslation, type TranslationKey } from "../../../shared/i18n";
import { workspaceRoutePath } from "../../../shared/routes";
import { useSettingsPage } from "../../../shared/settings-page-context";

/** The tools `catalyst setup` writes a skill for, by the word the command takes. */
export const LOCAL_AGENT_TOOLS = ["claude-code", "codex", "other"] as const;
export type LocalAgentTool = (typeof LOCAL_AGENT_TOOLS)[number];

const toolNames: Record<LocalAgentTool, { label: string } | { labelKey: TranslationKey }> = {
  "claude-code": { label: "Claude Code" },
  codex: { label: "Codex" },
  other: { labelKey: "localAgent.other" }
};

/**
 * The one command that connects a local agent: it installs the CLI version the instance names
 * and runs `catalyst setup` for the tool against the instance's address.
 */
export function localAgentCommand(tool: LocalAgentTool, version: string, url: string): string {
  return `npm install --global @work-shape/catalyst-cli@${version} && catalyst setup ${tool} --instance ${url}`;
}

/** The command as the page has it: read, unread, unreadable, or not offered by the instance. */
export type LocalAgentCommandState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "unavailable" }
  | { status: "ready"; command: string };

/**
 * You > Connect a local agent: the person picks Claude Code, Codex or another tool and copies
 * one command. Nothing here is a secret, so the page issues nothing: no key and no connect code
 * exists until the command runs. It reads only the CLI version the instance's context names,
 * one that is on npm; while the instance names none, it offers no command.
 */
export function ConnectLocalAgentPage() {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const [tool, setTool] = useState<LocalAgentTool>("claude-code");
  const contextQuery = usePlatformContextQuery({ apiBaseUrl, authScope, client, enabled: true });
  const version = contextQuery.data?.release.cliVersion;
  const state: LocalAgentCommandState = contextQuery.isError
    ? { status: "failed" }
    : contextQuery.data === undefined
      ? { status: "loading" }
      : version === undefined
        ? { status: "unavailable" }
        : {
            status: "ready",
            command: localAgentCommand(
              tool,
              version,
              instanceUrl(apiBaseUrl, window.location.origin)
            )
          };
  return <ConnectLocalAgentView tool={tool} onToolChange={setTool} state={state} />;
}

export function ConnectLocalAgentView({
  tool,
  onToolChange,
  state
}: {
  tool: LocalAgentTool;
  onToolChange(tool: LocalAgentTool): void;
  state: LocalAgentCommandState;
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
        {state.status === "failed" ? (
          <Banner tone="danger">{t("settings.requestFailed")}</Banner>
        ) : state.status === "loading" ? (
          <Skeleton className="h-10 w-full" />
        ) : state.status === "unavailable" ? (
          <Banner>{t("localAgent.unavailable")}</Banner>
        ) : (
          <CommandLine
            command={state.command}
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
