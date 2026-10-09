import type { ReactNode } from "react";
import { cn, useScrollEdgeFade } from "@vivd-catalyst/ui";

/**
 * The scrolling region of a workspace dialog.
 *
 * Every workspace dialog is built the same way: a pinned header, this, and a
 * pinned action footer. Keeping the region in one component keeps three things
 * consistent that were previously easy to get wrong per dialog:
 *
 * - Padding. Equal `py-5` at both edges, and `pl-5` matching the dialog's
 *   horizontal rhythm, so content at rest never sits flush against the cut and
 *   a half-scrolled state looks deliberate rather than broken.
 * - The gutter. `pr-3` plus the scrollbar's own width keeps the content clear
 *   of the thumb while the thumb itself sits against the dialog edge.
 * - The edge fade, which signals which edge is hiding content.
 *
 * The inner wrapper exists so the fade's ResizeObserver has a single element
 * whose height tracks the content: it re-measures when a section expands (the
 * emoji grid, a loaded member list) without the caller declaring dependencies.
 */
export function CollaborationWorkspaceDialogScrollBody({
  children,
  className,
  contentClassName
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const fade = useScrollEdgeFade<HTMLDivElement>();

  return (
    <div
      ref={fade.ref}
      style={fade.style}
      data-testid="collaboration-workspace-dialog-scroll-body"
      data-overflow-above={fade.overflow.above ? "true" : "false"}
      data-overflow-below={fade.overflow.below ? "true" : "false"}
      className={cn("chat-scrollbar overflow-y-auto py-5 pl-5 pr-3", className)}
      onScroll={fade.onScroll}
    >
      <div className={cn("grid auto-rows-max content-start gap-5", contentClassName)}>
        {children}
      </div>
    </div>
  );
}

/**
 * The pinned action row. Stays outside the scrolling region so a primary action
 * is always reachable, and its rule doubles as the bottom boundary of the
 * scroll area.
 */
export function CollaborationWorkspaceDialogFooter({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-2 border-t px-5 py-4">{children}</div>;
}
