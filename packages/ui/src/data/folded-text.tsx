import { useEffect, useId, useRef, useState, type HTMLAttributes } from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

/**
 * A text that may be long, on three lines with a control that unfolds it. It is phrasing
 * content, so it fits where a paragraph's text goes, such as a checkbox's description.
 */
export function FoldedText({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  const textId = useId();
  const fold = useFold(true);
  return (
    <span className={cn("grid min-w-0 justify-items-start gap-1", className)} {...props}>
      <span
        ref={fold.ref}
        id={textId}
        className={cn(
          "block w-full min-w-0 break-words whitespace-pre-line",
          fold.folded && "line-clamp-3"
        )}
      >
        {children}
      </span>
      {fold.long ? (
        <FoldToggle
          component="FoldedText"
          folded={fold.folded}
          controls={textId}
          onToggle={fold.toggle}
        />
      ) : null}
    </span>
  );
}

/** The control that unfolds a folded value, and folds it again. */
export function FoldToggle({
  component,
  folded,
  controls,
  onToggle
}: {
  component: string;
  folded: boolean;
  controls: string;
  onToggle(): void;
}) {
  const labels = useUiLabels(component);
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

/**
 * Folding of a long value. The control shows only when the value is longer than the three
 * lines it folds to, which is measured, because the same text is long in a narrow column and
 * short in a wide one.
 */
export function useFold<Node extends HTMLElement>(foldable: boolean) {
  const ref = useRef<Node>(null);
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
