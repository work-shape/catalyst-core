import { Upload } from "lucide-react";
import { useState, type DragEvent } from "react";

export interface ChatFileDropzoneInput {
  onFilesSelected(files: File[]): void;
}

export interface ChatFileDropzoneController {
  draggingFiles: boolean;
  onChatDragEnter(event: DragEvent<HTMLElement>): void;
  onChatDragOver(event: DragEvent<HTMLElement>): void;
  onChatDragLeave(event: DragEvent<HTMLElement>): void;
  onChatDrop(event: DragEvent<HTMLElement>): void;
}

export function useChatFileDropzone(input: ChatFileDropzoneInput): ChatFileDropzoneController {
  const [draggingFiles, setDraggingFiles] = useState(false);

  function onChatDragEnter(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    setDraggingFiles(true);
  }

  function onChatDragOver(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDraggingFiles(true);
  }

  function onChatDragLeave(event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setDraggingFiles(false);
  }

  function onChatDrop(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    setDraggingFiles(false);
    input.onFilesSelected([...event.dataTransfer.files]);
  }

  return {
    draggingFiles,
    onChatDragEnter,
    onChatDragOver,
    onChatDragLeave,
    onChatDrop
  };
}

export function ChatDropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-40 p-3">
      <div className="grid h-full w-full place-items-center rounded-xl border-2 border-dashed border-primary/70 bg-primary/5">
        <div className="inline-flex items-center gap-3 rounded-full border border-primary/30 bg-card px-5 py-2.5 text-card-foreground shadow-lg">
          <Upload size={18} className="text-primary" aria-hidden="true" />
          <div className="grid gap-0.5 text-left">
            <strong className="text-sm font-semibold leading-none">Drop files to attach</strong>
            <span className="text-xs text-muted-foreground">PDF, DOCX, TXT, Markdown, and images</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function hasDraggedFiles(event: DragEvent<HTMLElement>): boolean {
  return [...event.dataTransfer.types].includes("Files");
}
