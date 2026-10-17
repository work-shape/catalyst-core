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
        className={cn("block w-full min-w-0 break-words whitespace-pre-line", fold.className)}
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

/** Three lines, with the browser's "…" where the value goes on. */
const FOLD = "line-clamp-3";
/**
 * Three lines without a mark, for a fold whose third line ends with a full stop: a "…" behind
 * the stop reads as a trailing sentence. `3lh` is the height `line-clamp-3` keeps.
 */
const FOLD_AT_FULL_STOP = "max-h-[3lh] overflow-hidden";

/**
 * Folding of a long value. The control shows only when the value is longer than the three
 * lines it folds to, which is measured, because the same text is long in a narrow column and
 * short in a wide one.
 */
export function useFold<Node extends HTMLElement>(foldable: boolean) {
  const ref = useRef<Node>(null);
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  const [endsAtFullStop, setEndsAtFullStop] = useState(false);
  const folded = foldable && !expanded;

  useEffect(() => {
    const node = ref.current;
    // Unfolded, the value shows whole and cannot be measured against its fold; it stays long.
    if (!folded || !node || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = () => {
      const cut = node.scrollHeight > node.clientHeight + 1;
      setLong(cut);
      setEndsAtFullStop(cut && lastShownCharacter(node) === ".");
    };
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(node);
    // A new text of the same height resizes nothing, and its third line may end differently.
    // Attributes stay unobserved: the fold's own class changes with what it measures.
    const changed = new MutationObserver(measure);
    changed.observe(node, { childList: true, characterData: true, subtree: true });
    return () => {
      resized.disconnect();
      changed.disconnect();
    };
  }, [folded]);

  return {
    ref,
    folded,
    long: foldable && long,
    /** The fold's classes, for the element `ref` is on. */
    className: folded ? (endsAtFullStop ? FOLD_AT_FULL_STOP : FOLD) : undefined,
    toggle: () => setExpanded((value) => !value)
  };
}

/**
 * The last character a folded value shows, white space aside: where its third line ends. The
 * text up to a character ends no lower than the character, so each text node is halved down to
 * the characters that end above the fold.
 */
function lastShownCharacter(node: HTMLElement): string | undefined {
  const document = node.ownerDocument;
  const foldBottom = node.getBoundingClientRect().top + node.clientHeight + 1;
  const range = document.createRange();
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let last: string | undefined;
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    const text = next;
    const value = text.textContent ?? "";
    const endsAbove = (end: number) => {
      range.setStart(text, 0);
      range.setEnd(text, end);
      return range.getBoundingClientRect().bottom <= foldBottom;
    };
    if (value.length === 0) continue;
    if (!endsAbove(1)) break;
    let shown = 1;
    let hidden = value.length + 1;
    while (hidden - shown > 1) {
      const middle = Math.floor((shown + hidden) / 2);
      if (endsAbove(middle)) shown = middle;
      else hidden = middle;
    }
    last = value.slice(0, shown).trimEnd().at(-1) ?? last;
    if (shown < value.length) break;
  }
  return last;
}
