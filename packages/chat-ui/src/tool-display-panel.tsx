import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import type { Surface } from "./surface/surface";

export interface ToolDisplayPanelAutoShowTracker {
  shouldAutoShow(key: string): boolean;
}

/** Which surface the surface slot holds. Cards open their surface through it. */
interface ToolDisplayPanelContextValue {
  available: boolean;
  entry?: Surface;
  open: boolean;
  show(entry: Surface): void;
  showOnce(entry: Surface): void;
  /**
   * Closes the surface. `restoreFocus` returns the focus to what opened it, for a close the
   * reader asked for on the surface itself.
   */
  close(options?: { restoreFocus?: boolean }): void;
}

const ToolDisplayPanelContext = createContext<ToolDisplayPanelContextValue | undefined>(undefined);

export function createToolDisplayPanelAutoShowTracker(): ToolDisplayPanelAutoShowTracker {
  const shownEntryKeys = new Set<string>();

  return {
    shouldAutoShow(key) {
      if (shownEntryKeys.has(key)) {
        return false;
      }
      shownEntryKeys.add(key);
      return true;
    }
  };
}

export function ToolDisplayPanelProvider({ children }: { children: ReactNode }) {
  const [entry, setEntry] = useState<Surface | undefined>();
  const [open, setOpen] = useState(false);
  const autoShowTrackerRef = useRef<ToolDisplayPanelAutoShowTracker | undefined>(undefined);
  if (!autoShowTrackerRef.current) {
    autoShowTrackerRef.current = createToolDisplayPanelAutoShowTracker();
  }
  const autoShowTracker = autoShowTrackerRef.current;

  // What held the focus when the reader opened the surface. A surface that opened by itself
  // has no opener.
  const openerRef = useRef<HTMLElement | undefined>(undefined);

  const show = useCallback((nextEntry: Surface) => {
    const focused = document.activeElement;
    openerRef.current =
      focused instanceof HTMLElement && focused !== document.body ? focused : undefined;
    setEntry(nextEntry);
    setOpen(true);
  }, []);

  const showOnce = useCallback(
    (nextEntry: Surface) => {
      if (!autoShowTracker.shouldAutoShow(nextEntry.key)) {
        return;
      }
      openerRef.current = undefined;
      setEntry(nextEntry);
      setOpen(true);
    },
    [autoShowTracker]
  );

  // The opener takes the focus once the surface has left the page: a chat the surface covered
  // is inert until then and would refuse it.
  const focusAfterCloseRef = useRef<HTMLElement | undefined>(undefined);

  const close = useCallback((options?: { restoreFocus?: boolean }) => {
    focusAfterCloseRef.current = options?.restoreFocus ? openerRef.current : undefined;
    openerRef.current = undefined;
    setOpen(false);
    setEntry(undefined);
  }, []);

  useEffect(() => {
    if (open) {
      return;
    }
    const opener = focusAfterCloseRef.current;
    focusAfterCloseRef.current = undefined;
    if (opener?.isConnected) {
      opener.focus();
    }
  }, [open]);

  const value = useMemo<ToolDisplayPanelContextValue>(
    () => ({
      available: true,
      entry,
      open,
      show,
      showOnce,
      close
    }),
    [close, entry, open, show, showOnce]
  );

  return (
    <ToolDisplayPanelContext.Provider value={value}>{children}</ToolDisplayPanelContext.Provider>
  );
}

export function useToolDisplayPanel(): ToolDisplayPanelContextValue {
  const value = useContext(ToolDisplayPanelContext);
  if (!value) {
    throw new Error("useToolDisplayPanel must be used within ToolDisplayPanelProvider");
  }
  return value;
}
