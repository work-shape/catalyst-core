import { X } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";
import { ModalSurface } from "./dialog";

export type DrawerSide = "right" | "left";

// The panel stands against one edge of the window at its full height: only the edge that faces
// the page keeps a line.
const drawerSides: Record<DrawerSide, string> = {
  right: "ml-auto border-l",
  left: "mr-auto border-r"
};

export interface DrawerProps {
  open: boolean;
  title: ReactNode;
  /** One or two sentences under the title that say what the drawer is for. */
  description?: ReactNode;
  /** The actions, pinned under the scrolling body. */
  footer?: ReactNode;
  /** The edge of the window the panel opens from. */
  side?: DrawerSide;
  /** Called by Escape, the close button and a press beside the panel. */
  onClose(): void;
  children: ReactNode;
  className?: string;
}

/**
 * A panel that opens from a side of the window, beside the page it belongs to. It is modal as a
 * `Dialog` is: it holds the focus, closes on Escape and on a press on the backdrop, and returns
 * the focus to what opened it. The header and the footer stay in place while the body scrolls.
 * On a window narrower than the panel it covers the window.
 */
export function Drawer({
  open,
  title,
  description,
  footer,
  side = "right",
  onClose,
  children,
  className
}: DrawerProps) {
  const labels = useUiLabels("Drawer");
  const titleId = useId();
  const descriptionId = useId();

  return (
    <ModalSurface
      open={open}
      labelledBy={titleId}
      describedBy={description === undefined ? undefined : descriptionId}
      className={cn(
        "m-0 h-dvh max-h-dvh w-[min(28rem,100vw)] max-w-none rounded-none border-0",
        drawerSides[side],
        className
      )}
      onClose={onClose}
    >
      <div data-drawer-side={side} className="flex h-full flex-col">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b px-5 py-3">
          <div className="grid min-w-0 gap-1 py-1">
            <h2 id={titleId} className="text-heading">
              {title}
            </h2>
            {description === undefined ? null : (
              <p id={descriptionId} className="text-body text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {/* A plain button: the drawer focuses it on opening, and a tooltip would open with it. */}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label={labels.close}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer === undefined ? null : (
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </ModalSurface>
  );
}
