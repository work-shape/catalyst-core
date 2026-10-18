import { FileText, RotateCcw, Upload } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Badge, Button, FilePicker, List, ListRow, Spinner } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import type { KnowledgeBaseSource } from "./knowledge-base-source";
import { KNOWLEDGE_ADD_LIMITS } from "./knowledge-base-model";
import {
  KNOWLEDGE_UPLOAD_REFUSALS,
  nextUpload,
  queueUploads,
  retryUpload,
  settleUpload,
  uploadableFile,
  uploadAccept,
  uploadFormatList,
  type UploadItem
} from "./knowledge-upload-model";
import { formatFileBytes } from "./skill-form-model";

const STATE_VIEWS: Record<
  UploadItem["state"],
  { tone: "neutral" | "info" | "success" | "danger"; label: TranslationKey }
> = {
  waiting: { tone: "neutral", label: "knowledge.uploadWaiting" },
  uploading: { tone: "info", label: "knowledge.uploadUploading" },
  added: { tone: "success", label: "knowledge.uploadAdded" },
  failed: { tone: "danger", label: "knowledge.uploadFailed" }
};

const newUploadId = () => globalThis.crypto.randomUUID();

/**
 * Uploads files from the reader's device into the Knowledge Base, one call per file and one at
 * a time. Each row says how its file went. A failed one can be sent again; the ones added stay
 * added and are never sent again. `onAdded` is told each file the Knowledge Base took.
 */
export function KnowledgeUploadSection({
  source,
  knowledgeBase,
  formats,
  onAdded
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  /** The formats the instance reads. */
  formats: readonly string[];
  onAdded(): void;
}) {
  const { locale, t } = useTranslation();
  const [queue, setQueue] = useState<UploadItem[]>([]);
  // The queue as the running loop reads it between awaits, beside the state that renders it.
  const current = useRef<UploadItem[]>([]);
  const running = useRef(false);
  const titleId = useId();
  const size = formatFileBytes(KNOWLEDGE_ADD_LIMITS.bytes, locale);
  const formatList = uploadFormatList(formats, locale);
  const update = (change: (queue: readonly UploadItem[]) => UploadItem[]) => {
    current.current = change(current.current);
    setQueue(current.current);
  };
  // Sends the waiting files one after another until none waits. Only one loop runs at a time;
  // files chosen meanwhile wait in the queue and the running loop takes them too.
  const pump = async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (let item = nextUpload(current.current); item; item = nextUpload(current.current)) {
        const { id, key, file } = item;
        update((queue) => settleUpload(queue, id, { state: "uploading" }));
        const answer = await source.uploadFile(knowledgeBase, file, key);
        if (answer.ok) {
          update((queue) => settleUpload(queue, id, { state: "added" }));
          onAdded();
          continue;
        }
        const known =
          answer.reason === undefined ? undefined : KNOWLEDGE_UPLOAD_REFUSALS[answer.reason];
        const failure: UploadItem["failure"] = answer.refused
          ? { key: "knowledge.addRefused" }
          : known
            ? { key: known }
            : answer.message
              ? { message: answer.message }
              : { key: "knowledge.uploadFailedGeneric" };
        update((queue) =>
          settleUpload(queue, id, {
            state: "failed",
            failure,
            ...(answer.unanswered ? { unanswered: true as const } : {})
          })
        );
      }
    } finally {
      running.current = false;
    }
  };

  return (
    <div role="group" className="grid gap-2" aria-labelledby={titleId} data-knowledge-upload="">
      <span id={titleId} className="text-label">
        {t("knowledge.uploadTitle")}
      </span>
      <p className="text-caption text-muted-foreground">
        {t("knowledge.uploadHint", { formats: formatList, size })}
      </p>
      <div>
        <FilePicker
          multiple
          accept={uploadAccept(formats)}
          onFiles={(files) => {
            update((queue) => queueUploads(queue, files, formats, newUploadId));
            pump().catch(() => undefined);
          }}
        >
          {(choose) => (
            <Button variant="outline" size="sm" onClick={choose} data-knowledge-upload-choose="">
              <Upload aria-hidden="true" />
              {t("knowledge.uploadChoose")}
            </Button>
          )}
        </FilePicker>
      </div>
      {queue.length === 0 ? null : (
        <List aria-label={t("knowledge.uploadList")}>
          {queue.map((item) => {
            const view = STATE_VIEWS[item.state];
            const retryable =
              item.state === "failed" && uploadableFile(item.file, formats).uploadable;
            return (
              <ListRow
                key={item.id}
                size="compact"
                data-knowledge-upload-file={item.name}
                data-knowledge-upload-state={item.state}
                leading={<FileText aria-hidden="true" />}
                title={item.name}
                description={
                  item.failure === undefined
                    ? formatFileBytes(item.file.size, locale)
                    : "key" in item.failure
                      ? t(item.failure.key, { size, formats: formatList })
                      : item.failure.message
                }
                descriptionWraps="always"
                chips={
                  <Badge
                    tone={view.tone}
                    dot={item.state !== "uploading"}
                    leading={item.state === "uploading" ? <Spinner size="sm" /> : undefined}
                  >
                    {t(view.label)}
                  </Badge>
                }
                actionsVisible
                actions={
                  retryable ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t("knowledge.uploadRetryLabel", { name: item.name })}
                      onClick={() => {
                        update((queue) => retryUpload(queue, item.id, formats, newUploadId));
                        pump().catch(() => undefined);
                      }}
                      data-knowledge-upload-retry={item.name}
                    >
                      <RotateCcw aria-hidden="true" />
                      {t("knowledge.retry")}
                    </Button>
                  ) : undefined
                }
              />
            );
          })}
        </List>
      )}
    </div>
  );
}
