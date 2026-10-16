import { prefersReducedMotion } from "@work-shape/catalyst-ui";
import type { DockMotion } from "../../shared/workspace-route";

/**
 * The dock's movement is a view transition of the type its `DockMotion` names, which the
 * stylesheet animates (`styles.css`, "The chat dock"). Without view transition types the shell
 * plays the same movement on the elements themselves. Under reduced motion nothing moves.
 */
export function dockViewTransitionsSupported(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    typeof CSS !== "undefined" &&
    CSS.supports("selector(:active-view-transition-type(dock-in))")
  );
}

/** The view transition a router plays for a change of route that moves the dock. */
export function dockViewTransition(
  motion: DockMotion | undefined
): { types: DockMotion[] } | undefined {
  return motion === undefined || prefersReducedMotion() ? undefined : { types: [motion] };
}
