import { useLayoutEffect, type RefObject } from "react";

/**
 * Puts the focus in the composer when it is asked for: `requestId` counts the requests, and 0
 * is none. The input is tried at once, after a frame and after 50 milliseconds, for an input
 * that is not ready at once.
 */
export function useComposerFocusRequest(
  inputRef: RefObject<HTMLTextAreaElement | null>,
  requestId: number
): void {
  useLayoutEffect(() => {
    if (requestId === 0) {
      return;
    }

    let cancelled = false;
    const animationFrameIds: number[] = [];
    const timeoutIds: number[] = [];

    function focusInput() {
      if (cancelled) {
        return;
      }
      const input = inputRef.current;
      if (!input || input.disabled) {
        return;
      }
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }

    // A person who presses a pointer or a key in the meantime has gone on, and a try after
    // that would take the focus out of what they opened and close it.
    const giveUp = () => {
      cancelled = true;
    };
    window.addEventListener("pointerdown", giveUp, true);
    window.addEventListener("keydown", giveUp, true);

    focusInput();
    animationFrameIds.push(window.requestAnimationFrame(focusInput));
    timeoutIds.push(window.setTimeout(focusInput, 0));
    timeoutIds.push(window.setTimeout(focusInput, 50));

    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", giveUp, true);
      window.removeEventListener("keydown", giveUp, true);
      for (const frameId of animationFrameIds) {
        window.cancelAnimationFrame(frameId);
      }
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [inputRef, requestId]);
}
