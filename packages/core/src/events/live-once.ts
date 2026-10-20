import { LIVE_ONCE_AUDIT, type PlatformEventDefinition } from "./definition";

export const liveOnceEvents = {
  "live_once.cleared": { ...LIVE_ONCE_AUDIT, name: "live_once.cleared" },
  "live_once.switched_on": { ...LIVE_ONCE_AUDIT, name: "live_once.switched_on" },
  "live_once.used": { ...LIVE_ONCE_AUDIT, name: "live_once.used" }
} as const satisfies Record<string, PlatformEventDefinition>;
