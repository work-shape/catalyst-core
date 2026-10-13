import {
  StreamdownTextPrimitive,
  type ControlsConfig as AssistantControlsConfig
} from "@assistant-ui/react-streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Streamdown, type ControlsConfig, type StreamdownTranslations } from "streamdown";
import { useTranslation } from "./i18n";
import { markdownRehypePlugins, type MarkdownLinkPolicy } from "./markdown-security";

const plugins = { code, mermaid };
const controls: ControlsConfig = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: true },
  mermaid: { copy: true, download: false, fullscreen: true, panZoom: true }
};
// The assistant-ui wrapper still exposes Streamdown's older, narrower control type,
// while passing this object through to the current Streamdown runtime unchanged.
const assistantControls = controls as AssistantControlsConfig;

const MarkdownLinkPolicyContext = createContext<MarkdownLinkPolicy | undefined>(undefined);

/**
 * Names the hosts links in replies and Markdown file previews may point to besides the
 * instance. Without it only links to the page's own origin stay links.
 */
export function MarkdownLinkPolicyProvider({
  allowedLinkHosts,
  ownOrigins,
  children
}: {
  /** `replies.allowedLinkHosts` of the instance config. */
  allowedLinkHosts: readonly string[];
  /** The instance's own origins; the page's origin is always one. */
  ownOrigins: readonly string[];
  children: ReactNode;
}) {
  // The config is fetched again from time to time; compared by content so that an equal list
  // does not render every reply again.
  const hostsKey = allowedLinkHosts.join(" ");
  const originsKey = ownOrigins.join(" ");
  const value = useMemo<MarkdownLinkPolicy>(
    () => ({
      allowedLinkHosts: hostsKey ? hostsKey.split(" ") : [],
      ownOrigins: originsKey ? originsKey.split(" ") : []
    }),
    [hostsKey, originsKey]
  );
  return (
    <MarkdownLinkPolicyContext.Provider value={value}>
      {children}
    </MarkdownLinkPolicyContext.Provider>
  );
}

function useMarkdownRehypePlugins() {
  const policy = useContext(MarkdownLinkPolicyContext);
  return useMemo(
    () => markdownRehypePlugins(policy ?? { allowedLinkHosts: [], ownOrigins: pageOrigin() }),
    [policy]
  );
}

function pageOrigin(): string[] {
  return typeof window === "undefined" ? [] : [window.location.origin];
}

export function MarkdownText() {
  const translations = useMarkdownTranslations();
  const rehypePlugins = useMarkdownRehypePlugins();

  return (
    <StreamdownTextPrimitive
      className="chat-markdown"
      controls={assistantControls}
      lineNumbers={false}
      plugins={plugins}
      rehypePlugins={rehypePlugins}
      shikiTheme={["github-light", "github-dark"]}
      translations={translations}
    />
  );
}

export function MarkdownArtifact({ children }: { children: string }) {
  const translations = useMarkdownTranslations();
  const rehypePlugins = useMarkdownRehypePlugins();

  return (
    <Streamdown
      className="chat-markdown artifact-markdown"
      controls={controls}
      lineNumbers={false}
      mode="static"
      plugins={plugins}
      rehypePlugins={rehypePlugins}
      shikiTheme={["github-light", "github-dark"]}
      translations={translations}
    >
      {children}
    </Streamdown>
  );
}

function useMarkdownTranslations(): Partial<StreamdownTranslations> {
  const { t } = useTranslation();
  return {
    close: t("close"),
    copied: t("copied"),
    copyCode: t("copyCodeBlock"),
    copyTable: t("copyTable"),
    copyTableAsCsv: t("copyTableAsCsv"),
    copyTableAsMarkdown: t("copyTableAsMarkdown"),
    copyTableAsTsv: t("copyTableAsTsv"),
    exitFullscreen: t("exitFullscreen"),
    viewFullscreen: t("viewFullscreen")
  };
}
