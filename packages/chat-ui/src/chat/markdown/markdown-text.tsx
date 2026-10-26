import {
  StreamdownTextPrimitive,
  type ControlsConfig as AssistantControlsConfig
} from "@assistant-ui/react-streamdown";
import { mermaid } from "@streamdown/mermaid";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  Streamdown,
  type Components as StreamdownComponents,
  type ControlsConfig,
  type StreamdownTranslations
} from "streamdown";
import { CODE_THEMES, codeHighlighter } from "../../shared/code-highlight";
import { useTranslation } from "../../shared/i18n";
import {
  markdownRehypePlugins,
  type MarkdownLinkPolicy,
  type MarkdownPageLinks
} from "./markdown-security";
import { MarkdownTable } from "./markdown-table";
import { PAGE_LINK_TAG, PageLink, pageLinkPath, usePageLinks } from "./page-link";

const plugins = { code: codeHighlighter, mermaid };
// A table draws its own frame and copy menu; a link to a page of the app opens it in place.
// Streamdown's components are typed by HTML's tags; the page link is an element of its own.
const components = { table: MarkdownTable, [PAGE_LINK_TAG]: PageLink } as StreamdownComponents;
const controls: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
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
  const { t } = useTranslation();
  const imageWithDescription = t("markdownImageNotLoaded", { description: "{description}" });
  const image = t("markdownImageNotLoadedNoDescription");
  // Links open pages in place only where something opens them: in a conversation.
  const inPlace = usePageLinks() !== undefined;
  return useMemo(
    () =>
      markdownRehypePlugins(
        policy ?? { allowedLinkHosts: [], ownOrigins: pageOrigin() },
        { imageWithDescription, image },
        inPlace ? pageLinksOfPage() : undefined
      ),
    [policy, imageWithDescription, image, inPlace]
  );
}

/** Links to the pages of this app, on the origin the page itself is served from. */
function pageLinksOfPage(): MarkdownPageLinks | undefined {
  if (typeof window === "undefined") return undefined;
  const origin = window.location.origin;
  return { tag: PAGE_LINK_TAG, pathOf: (href) => pageLinkPath(href, origin) };
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
      components={components}
      controls={assistantControls}
      lineNumbers={false}
      plugins={plugins}
      rehypePlugins={rehypePlugins}
      shikiTheme={CODE_THEMES}
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
      components={components}
      controls={controls}
      lineNumbers={false}
      mode="static"
      plugins={plugins}
      rehypePlugins={rehypePlugins}
      shikiTheme={CODE_THEMES}
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
