import { APP_AUDIENCES } from "@work-shape/catalyst-asset-schemas";
/** The audience of an App's live revision, stored in its existing availability. */
export type AppAudience = (typeof APP_AUDIENCES)[number];

export interface AppAvailability {
  audience: AppAudience;
  /** The person who chose Only me, through their personal workspace availability. */
  userId?: string;
}

/** A change of audience widens reach when it admits anybody the live audience did not. */
export function appAudienceWidens(
  next: AppAudience,
  live: AppAudience,
  nextUserId?: string,
  liveUserId?: string
): boolean {
  if (next === "self" && live === "self") return nextUserId !== liveUserId;
  return APP_AUDIENCES.indexOf(next) > APP_AUDIENCES.indexOf(live);
}
