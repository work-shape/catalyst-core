import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "../actions/icon-button";
import { useUiLabels } from "../ui-root";

/** How long the copy button says that it copied. */
const COPIED_MS = 2000;

/**
 * Puts a text on the clipboard and says for a moment that it did. Not exported by the
 * package: the components that offer a copy draw it.
 */
export function CopyButton({
  value,
  component,
  className
}: {
  value: string;
  /** The component that draws the button, named when the UiRoot is missing. */
  component: string;
  className?: string;
}) {
  const labels = useUiLabels(component);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timeout = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timeout);
  }, [copied]);

  return (
    <IconButton
      size="sm"
      className={className}
      label={copied ? labels.copied : labels.copy}
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false)
        );
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </IconButton>
  );
}
