import { Download } from "lucide-react";
import { useState } from "react";
import type {
  ApiClient,
  ConversationResourceListItem
} from "@vivd-catalyst/api-client";
import { useTranslation } from "./i18n";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

export function ResourceDownloadButton({
  client,
  conversationId,
  labelled = false,
  resource
}: {
  client: ApiClient;
  conversationId: string;
  labelled?: boolean;
  resource: Extract<
    ConversationResourceListItem,
    { resourceType: "source_file" | "generated_file" }
  >;
}) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);
  const filename = resource.download.filename;

  async function download() {
    setDownloading(true);
    try {
      const blob =
        resource.download.kind === "artifact"
          ? await client.conversationArtifactContent(
              conversationId,
              resource.download.artifactId
            )
          : await client.conversationFileContent(
              conversationId,
              resource.download.fileId,
              true
            );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Button
      type="button"
      variant={labelled ? "outline" : "ghost"}
      size={labelled ? "sm" : "icon"}
      className={labelled ? "h-8 text-xs" : "size-7 shrink-0 opacity-70 group-hover:opacity-100"}
      title={t("downloadArtifact", { filename })}
      aria-label={t("downloadArtifact", { filename })}
      disabled={downloading}
      onClick={(event) => {
        event.stopPropagation();
        void download();
      }}
    >
      {downloading ? <Spinner size="sm" /> : <Download size={14} aria-hidden="true" />}
      {labelled ? <span>{t("downloadArtifactButton")}</span> : null}
    </Button>
  );
}
