import {
  StreamdownTextPrimitive,
  type ControlsConfig as AssistantControlsConfig
} from "@assistant-ui/react-streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown, type ControlsConfig, type StreamdownTranslations } from "streamdown";
import { useTranslation } from "./i18n";

const plugins = { code, mermaid };
const controls: ControlsConfig = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: true },
  mermaid: { copy: true, download: false, fullscreen: true, panZoom: true }
};
// The assistant-ui wrapper still exposes Streamdown's older, narrower control type,
// while passing this object through to the current Streamdown runtime unchanged.
const assistantControls = controls as AssistantControlsConfig;
const security = {
  allowedLinkPrefixes: ["*"],
  allowedImagePrefixes: [],
  allowedProtocols: ["http", "https", "mailto"],
  allowDataImages: false
};

export function MarkdownText() {
  const translations = useMarkdownTranslations();

  return (
    <StreamdownTextPrimitive
      className="chat-markdown"
      controls={assistantControls}
      lineNumbers={false}
      plugins={plugins}
      security={security}
      shikiTheme={["github-light", "github-dark"]}
      translations={translations}
    />
  );
}

export function MarkdownArtifact({ children }: { children: string }) {
  const translations = useMarkdownTranslations();

  return (
    <Streamdown
      className="chat-markdown artifact-markdown"
      controls={controls}
      lineNumbers={false}
      mode="static"
      plugins={plugins}
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
