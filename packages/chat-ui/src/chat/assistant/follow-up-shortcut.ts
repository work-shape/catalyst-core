import type { FollowUpMode } from "@work-shape/catalyst-api-client";

// While a run goes, Enter sends in the person's own mode and Cmd+Enter (Ctrl+Enter off Apple
// devices) in the other one (FU-2). With no run, both just send.

/** The mode a send during a run takes: the person's, or the other one with the modifier. */
export function followUpModeOfSend(own: FollowUpMode, otherKey: boolean): FollowUpMode {
  if (!otherKey) return own;
  return own === "queue" ? "steer" : "queue";
}

/** The keys that send in the other mode, as the person's keyboard names them. */
export function otherShortcutKeys(platform = globalThis.navigator?.platform ?? ""): string {
  return /mac|iphone|ipad/iu.test(platform) ? "⌘+Enter" : "Ctrl+Enter";
}
