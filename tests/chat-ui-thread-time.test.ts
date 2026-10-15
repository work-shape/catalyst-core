import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import {
  calendarDay,
  createThreadTimes,
  dayMarkerLabel,
  dayOpeningMessages,
  formatElapsedSeconds,
  formatWorkHistoryLabel,
  msUntilNextMidnight,
  transcriptMessageTimes
} from "../packages/chat-ui/src/assistant/thread-time";

const berlin = "Europe/Berlin";

/** Intl writes a narrow no-break space before AM and PM; the tests read a plain one. */
function plain(text: string): string {
  return text.replace(/[  ]/gu, " ");
}

function openings(
  messages: Array<[id: string, at: string]>,
  timeZone: string
): Array<[string, string]> {
  return [
    ...dayOpeningMessages(
      messages.map(([id, at]) => ({ id, at })),
      timeZone
    )
  ];
}

describe("run times", () => {
  it("formats elapsed time consistently for active and completed runs", () => {
    expect(formatElapsedSeconds(42)).toBe("42s");
    expect(formatElapsedSeconds(102)).toBe("1m 42s");
    expect(formatWorkHistoryLabel("Arbeitsverlauf", 102_000)).toBe("Arbeitsverlauf · 1m 42s");
  });
});

describe("day boundaries of a conversation", () => {
  it("marks the first message, and the first one of each later day only", () => {
    expect(
      openings(
        [
          ["a", "2026-10-13T08:00:00.000Z"],
          ["b", "2026-10-13T09:00:00.000Z"],
          ["c", "2026-10-15T07:00:00.000Z"],
          ["d", "2026-10-15T07:01:00.000Z"]
        ],
        berlin
      )
    ).toEqual([
      ["a", "2026-10-13T08:00:00.000Z"],
      ["c", "2026-10-15T07:00:00.000Z"]
    ]);
  });

  it("puts midnight in the reader's time zone, not in UTC", () => {
    // 23:59:59 and 00:00:00 in Berlin, summer time: both are 14 October in UTC.
    const beforeMidnight = "2026-10-14T21:59:59.000Z";
    const atMidnight = "2026-10-14T22:00:00.000Z";
    expect(calendarDay(new Date(atMidnight), berlin)).toBe(
      calendarDay(new Date(beforeMidnight), berlin) + 1
    );
    expect(
      openings(
        [
          ["late", beforeMidnight],
          ["early", atMidnight]
        ],
        berlin
      ).map(([id]) => id)
    ).toEqual(["late", "early"]);
    expect(
      openings(
        [
          ["late", beforeMidnight],
          ["early", atMidnight]
        ],
        "UTC"
      ).map(([id]) => id)
    ).toEqual(["late"]);
  });

  it("gives one moment a different day on either side of the date line", () => {
    const messages: Array<[string, string]> = [
      ["a", "2026-10-15T01:00:00.000Z"],
      ["b", "2026-10-15T16:00:00.000Z"]
    ];
    // Tokyo: 10:00 and 01:00 the next day. Los Angeles: 18:00 the day before, and 09:00.
    expect(openings(messages, "Asia/Tokyo").map(([id]) => id)).toEqual(["a", "b"]);
    expect(openings(messages, "America/Los_Angeles").map(([id]) => id)).toEqual(["a", "b"]);
    expect(openings(messages, "UTC").map(([id]) => id)).toEqual(["a"]);
  });

  it("keeps a 25-hour and a 23-hour day as one day each", () => {
    // Summer time ends in Berlin on 25 October 2026: 00:30 CEST and 23:30 CET are one day.
    expect(
      openings(
        [
          ["a", "2026-10-24T22:30:00.000Z"],
          ["b", "2026-10-25T22:30:00.000Z"],
          ["c", "2026-10-25T23:00:00.000Z"]
        ],
        berlin
      ).map(([id]) => id)
    ).toEqual(["a", "c"]);
    // It begins on 29 March 2026: 00:30 CET and 23:30 CEST, 22 hours apart, are one day.
    expect(
      openings(
        [
          ["a", "2026-03-28T23:30:00.000Z"],
          ["b", "2026-03-29T21:30:00.000Z"],
          ["c", "2026-03-29T22:00:00.000Z"]
        ],
        berlin
      ).map(([id]) => id)
    ).toEqual(["a", "c"]);
  });

  it("does not mark a day again for a message out of order", () => {
    expect(
      openings(
        [
          ["a", "2026-10-14T08:00:00.000Z"],
          ["b", "2026-10-15T08:00:00.000Z"],
          // Older than the day before it: it opens no day, and the day it would leave is not marked twice.
          ["c", "2026-10-14T09:00:00.000Z"],
          ["d", "2026-10-15T09:00:00.000Z"],
          ["e", "2026-10-16T08:00:00.000Z"]
        ],
        berlin
      ).map(([id]) => id)
    ).toEqual(["a", "b", "e"]);
  });

  it("skips a message without a readable time", () => {
    expect(
      openings(
        [
          ["a", "not a time"],
          ["b", "2026-10-15T08:00:00.000Z"]
        ],
        berlin
      ).map(([id]) => id)
    ).toEqual(["b"]);
  });
});

