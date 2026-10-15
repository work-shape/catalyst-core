import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import {
  calendarDay,
  dayMarkerLabel,
  dayOpeningMessages
} from "@vivd-catalyst/chat-ui/day-markers";

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
