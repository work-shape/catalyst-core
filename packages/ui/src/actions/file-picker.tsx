import { useEffect, useRef, type ReactNode } from "react";

export interface FilePickerProps {
  /** Takes the chosen files. It is not called when the person closes the dialog without one. */
  onFiles(files: File[]): void;
  /** Lets the person choose more than one file at once. */
  multiple?: boolean;
  /** The file types the dialog offers, in the form of the input's `accept` attribute. */
  accept?: string;
  /**
   * The dialog chooses a folder instead of files: `onFiles` takes every file below it, each
   * with its path from the folder on in `webkitRelativePath`.
   */
  directory?: boolean;
  /**
   * Renders the trigger with `choose`, which opens the system file dialog. The trigger is a
   * labelled library control: a `Button`, an `IconButton` or a `DropdownMenuItem`.
   */
  children(choose: () => void): ReactNode;
}

/**
 * Opens the system file dialog from a labelled, keyboard-operable control. The picker owns the
 * hidden native input: no reader or Tab stop reaches it, and the trigger is the one way in.
 * For a trigger inside a menu, render the picker around the whole menu, because the menu's
 * content leaves the page when it closes and the input has to stay to receive the files.
 */
export function FilePicker({
  onFiles,
  multiple = false,
  accept,
  directory = false,
  children
}: FilePickerProps) {
  const input = useRef<HTMLInputElement>(null);
  // The attribute has no name in React's types: it is set on the element.
  useEffect(() => {
    if (input.current) input.current.webkitdirectory = directory;
  }, [directory]);
  return (
    <>
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        multiple={multiple}
        accept={accept}
        data-file-picker=""
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          // Emptied, so that choosing the same file again is a change too.
          event.currentTarget.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      {children(() => input.current?.click())}
    </>
  );
}
