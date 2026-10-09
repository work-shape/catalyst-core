import {
  createContext,
  useCallback,
  useContext,
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
  close(): void;
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

  const show = useCallback((nextEntry: Surface) => {
    setEntry(nextEntry);
    setOpen(true);
  }, []);

  const showOnce = useCallback(
    (nextEntry: Surface) => {
      if (!autoShowTracker.shouldAutoShow(nextEntry.key)) {
        return;
      }
      setEntry(nextEntry);
      setOpen(true);
    },
    [autoShowTracker]
  );

  const close = useCallback(() => {
    setOpen(false);
    setEntry(undefined);
  }, []);

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
