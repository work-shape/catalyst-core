import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./button";
import { cn } from "./cn";

export function Dialog({
  open,
  title,
  onClose,
  children,
  className
}: {
  open: boolean;
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerStartedOnBackdropRef = useRef(false);
  const titleId = useId();

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
      className={cn(
        "m-auto w-[min(36rem,calc(100vw-2rem))] rounded-lg border bg-card p-0 text-card-foreground shadow-lg backdrop:bg-black/45",
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
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
        <h2 id={titleId} className="text-sm font-semibold">{title}</h2>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={15} aria-hidden="true" />
        </Button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}
