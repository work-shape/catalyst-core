import { Check, Copy } from "lucide-react";
import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { Button } from "../actions/button";
import { IconButton } from "../actions/icon-button";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

/** `inline` puts the label beside the value; `stacked` puts it above. */
export type KeyValueLayout = "inline" | "stacked";

export interface KeyValueListProps extends HTMLAttributes<HTMLDListElement> {
  layout?: KeyValueLayout;
}

/** The list a set of `KeyValue` rows sits in. */
export function KeyValueList({ className, layout = "inline", ...props }: KeyValueListProps) {
  return (
    <dl
      data-layout={layout}
      className={cn("group/key-value grid min-w-0 gap-2", className)}
      {...props}
    />
  );
}

export interface KeyValueProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  /** Adds a copy button that puts this text on the clipboard. */
  copyValue?: string;
  /** Shows a long value on three lines with a control that unfolds it. */
  foldable?: boolean;
}

/** How long the copy button says that it copied. */
const COPIED_MS = 2000;

/** One labelled value, inside a `KeyValueList`. The value is the children. */
export function KeyValue({
  className,
  label,
  copyValue,
  foldable = false,
  children,
  ...props
}: KeyValueProps) {
  const valueId = useId();
  const fold = useFold(foldable);
  return (
    <div
      className={cn(
        "grid min-w-0 gap-x-3 gap-y-0.5 group-data-[layout=inline]/key-value:grid-cols-[7rem_minmax(0,1fr)] group-data-[layout=inline]/key-value:items-baseline",
        className
      )}
      {...props}
    >
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="grid min-w-0 justify-items-start gap-1 text-body">
        <div className="flex w-full min-w-0 items-start gap-1">
          <div
            ref={fold.ref}
            id={valueId}
            className={cn("min-w-0 flex-1 break-words", fold.folded && "line-clamp-3")}
          >
            {children}
          </div>
          {copyValue === undefined ? null : <CopyButton value={copyValue} />}
        </div>
        {fold.long ? (
          <FoldToggle folded={fold.folded} controls={valueId} onToggle={fold.toggle} />
        ) : null}
      </dd>
    </div>
  );
}

function FoldToggle({
  folded,
  controls,
  onToggle
}: {
  folded: boolean;
  controls: string;
  onToggle(): void;
}) {
  const labels = useUiLabels("KeyValue");
  return (
    <Button
      type="button"
      variant="link"
      className="h-auto p-0 text-caption"
      aria-expanded={!folded}
      aria-controls={controls}
      onClick={onToggle}
    >
      {folded ? labels.showMore : labels.showLess}
    </Button>
  );
}

function CopyButton({ value }: { value: string }) {
  const labels = useUiLabels("KeyValue");
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
      className="-my-1"
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

/**
 * Folding of a long value. The control shows only when the value is longer than the three
 * lines it folds to, which is measured, because the same text is long in a narrow column and
 * short in a wide one.
 */
function useFold(foldable: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  const folded = foldable && !expanded;

  useEffect(() => {
    const node = ref.current;
    if (!foldable || !node || typeof ResizeObserver === "undefined") {
      return;
    }
    // Unfolded, the value shows whole and cannot be measured against its fold; it stays long.
    const measure = () => {
      if (node.classList.contains("line-clamp-3")) {
        setLong(node.scrollHeight > node.clientHeight + 1);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [foldable]);

  return {
    ref,
    folded,
    long: foldable && long,
    toggle: () => setExpanded((value) => !value)
  };
}
