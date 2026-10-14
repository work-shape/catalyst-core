import { Zap } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";
import { Button } from "./button";

/** `off`: offered. `busy`: being switched on. `on`: the next call it covers runs live. */
export type RunLiveOnceState = "off" | "busy" | "on";

export interface RunLiveOnceProps {
  state: RunLiveOnceState;
  onSwitchOn(): void;
  /** What the switch covers once it is on, said in the button's place, such as "Your next call runs live." */
  onText: ReactNode;
  /** The button's accessible name where its text alone does not say what it switches. */
  label?: string;
  className?: string;
}

/**
 * "Run live once": one part of a draft whose calls are simulated runs live for the next call
 * it covers, and is simulated again after it. Once switched on, the button gives its place to
 * a line that says what it covers, so a second press cannot be made by mistake. Focus follows
 * the switch: to the line once it is on, and back to the button where it stays off. A switch
 * that shows as on when it appears takes no focus.
 */
export function RunLiveOnce({ state, onSwitchOn, onText, label, className }: RunLiveOnceProps) {
  const labels = useUiLabels("RunLiveOnce");
  const line = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const before = useRef(state);
  useEffect(() => {
    const was = before.current;
    before.current = state;
    // A busy button is disabled, which drops its focus: the focus goes where the switch went.
    if (was === "busy" && state === "on") {
      line.current?.focus();
    } else if (was === "busy" && state === "off") {
      button.current?.focus();
    }
  }, [state]);
  if (state === "on") {
    return (
      <span
        ref={line}
        tabIndex={-1}
        role="status"
        data-run-live-once="on"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-sm text-caption text-muted-foreground focus-visible:focus-ring [&>svg]:size-3.5 [&>svg]:shrink-0",
          className
        )}
      >
        <Zap aria-hidden="true" />
        {onText}
      </span>
    );
  }
  return (
    <Button
      ref={button}
      variant="outline"
      size="sm"
      loading={state === "busy"}
      aria-label={label}
      data-run-live-once={state}
      className={className}
      onClick={onSwitchOn}
    >
      <Zap aria-hidden="true" />
      {labels.runLiveOnce}
    </Button>
  );
}
