import { mixedSeed, pick, shuffled } from "../random.js";
import type { Activity } from "./booking.js";

// Which booking stands where in a month. The month's bookings are those of its activities, in
// the order of their dates. All that is kept of a month is a table of how many bookings each
// activity has up to the end of each day, at most 31 lines of a few numbers, so finding the
// booking at one position costs the same in a month of a hundred bookings and of a hundred
// thousand.

/** How many of the activity's bookings are placed before `end`. */
function placedBefore({ count, place }: Activity, end: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (place(middle) < end) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The order of a month's bookings. `dayEnds` gives where each day ends on the line from 0 to
 * 1 that the activities place their bookings on. Inside a day the bookings of the activities
 * are mixed, the same way for a seed.
 */
export function schedule(
  activities: readonly Activity[],
  dayEnds: readonly number[],
  seed: number
) {
  const lastDay = dayEnds.length - 1;
  /** By activity and day: the bookings of the activity up to the end of that day. */
  const upTo = activities.map((activity) =>
    dayEnds.map((end, day) => (day === lastDay ? activity.count : placedBefore(activity, end)))
  );
  /** By day: the bookings of all activities up to the end of that day. */
  const dayTotals = dayEnds.map((_, day) => upTo.reduce((sum, ranks) => sum + pick(ranks, day), 0));
  const before = (ranks: readonly number[], day: number) => (day === 0 ? 0 : pick(ranks, day - 1));

  return {
    /** The day (from 0), the activity and the rank in it of the booking at `position`. */
    at(position: number): { day: number; activity: number; rank: number } {
      const day = dayTotals.findIndex((total) => position < total);
      if (day === -1) throw new Error(`The month has no booking at position ${position}.`);
      const dayStart = before(dayTotals, day);
      let slot = shuffled(
        position - dayStart,
        pick(dayTotals, day) - dayStart,
        mixedSeed(seed, day)
      );
      for (const [activity, ranks] of upTo.entries()) {
        const first = before(ranks, day);
        const held = pick(ranks, day) - first;
        if (slot < held) return { day, activity, rank: first + slot };
        slot -= held;
      }
      throw new Error(`No activity holds the booking at position ${position}.`);
    }
  };
}
