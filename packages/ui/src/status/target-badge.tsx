import { useUiLabels } from "../ui-root";
import { Badge, type BadgeProps, type BadgeTone } from "./badge";

/**
 * Where a call goes or went: to what is live, to a test target that stands in for it, or
 * nowhere because it was simulated.
 */
export type CallTarget = "live" | "test" | "dry_run";

// Live is the state that has an effect, so it takes the tone of what is live everywhere.
const tones: Record<CallTarget, BadgeTone> = { live: "success", test: "info", dry_run: "neutral" };

export interface TargetBadgeProps extends Omit<BadgeProps, "tone" | "children"> {
  target: CallTarget;
}

/**
 * The marker of where a call goes, with the same three words wherever a draft's calls are
 * shown: Live, Test, Simulated. Small and outlined, so that it reads as a fact beside the
 * state of the object and not as that state.
 */
export function TargetBadge({
  target,
  size = "sm",
  appearance = "outline",
  ...props
}: TargetBadgeProps) {
  const labels = useUiLabels("TargetBadge");
  const text: Record<CallTarget, string> = {
    live: labels.targetLive,
    test: labels.targetTest,
    dry_run: labels.targetSimulated
  };
  return (
    <Badge tone={tones[target]} size={size} appearance={appearance} data-target={target} {...props}>
      {text[target]}
    </Badge>
  );
}
