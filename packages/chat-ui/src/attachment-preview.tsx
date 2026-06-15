import { AttachmentPrimitive } from "@assistant-ui/react";
import { FileText, X } from "lucide-react";
import { cn } from "./ui/cn";

export function AttachmentPreview({ removable }: { removable: boolean }) {
  return (
    <AttachmentPrimitive.Root className="group/attachment relative max-w-72">
      <div className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted/45 px-2 py-1 text-xs text-muted-foreground">
        <FileText size={13} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate">
          <AttachmentPrimitive.Name />
        </span>
      </div>
      {removable ? (
        <AttachmentPrimitive.Remove
          className={cn(
            "absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-xs transition-opacity",
            "group-hover/attachment:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          )}
          aria-label="Remove attachment"
          title="Remove attachment"
        >
          <X size={12} aria-hidden="true" />
        </AttachmentPrimitive.Remove>
      ) : null}
    </AttachmentPrimitive.Root>
  );
}