describe("day marker wording", () => {
  // Thursday 15 October 2026, 12:00 in Berlin.
  const now = new Date("2026-10-15T10:00:00.000Z");
  const label = (at: string, locale: "en" | "de", timeZone = berlin) =>
    plain(dayMarkerLabel({ at, now, locale, t: createTranslationContext(locale).t, timeZone }));

  it("says today and yesterday with the time", () => {
    expect(label("2026-10-15T08:47:00.000Z", "en")).toBe("Today 10:47 AM");
    expect(label("2026-10-15T08:47:00.000Z", "de")).toBe("Heute 10:47");
    expect(label("2026-10-14T14:12:00.000Z", "en")).toBe("Yesterday 4:12 PM");
    expect(label("2026-10-14T14:12:00.000Z", "de")).toBe("Gestern 16:12");
  });

  it("counts calendar days, not hours, for yesterday", () => {
    // 23:59 the day before, twelve hours ago.
    expect(label("2026-10-14T21:59:00.000Z", "en")).toBe("Yesterday 11:59 PM");
    // 00:01 today.
    expect(label("2026-10-14T22:01:00.000Z", "en")).toBe("Today 12:01 AM");
  });

  it("names the weekday within the last week", () => {
    expect(label("2026-10-11T08:47:00.000Z", "en")).toBe("Sunday 10:47 AM");
    expect(label("2026-10-11T08:47:00.000Z", "de")).toBe("Sonntag 10:47");
    expect(label("2026-10-09T08:47:00.000Z", "en")).toBe("Friday 10:47 AM");
  });

  it("gives the full date from a week back, and for a time ahead of the reader's clock", () => {
    expect(label("2026-10-08T08:47:00.000Z", "en")).toBe("October 8, 2026 at 10:47 AM");
    expect(label("2026-10-08T08:47:00.000Z", "de")).toBe("8. Oktober 2026 um 10:47");
    expect(label("2026-10-16T08:47:00.000Z", "en")).toBe("October 16, 2026 at 10:47 AM");
  });

  it("reads the day in the reader's time zone", () => {
    // Now is 19:00 on 15 October in Tokyo and 03:00 on 15 October in Los Angeles.
    expect(label("2026-10-14T16:00:00.000Z", "en", "Asia/Tokyo")).toBe("Today 1:00 AM");
    expect(label("2026-10-15T16:00:00.000Z", "en", "America/Los_Angeles")).toBe("Today 9:00 AM");
    expect(label("2026-10-15T01:00:00.000Z", "en", "America/Los_Angeles")).toBe(
      "Yesterday 6:00 PM"
    );
  });
});

