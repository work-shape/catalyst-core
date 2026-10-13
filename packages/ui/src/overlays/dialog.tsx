import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
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

interface ModalSurfaceProps {
  open: boolean;
  /** The id of the element that names the dialog. */
  labelledBy?: string;
  /** The dialog's name where no element on it shows one. */
  label?: string;
  describedBy?: string;
  /** What takes the focus on opening, where the first element that can is not the right one. */
  initialFocus?: RefObject<HTMLElement | null>;
  onClose(): void;
  children: ReactNode;
  className?: string;
}

/** The open modal surfaces in the order they opened. Escape closes the last one. */
const openSurfaces: HTMLDialogElement[] = [];

/**
 * Whether an overlay stands on the page outside the dialog. Nothing outside a modal dialog can
 * be used, so such an overlay is one that is closing: the menu the dialog was opened from, or
 * the tooltip of its button.
 */
function hasOverlayOutside(dialog: HTMLDialogElement): boolean {
  return [...document.querySelectorAll("[data-catalyst-overlays]")].some(
    (container) => !dialog.contains(container) && container.childElementCount > 0
  );
}

/** An overlay that is open inside the dialog: Escape closes it before the dialog. */
const OPEN_OVERLAY_INSIDE = '[data-catalyst-overlays] [data-state]:not([data-state="closed"])';

/**
 * The modal layer `Dialog` and `CommandPalette` stand on: the browser's own `dialog` element,
 * opened as a modal. It holds the focus, closes on Escape and on a press on the backdrop, and
 * returns the focus to what opened it. Overlays opened inside it render into it, so they sit in
 * the top layer above it.
 */
export function ModalSurface({
  open,
  labelledBy,
  label,
  describedBy,
  initialFocus,
  onClose,
  children,
  className
}: ModalSurfaceProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerStartedOnBackdropRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
      initialFocus?.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [initialFocus, open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) {
      return;
    }
    openSurfaces.push(dialog);
    return () => {
      openSurfaces.splice(openSurfaces.lastIndexOf(dialog), 1);
    };
  }, [open]);

  // A menu or tooltip that is closing behind the dialog still listens for Escape and takes the
  // key, so the browser never closes the dialog: a press right after opening did nothing. While
  // such an overlay is there, the dialog closes on the key by itself.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || openSurfaces.at(-1) !== dialog) {
        return;
      }
      if (!dialog.querySelector(OPEN_OVERLAY_INSIDE) && hasOverlayOutside(dialog)) {
        onClose();
      }
    };
    // On the window, before the listeners of the overlays on the document.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [onClose, open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={labelledBy}
      aria-label={label}
      aria-describedby={describedBy}
      className={cn(
        "m-auto max-h-[calc(100dvh-2rem)] overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground shadow-modal backdrop:bg-scrim",
        className
      )}
      onClose={(event) => {
        // React hands on the closing of a dialog opened inside this one. Only its own counts.
        // The event of a close arrives late: where the dialog was opened again meanwhile, it
        // is the earlier close that speaks, and the dialog stays open.
        if (event.target === event.currentTarget && !event.currentTarget.open) {
          onClose();
        }
      }}
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
            {children}
            {overlayContainer}
          </>
        )}
      </OverlayScope>
    </dialog>
  );
}

/** The width of a dialog of a size, never wider than the window less its margin. */
export function dialogWidthClassName(size: DialogSize): string {
  return dialogWidths[size];
}

/**
 * A modal dialog. The header and the footer stay in place while the body scrolls.
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
  const titleId = useId();
  const descriptionId = useId();

  return (
    <ModalSurface
      open={open}
      labelledBy={titleId}
      describedBy={description === undefined ? undefined : descriptionId}
      className={cn(dialogWidths[size], className)}
      onClose={onClose}
    >
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
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer === undefined ? null : (
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </ModalSurface>
  );
}
