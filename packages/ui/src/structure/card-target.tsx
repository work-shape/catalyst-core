import { Slot } from "radix-ui";
import { useId, useRef, type ReactElement } from "react";

/** How far the pointer may move between press and release for the press to still be a click. */
const CLICK_SLOP_PX = 4;

export interface CardTargetProps {
  /** The id of the card's title. The target is named by its own text and the title. */
  titleId: string;
  /** The caller's link or button. It takes the props it is given and passes `className` on. */
  children: ReactElement;
}

/**
 * The one way into a card that opens as a whole: the caller's link or button to what the card
 * stands for, such as its main action in the footer. Its own box stays where it is and its
 * clickable area stretches over the card, so a click anywhere on the card is a click on it,
 * and the keyboard meets it once, named by its text and the card's title ("Open Trip
 * planner"). A press that is dragged before its release opens nothing.
 *
 * Every other control in the card stands above that area and keeps its own action. Text under
 * the area cannot be selected and shows no tooltip; content that must stay reachable, such as
 * a time with its full date as a tooltip or an id to copy, is wrapped in `CardReachable`.
 * A card whose reader has nowhere to go has no target and opens nothing.
 */
export function CardTarget({ titleId, children }: CardTargetProps) {
  const id = useId();
  const pressedAt = useRef<{ x: number; y: number } | undefined>(undefined);
  return (
    <Slot.Root
      id={id}
      aria-labelledby={`${id} ${titleId}`}
      data-card-target=""
      // The stretched area is placed against the card, so the target itself is not positioned.
      className="static cursor-pointer after:absolute after:inset-0 after:rounded-lg after:content-['']"
      onPointerDown={(event) => {
        pressedAt.current = { x: event.clientX, y: event.clientY };
      }}
      onClickCapture={(event) => {
        const start = pressedAt.current;
        pressedAt.current = undefined;
        // A press dragged across the card, as over its text, is no click. Enter has no press.
        if (
          start !== undefined &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {children}
    </Slot.Root>
  );
}

/**
 * Content of a card with a `CardTarget` that stands above the target's area: the pointer
 * reaches it, so its tooltip shows and its text can be selected. A click on it opens nothing.
 * The single child takes the props it is given.
 */
export function CardReachable({ children }: { children: ReactElement }) {
  return <Slot.Root data-card-reachable="">{children}</Slot.Root>;
}
