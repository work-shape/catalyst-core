import { useEffect, useState, type HTMLAttributes } from "react";
import { prefersReducedMotion } from "../motion";

/** The time between two steps of the typing. */
const TYPED_TEXT_STEP_MS = 24;
/** The most steps a text is typed in, so a long one takes no longer than a good second. */
const TYPED_TEXT_MAX_STEPS = 50;

export interface TypedTextProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** The text. The first one stands at once; one that replaces it is typed in. */
  text: string;
  /**
   * This text stands at once where it replaces another: for one the reader typed themselves,
   * who has just seen every letter of it.
   */
  still?: boolean;
}

/**
 * A short text that somebody else may change while it is read, such as a title an agent gives:
 * the new text is typed in letter by letter, so the reader sees that it changed and that they
 * did not change it. The whole text is in the element from the first letter on, so its name
 * for a screen reader is never half a text. Under reduced motion it stands at once.
 */
export function TypedText({ text, still = false, ...props }: TypedTextProps) {
  const [shown, setShown] = useState(text);
  // How many letters are typed. Without a number the text stands.
  const [typed, setTyped] = useState<number>();
  const letters = Array.from(text);
  const step = Math.max(1, Math.ceil(letters.length / TYPED_TEXT_MAX_STEPS));

  // State derived from the render before: another text starts over, also in the middle of one.
  if (shown !== text) {
    setShown(text);
    setTyped(still || prefersReducedMotion() ? undefined : 0);
  }

  useEffect(() => {
    if (typed === undefined) {
      return undefined;
    }
    const timer = window.setTimeout(
      () => setTyped(typed + step < letters.length ? typed + step : undefined),
      TYPED_TEXT_STEP_MS
    );
    return () => window.clearTimeout(timer);
  }, [typed, step, letters.length]);

  if (typed === undefined || shown !== text) {
    return <span {...props}>{text}</span>;
  }
  return (
    <span data-typing="" {...props}>
      {letters.slice(0, typed).join("")}
      <span
        aria-hidden="true"
        className="inline-block h-[1em] w-px translate-y-[0.15em] bg-current"
      />
      <span className="sr-only">{letters.slice(typed).join("")}</span>
    </span>
  );
}