describe("the moments of a thread's messages", () => {
  const t = createTranslationContext("en").t;
  /** The labels of the markers a thread shows, read at `now` in Berlin. */
  function labelsOf(timed: Array<{ id: string; at: string }>, now: Date): Array<[string, string]> {
    return [...dayOpeningMessages(timed, berlin)].map(([id, at]) => [
      id,
      plain(dayMarkerLabel({ at, now, locale: "en", t, timeZone: berlin }))
    ]);
  }

  it("dates the latest run's answer, shown under the run's id, by the run's start", () => {
    expect(
      transcriptMessageTimes(
        [
          { id: "m1", createdAt: "2026-10-14T08:00:00.000Z" },
          { id: "m2", createdAt: "2026-10-14T08:00:05.000Z" }
        ],
        { run: { id: "run_1", startedAt: "2026-10-14T08:00:06.000Z" } }
      )
    ).toEqual({
      m1: "2026-10-14T08:00:00.000Z",
      m2: "2026-10-14T08:00:05.000Z",
      run_1: "2026-10-14T08:00:06.000Z"
    });
  });

  it("does not mark yesterday's stopped answer as written today when the thread is reopened", () => {
    const now = new Date("2026-10-15T10:00:00.000Z");
    const ids = ["m1", "run_failed"];
    const question = { m1: "2026-10-14T14:12:00.000Z" };
    // With the run's start, as the thread is given it.
    const withRun = createThreadTimes()({
      ids,
      stored: { ...question, run_failed: "2026-10-14T14:12:01.000Z" },
      busy: false,
      now
    });
    expect(labelsOf(withRun, now)).toEqual([["m1", "Yesterday 4:12 PM"]]);
    // Without any moment of its own, it takes the message before it: never now.
    const withoutRun = createThreadTimes()({ ids, stored: question, busy: false, now });
    expect(withoutRun).toEqual([
      { id: "m1", at: "2026-10-14T14:12:00.000Z" },
      { id: "run_failed", at: "2026-10-14T14:12:00.000Z" }
    ]);
    expect(labelsOf(withoutRun, now)).toEqual([["m1", "Yesterday 4:12 PM"]]);
    // A message without a moment before any stored one takes the one after it.
    expect(
      createThreadTimes()({ ids: ["x", "m1"], stored: question, busy: false, now })[0]
    ).toEqual({ id: "x", at: "2026-10-14T14:12:00.000Z" });
  });

  it("keeps the moment a message was sent until the server's arrives", () => {
    const times = createThreadTimes();
    const stored = { m1: "2026-10-14T08:00:00.000Z", m2: "2026-10-14T08:00:05.000Z" };
    // Sent at 23:59:50 in Berlin.
    const sent = new Date("2026-10-15T21:59:50.000Z");
    expect(
      times({ ids: ["m1", "m2", "optimistic"], stored, busy: true, now: sent }).at(-1)
    ).toEqual({ id: "optimistic", at: sent.toISOString() });
    // The answer appears at 00:00:10; the message sent does not move into the next day.
    const answered = new Date("2026-10-15T22:00:10.000Z");
    const later = times({
      ids: ["m1", "m2", "optimistic", "reply"],
      stored,
      busy: true,
      now: answered
    });
    expect(later.slice(-2)).toEqual([
      { id: "optimistic", at: sent.toISOString() },
      { id: "reply", at: answered.toISOString() }
    ]);
    expect(labelsOf(later, answered).map(([id]) => id)).toEqual(["m1", "optimistic", "reply"]);
    // Read again while nothing is busy any more: still the moment it was sent.
    expect(
      times({ ids: ["m1", "m2", "optimistic"], stored, busy: false, now: new Date() }).at(-1)
    ).toEqual({ id: "optimistic", at: sent.toISOString() });
    // Once the server's moment arrives, that one counts.
    expect(
      times({
        ids: ["m1", "m2", "optimistic"],
        stored: { ...stored, optimistic: "2026-10-15T21:59:51.000Z" },
        busy: false,
        now: answered
      }).at(-1)
    ).toEqual({ id: "optimistic", at: "2026-10-15T21:59:51.000Z" });
  });
});

describe("the next midnight", () => {
  function inBerlin<T>(read: () => T): T {
    const zone = process.env.TZ;
    process.env.TZ = berlin;
    try {
      return read();
    } finally {
      if (zone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = zone;
      }
    }
  }

  it("is the reader's next midnight, also across a change of the clocks", () => {
    // 23:59:50 in Berlin: ten seconds.
    expect(inBerlin(() => msUntilNextMidnight(new Date("2026-10-15T21:59:50.000Z")))).toBe(10_000);
    // 00:30 on the 25-hour day: 24 and a half hours.
    expect(inBerlin(() => msUntilNextMidnight(new Date("2026-10-24T22:30:00.000Z")))).toBe(
      24.5 * 3_600_000
    );
    // 00:30 on the 23-hour day: 22 and a half hours.
    expect(inBerlin(() => msUntilNextMidnight(new Date("2026-03-28T23:30:00.000Z")))).toBe(
      22.5 * 3_600_000
    );
  });
});
