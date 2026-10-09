import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { OverlayScope, useUiLabels } from "../ui-root";

export type DialogSize = "sm" | "md" | "lg";

const dialogWidths: Record<DialogSize, string> = {
  sm: "w-[min(28rem,calc(100vw-2rem))]",
  md: "w-[min(36rem,calc(100vw-2rem))]",
  lg: "w-[min(44rem,calc(100vw-2rem))]"
};

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  /** One or two sentences under the title that say what the dialog is for. */
  description?: ReactNode;
  /** The actions, pinned under the scrolling body. */
  footer?: ReactNode;
  size?: DialogSize;
  onClose(): void;
  children: ReactNode;
  className?: string;
}

/**
 * A modal dialog on the browser's own `dialog` element. The header and the footer stay in
 * place while the body scrolls. Overlays opened inside it render into the dialog, so they sit
 * in the top layer above it.
 */
export function Dialog({
  open,
  title,
  description,
  footer,
  size = "md",
  onClose,
  children,
  className
}: DialogProps) {
  const labels = useUiLabels("Dialog");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerStartedOnBackdropRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      className={cn(
        "m-auto max-h-[calc(100dvh-2rem)] overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground shadow-modal backdrop:bg-scrim",
        dialogWidths[size],
        className
      )}
      onClose={onClose}
      onPointerDown={(event) => {
        pointerStartedOnBackdropRef.current = event.target === dialogRef.current;
      }}
      onClick={(event) => {
        if (pointerStartedOnBackdropRef.current && event.target === dialogRef.current) {
          onClose();
        }
        pointerStartedOnBackdropRef.current = false;
      }}
    >
      <OverlayScope>
        {(overlayContainer) => (
          <>
            <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
              <div className="flex shrink-0 items-start justify-between gap-3 border-b px-5 py-3">
                <div className="grid min-w-0 gap-1 py-1">
                  <h2 id={titleId} className="text-heading">
                    {title}
                  </h2>
                  {description === undefined ? null : (
                    <p id={descriptionId} className="text-body text-muted-foreground">
                      {description}
                    </p>
                  )}
                </div>
                {/* A plain button: the dialog focuses it on opening, and a tooltip would open with it. */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  aria-label={labels.close}
                  onClick={onClose}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-5 [scrollbar-width:thin]">
                {children}
              </div>
              {footer === undefined ? null : (
                <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t px-5 py-3">
                  {footer}
                </div>
              )}
            </div>
            {overlayContainer}
          </>
        )}
      </OverlayScope>
    </dialog>
  );
}
