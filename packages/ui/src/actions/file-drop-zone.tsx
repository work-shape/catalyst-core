import { useState, type DragEvent, type ReactNode } from "react";
import { cn } from "../cn";

export interface FileDropZoneProps {
  /**
   * Takes what was dropped. The drag's data is handed whole and read at once, so that a caller
   * can read a dropped folder through its items as well as the files.
   */
  onDrop(data: DataTransfer): void;
  /** The zone takes nothing while it is disabled, such as while a drop is read. */
  disabled?: boolean;
  /**
   * What the zone says it takes, and the controls that open the file dialog: a drop is the
   * pointer's way in, and the controls are the keyboard's.
   */
  children: ReactNode;
  className?: string;
}

function holdsFiles(event: DragEvent<HTMLElement>): boolean {
  return [...event.dataTransfer.types].includes("Files");
}

/**
 * An area that files or a folder are dropped on, marked while they are dragged over it. It
 * holds a `FilePicker` trigger for whoever does not drag.
 */
export function FileDropZone({ onDrop, disabled = false, children, className }: FileDropZoneProps) {
  const [over, setOver] = useState(false);
  const takes = (event: DragEvent<HTMLElement>) => !disabled && holdsFiles(event);
  return (
    <div
      data-slot="file-drop-zone"
      data-dragging={over ? "" : undefined}
      className={cn(
        "grid justify-items-center gap-3 rounded-lg border border-dashed border-input-strong px-4 py-6 text-center text-body text-muted-foreground transition-colors",
        over && "border-primary bg-primary/5",
        className
      )}
      onDragEnter={(event) => {
        if (!takes(event)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragOver={(event) => {
        if (!takes(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(event) => {
        const to = event.relatedTarget;
        if (to instanceof Node && event.currentTarget.contains(to)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        if (!takes(event)) return;
        event.preventDefault();
        setOver(false);
        onDrop(event.dataTransfer);
      }}
    >
      {children}
    </div>
  );
}
