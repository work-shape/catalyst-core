/**
 * The question a page with unsaved changes puts before the reader leaves it. It resolves with
 * `true` to leave. One page holds the guard at a time: the page that is open.
 */
export type LeaveGuard = () => Promise<boolean>;

let currentGuard: LeaveGuard | undefined;
const listeners = new Set<() => void>();

/** Holds the guard while a page has unsaved changes. The return value lets it go again. */
export function holdLeaveGuard(guard: LeaveGuard): () => void {
  currentGuard = guard;
  notify();
  return () => {
    if (currentGuard === guard) {
      currentGuard = undefined;
      notify();
    }
  };
}

/** Whether a page asks before it is left. A shell with a router blocks navigation while it does. */
export function hasLeaveGuard(): boolean {
  return currentGuard !== undefined;
}

export function subscribeLeaveGuard(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Asks the open page whether the reader may leave. Without a guard the answer is yes. */
export function mayLeave(): Promise<boolean> {
  return currentGuard ? currentGuard() : Promise.resolve(true);
}

function notify() {
  for (const listener of listeners) {
    listener();
  }
}
