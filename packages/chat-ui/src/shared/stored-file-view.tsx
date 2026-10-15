import { useState, type ReactNode } from "react";
import { CodeFile } from "@work-shape/catalyst-ui";
import { codeColouring, useCodeTokens } from "./code-highlight";
import { useTranslation } from "./i18n";

const WRAP_STORAGE_KEY = "vivd-catalyst:code-wrap";

/** Whether the reader last chose to break long lines, in this browser. Code starts unbroken. */
function readStoredWrap(): boolean {
  try {
    return window.localStorage.getItem(WRAP_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function storeWrap(wrap: boolean): void {
  try {
    window.localStorage.setItem(WRAP_STORAGE_KEY, wrap ? "on" : "off");
  } catch {
    // A browser that refuses storage opens the next file unbroken.
  }
}

/**
 * One stored text file, read-only and as it is stored: nothing reformats it. It is coloured
 * by the language its name ends on, once the grammar has loaded, and a file too large to
 * colour says so. The choice to break long lines is kept for the browser.
 */
export function StoredFileView({
  path,
  text,
  leading,
  className
}: {
  path: string;
  text: string;
  /** Stands before the path, such as the way back to a list of files. */
  leading?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const [wrap, setWrap] = useState(readStoredWrap);
  const colouring = codeColouring(path, text);
  const tokens = useCodeTokens(text, colouring);
  return (
    <CodeFile
      className={className}
      name={path}
      code={text}
      tokens={tokens}
      wrap={wrap}
      onWrapChange={(next) => {
        setWrap(next);
        storeWrap(next);
      }}
      leading={leading}
      note={colouring.kind === "too-large" ? t("pages.fileTooLargeToColour") : undefined}
    />
  );
}
