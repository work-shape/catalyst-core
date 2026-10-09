import { useEffect, useRef } from "react";

/** The actions of the frame that have keys. */
export type WorkspaceShortcut = "search" | "newChat";

interface ShortcutKeys {
  key: string;
  shift: boolean;
  apple: string;
  other: string;
}

const SHORTCUT_KEYS: Record<WorkspaceShortcut, ShortcutKeys> = {
  search: { key: "k", shift: false, apple: "⌘K", other: "Ctrl+K" },
  newChat: { key: "o", shift: true, apple: "⌘⇧O", other: "Ctrl+Shift+O" }
};

/** Apple keyboards have the command key; there Ctrl+K belongs to the text field. */
function onApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform);
}

/** The keys of a shortcut as the tooltip and the palette show them. */
export function workspaceShortcutLabel(shortcut: WorkspaceShortcut): string {
  const keys = SHORTCUT_KEYS[shortcut];
  return onApplePlatform() ? keys.apple : keys.other;
}

function shortcutOf(event: KeyboardEvent): WorkspaceShortcut | undefined {
  const modifier = onApplePlatform()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey) {
    return undefined;
  }
  const names: WorkspaceShortcut[] = ["search", "newChat"];
  return names.find((name) => {
    const keys = SHORTCUT_KEYS[name];
    return event.key.toLowerCase() === keys.key && event.shiftKey === keys.shift;
  });
}

/**
 * Listens for the frame's shortcuts anywhere in the window, a text field included. `blocked`
 * says whether a dialog other than the palette holds the window; the shortcuts rest then.
 */
export function useWorkspaceShortcuts(
  handlers: Record<WorkspaceShortcut, () => void>,
  blocked: () => boolean
): void {
  const latest = useRef({ handlers, blocked });
  latest.current = { handlers, blocked };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = shortcutOf(event);
      if (shortcut === undefined || latest.current.blocked()) {
        return;
      }
      event.preventDefault();
      latest.current.handlers[shortcut]();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
