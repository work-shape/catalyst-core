import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { Paperclip } from "lucide-react";
import { useMemo, useState } from "react";
import { AttachmentPreview, isImageAttachment } from "./attachment-preview";
import { useTranslation } from "./i18n";
import { cn } from "./ui/cn";

/** Short stacks stay inline; longer ones use a card and collapse when they exceed its capacity. */
const INLINE_LIMIT = 4;
const COLLAPSED_LIMIT = 6;

export interface AttachmentGroupPlan {
  layout: "inline" | "card";
  visible: number;
  hidden: number;
}

export function planAttachmentGroup(count: number, expanded: boolean): AttachmentGroupPlan {
  if (count <= INLINE_LIMIT) {
    return { layout: "inline", visible: count, hidden: 0 };
  }
  const visible = expanded ? count : Math.min(count, COLLAPSED_LIMIT);
  return { layout: "card", visible, hidden: count - visible };
}

export function partitionAttachments(
  attachments: readonly { type?: string; contentType?: string; name?: string }[] | undefined
): { images: number[]; files: number[] } {
  const images: number[] = [];
  const files: number[] = [];
  attachments?.forEach((attachment, index) => {
    (isImageAttachment(attachment) ? images : files).push(index);
  });
  return { images, files };
}

const AttachmentChip = () => <AttachmentPreview removable={false} />;
const AttachmentRow = () => <AttachmentPreview removable={false} variant="row" />;

/** Renders a sent message's attachments: images as thumbnails, files as chips or a grouped card. */
export function MessageAttachments() {
  const { t } = useTranslation();
  const attachments = useAuiState((state) =>
    state.message.role === "user" ? state.message.attachments : undefined
  );
  const [expanded, setExpanded] = useState(false);
  const { images, files } = useMemo(() => partitionAttachments(attachments), [attachments]);
  const plan = planAttachmentGroup(files.length, expanded);

  if (images.length === 0 && files.length === 0) {
    return null;
  }

  return (
    <>
      {images.map((index) => (
        <MessagePrimitive.AttachmentByIndex
          key={index}
          index={index}
          components={{ Attachment: AttachmentChip }}
        />
      ))}
      {plan.layout === "inline" ? (
        files.length > 0 ? (
          <div className="flex max-w-[min(42rem,88%)] flex-wrap justify-end gap-1.5">
            {files.map((index) => (
              <MessagePrimitive.AttachmentByIndex
                key={index}
                index={index}
                components={{ Attachment: AttachmentChip }}
              />
            ))}
          </div>
        ) : null
      ) : (
        <div className="w-[min(32rem,88%)] overflow-hidden rounded-xl border bg-card shadow-xs">
          <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
            <Paperclip size={14} className="text-muted-foreground" aria-hidden="true" />
            <span>{t("attachmentsCount", { count: files.length })}</span>
          </div>
          <div className="grid grid-cols-1 gap-x-1 p-1 sm:grid-cols-2">
            {files.slice(0, plan.visible).map((index) => (
              <MessagePrimitive.AttachmentByIndex
                key={index}
                index={index}
                components={{ Attachment: AttachmentRow }}
              />
            ))}
          </div>
          {files.length > COLLAPSED_LIMIT ? (
            <button
              type="button"
              className={cn(
                "flex w-full cursor-pointer px-3 pb-2.5 pt-1 text-left text-xs font-medium text-primary",
                "hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              )}
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded
                ? t("attachmentsShowLess")
                : t("attachmentsShowMore", { count: plan.hidden })}
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}
