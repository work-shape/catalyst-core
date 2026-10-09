import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactNode
} from "react";
import { cn } from "../cn";
import { useScrollEdgeFade } from "../scroll-edge-fade";
import { OverlayScope } from "../ui-root";
import { NavCollapsedContext } from "./nav-item";

/** The width under which the sidebar leaves the layout and becomes a drawer. */
const DRAWER_QUERY = "(width < 48rem)";

export interface SidebarProps extends Omit<HTMLAttributes<HTMLElement>, "aria-label"> {
  /** Names the navigation landmark, and the drawer under 768 px. */
  label: string;
  /** Stays in place above the scrolling body, such as a workspace selector. */
  header?: ReactNode;
  /** Stays in place below the scrolling body, such as the account menu. */
  footer?: ReactNode;
  /** Shows icons only. A drawer is never collapsed. */
  collapsed?: boolean;
  /** Under 768 px the sidebar is a drawer; this opens it. */
  drawerOpen?: boolean;
  /** The drawer was dismissed with Escape or a press outside it. */
  onDrawerClose?(): void;
}

/**
 * The frame of the main navigation: a header, a scrolling body of `NavGroup`s and `NavItem`s,
 * and a footer. It is 280 px wide, collapses to a strip of icons, and under 768 px leaves the
 * layout and opens as a modal drawer. What it shows belongs to the caller.
 * Its content mounts anew when the window crosses 768 px, so the caller controls the state of
 * its groups (`NavGroup` `open`) where that state must survive.
 */
export function Sidebar({
  className,
  label,
  header,
  footer,
  collapsed = false,
  drawerOpen = false,
  onDrawerClose,
  children,
  ...props
}: SidebarProps) {
  const drawer = useMediaQuery(DRAWER_QUERY);
  const iconsOnly = collapsed && !drawer;
  const body = useScrollEdgeFade<HTMLElement>([iconsOnly, drawer]);

  const frame = (
    <aside
      aria-label={label}
      data-collapsed={iconsOnly ? "" : undefined}
      className={cn(
        "flex h-full min-h-0 shrink-0 flex-col bg-sidebar text-sidebar-foreground",
        drawer
          ? "w-full"
          : cn("border-r border-sidebar-border", iconsOnly ? "w-12" : "w-(--layout-sidebar)"),
        className
      )}
      {...props}
    >
      {header === undefined ? null : <div className="shrink-0 px-2 pt-2">{header}</div>}
      <nav
        ref={body.ref}
        style={body.style}
        onScroll={body.onScroll}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2 [scrollbar-width:thin]"
      >
        <div className="flex flex-col gap-4">{children}</div>
      </nav>
      {footer === undefined ? null : <div className="shrink-0 px-2 pb-2">{footer}</div>}
    </aside>
  );

  return (
    <NavCollapsedContext value={iconsOnly}>
      {drawer ? (
        <SidebarDrawer label={label} open={drawerOpen} onClose={onDrawerClose}>
          {frame}
        </SidebarDrawer>
      ) : (
        frame
      )}
    </NavCollapsedContext>
  );
}

/**
 * The sidebar as a modal drawer on the browser's own `dialog` element: it holds the focus,
 * closes on Escape and on a press outside, and returns the focus to what opened it.
 */
function SidebarDrawer({
  label,
  open,
  onClose,
  children
}: {
  label: string;
  open: boolean;
  onClose?(): void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerStartedOnBackdropRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={label}
      className="m-0 h-dvh max-h-none w-(--layout-sidebar) max-w-[calc(100vw-2rem)] overflow-hidden border-0 bg-sidebar p-0 text-sidebar-foreground shadow-modal backdrop:bg-scrim"
      onClose={onClose}
      onPointerDown={(event) => {
        pointerStartedOnBackdropRef.current = event.target === dialogRef.current;
      }}
      onClick={(event) => {
        if (pointerStartedOnBackdropRef.current && event.target === dialogRef.current) {
          onClose?.();
        }
        pointerStartedOnBackdropRef.current = false;
      }}
    >
      <OverlayScope>
        {(overlayContainer) => (
          <>
            {children}
            {overlayContainer}
          </>
        )}
      </OverlayScope>
    </dialog>
  );
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}
