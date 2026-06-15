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
    <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center bg-background/80 p-6 backdrop-blur-sm">
      <div className="grid max-w-sm gap-1 rounded-lg border bg-card px-5 py-4 text-center text-card-foreground shadow-lg">
        <strong className="text-sm font-semibold">Drop files to attach</strong>
        <span className="text-xs text-muted-foreground">PDF, DOCX, TXT, and Markdown</span>
      </div>
    </div>
  );
}

function hasDraggedFiles(event: DragEvent<HTMLElement>): boolean {
  return [...event.dataTransfer.types].includes("Files");
}
