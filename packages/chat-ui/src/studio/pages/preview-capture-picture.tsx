import {
  PREVIEW_CAPTURE_REFUSALS,
  PREVIEW_CAPTURE_TOOL_NAME,
  type PreviewCaptureRefusal
} from "@work-shape/catalyst-core";
import { Button } from "@work-shape/catalyst-ui";
import { useAttachmentContentContext } from "../../chat/files/attachment-content";
import { useConversationFileBlob } from "../../chat/files/conversation-file-content";
import {
  conversationFileFromArtifact,
  createConversationFilePanelEntry
} from "../../chat/files/conversation-file-presentation";
import { useImageFailed } from "../../chat/files/image-failure";
import {
  readToolArtifactRefs,
  type ToolArtifactDownloadRef
} from "../../chat/tools/tool-artifacts";
import { useToolDisplayPanel } from "../../chat/tools/tool-display-panel";
import { useTranslation, type TranslationKey } from "../../shared/i18n";

// The picture a run took of the preview (PREVIEW-SEE-1), as the person sees it in the run's
// work (PREVIEW-SEE-2): a small picture on the row of the call that opens in the file viewer
// beside the chat, or the sentence of why none was taken. The picture is no deliverable: it
// gets no card of its own and never opens by itself.

/** What a call of `preview.capture` came to, as the row shows it. */
type PreviewCaptureOutcome =
  | { kind: "captured"; artifact: ToolArtifactDownloadRef }
  | { kind: "refused"; code: PreviewCaptureRefusal };

const REFUSAL_SENTENCES: Record<PreviewCaptureRefusal, TranslationKey> = {
  capture_limit: "pages.captureRefusedLimit",
  capture_unavailable: "pages.captureRefusedUnavailable",
  preview_not_viewed: "pages.captureRefusedNotViewed",
  preview_personal_data: "pages.captureRefusedPersonalData"
};

/**
 * The outcome of a finished call of `preview.capture`, or nothing for any other call, a call
 * still running and an answer of another shape: such a row stays an ordinary call.
 */
export function readPreviewCapture(call: {
  toolName: string;
  result: unknown;
  isError?: boolean | undefined;
}): PreviewCaptureOutcome | undefined {
  if (call.toolName !== PREVIEW_CAPTURE_TOOL_NAME || call.isError) return undefined;
  const output = isRecord(call.result) ? call.result.output : undefined;
  if (!isRecord(output)) return undefined;
  if (output.captured === false) {
    const code = PREVIEW_CAPTURE_REFUSALS.find((known) => known === output.code);
    return code ? { kind: "refused", code } : undefined;
  }
  if (output.captured !== true) return undefined;
  // The one picture the call answers with, and only as an image.
  const artifact = readToolArtifactRefs(call.result).find(
    (candidate) => candidate.mimeType === "image/webp"
  );
  return artifact ? { kind: "captured", artifact } : undefined;
}

/** Under the row of the call: the small picture, or why there is none. */
export function PreviewCaptureOutcomeView({ outcome }: { outcome: PreviewCaptureOutcome }) {
  const { t } = useTranslation();
  const content = useAttachmentContentContext();
  if (outcome.kind === "refused") {
    return (
      <p className="text-body text-muted-foreground" data-testid="preview-capture-refused">
        {t(REFUSAL_SENTENCES[outcome.code])}
      </p>
    );
  }
  const conversationId = content?.selectedConversationId;
  if (!content || !conversationId) return <PictureGone />;
  // Keyed by both, so a picture of one conversation never stands under another, not even for
  // the render before its effect runs.
  return (
    <PreviewCapturePicture
      key={`${conversationId}:${outcome.artifact.artifactId}`}
      artifact={outcome.artifact}
      client={content.client}
      conversationId={conversationId}
    />
  );
}

function PreviewCapturePicture({
  artifact,
  client,
  conversationId
}: {
  artifact: ToolArtifactDownloadRef;
  client: NonNullable<ReturnType<typeof useAttachmentContentContext>>["client"];
  conversationId: string;
}) {
  const { t } = useTranslation();
  const panel = useToolDisplayPanel();
  // Read through the conversation's artifact content, which checks the reader's access each
  // time; the address is revoked when the row leaves or shows another picture.
  const picture = useConversationFileBlob({
    client,
    conversationId,
    content: { kind: "artifact", artifactId: artifact.artifactId },
    viewer: "image"
  });
  const url = picture.status === "ready" ? picture.url : undefined;
  const image = useImageFailed(url);
  if (picture.status === "failed" || image.failed) return <PictureGone />;
  const title = t("pages.captureTitle");
  const open = () =>
    panel.show(
      createConversationFilePanelEntry({
        client,
        conversationId,
        file: { ...conversationFileFromArtifact(artifact), title, downloadLabel: title }
      })
    );
  return (
    // The library's button, drawn as the picture's frame: a rectangle the picture fills.
    <Button
      variant="outline"
      onClick={open}
      disabled={!url}
      aria-label={t("pages.captureOpen")}
      title={t("pages.captureOpen")}
      className="block h-24 w-40 overflow-hidden rounded-md bg-muted p-0"
      data-testid="preview-capture-thumbnail"
    >
      {url ? (
        <img
          src={url}
          alt={title}
          className="h-full w-full object-cover object-top"
          onError={image.onError}
        />
      ) : null}
    </Button>
  );
}

function PictureGone() {
  const { t } = useTranslation();
  return (
    <p className="text-body text-muted-foreground" data-testid="preview-capture-gone">
      {t("pages.captureGone")}
    </p>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
