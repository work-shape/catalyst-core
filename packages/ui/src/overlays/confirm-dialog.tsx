import type { ReactNode } from "react";
import { Button } from "../actions/button";
import { useUiLabels } from "../ui-root";
import { Dialog } from "./dialog";

/** `danger` is for an action that removes or revokes something. */
export type ConfirmDialogTone = "danger" | "primary";

export interface ConfirmDialogProps {
  open: boolean;
  /** The question, naming the object: "Delete Support assistant?". */
  title: ReactNode;
  /** What the action does and whether it can be undone. */
  children: ReactNode;
  /** The action in one or two words. It is the confirm button's text. */
  confirmLabel: ReactNode;
  tone?: ConfirmDialogTone;
  /** The action is running: the confirm button shows a spinner and both buttons are held. */
  loading?: boolean;
  onConfirm(): void;
  /** Called by Cancel, Escape, the close button and a click beside the dialog. */
  onClose(): void;
}

/** The one question before an action that is hard to take back, with one confirm button. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = "danger",
  loading = false,
  onConfirm,
  onClose
}: ConfirmDialogProps) {
  const labels = useUiLabels("ConfirmDialog");
  return (
    <Dialog
      open={open}
      size="sm"
      title={title}
      footer={
        <>
          <Button type="button" variant="outline" disabled={loading} onClick={onClose}>
            {labels.cancel}
          </Button>
          <Button type="button" variant={tone} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
      onClose={onClose}
    >
      <div className="text-body text-muted-foreground">{children}</div>
    </Dialog>
  );
}
