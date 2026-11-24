import { describe, expect, it } from "vitest";
import { scrollTopKeepingPlace } from "@work-shape/catalyst-chat-ui/reading-place";
import {
  clampSurfaceWidth,
  SPLIT_MIN_FALLBACK_PX,
  surfacePlacement
} from "@work-shape/catalyst-chat-ui/surface-layout";

const SPLIT_MIN = SPLIT_MIN_FALLBACK_PX;
const SIDEBAR = 280;
const SIDEBAR_COLLAPSED = 48;
/** The main area of a window: what the sidebar leaves. */
const mainOf = (windowWidth: number, sidebar = SIDEBAR) => windowWidth - sidebar;

describe("the split between the conversation and what opens at its right", () => {
  it("stands beside the conversation from twice the minimum and covers it below", () => {
    expect(surfacePlacement(760, SPLIT_MIN)).toBe("beside");
    expect(surfacePlacement(759, SPLIT_MIN)).toBe("covering");
    // A window of 1024 with the sidebar open has no room for both sides; collapsed it has.
    expect(surfacePlacement(mainOf(1024), SPLIT_MIN)).toBe("covering");
    expect(surfacePlacement(mainOf(1024, SIDEBAR_COLLAPSED), SPLIT_MIN)).toBe("beside");
    // Before the area is measured nothing is known to be narrow.
    expect(surfacePlacement(undefined, SPLIT_MIN)).toBe("beside");
  });

  it("never leaves the conversation less than its minimum, whatever width was chosen", () => {
    for (const windowWidth of [1040, 2560]) {
      for (const sidebar of [SIDEBAR, SIDEBAR_COLLAPSED]) {
        const main = mainOf(windowWidth, sidebar);
        for (const chosen of [0, 560, 5000]) {
          const width = clampSurfaceWidth(chosen, main, SPLIT_MIN);
          expect(width).toBeGreaterThanOrEqual(SPLIT_MIN);
          expect(main - width).toBeGreaterThanOrEqual(SPLIT_MIN);
        }
      }
    }
  });
});

describe("the reader's place when the thread wraps anew", () => {
  it("puts the block that was being read back where it stood", () => {
    expect(
      scrollTopKeepingPlace({
        scrollTop: 1782,
        maxScrollTop: 5000,
        atEnd: false,
        blockTop: { before: 96, now: 240 }
      })
    ).toBe(1926);
    expect(
      scrollTopKeepingPlace({
        scrollTop: 1782,
        maxScrollTop: 5000,
        atEnd: false,
        blockTop: { before: 96, now: -336 }
      })
    ).toBe(1350);
  });

  it("keeps a reader at the end at the end", () => {
    expect(
      scrollTopKeepingPlace({
        scrollTop: 3060,
        maxScrollTop: 3348,
        atEnd: true,
        blockTop: { before: 96, now: 96 }
      })
    ).toBe(3348);
  });
});
