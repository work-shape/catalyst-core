import { describe, expect, it } from "vitest";
import { scrollTopKeepingPlace } from "@vivd-catalyst/chat-ui/reading-place";
import {
  clampSurfaceWidth,
  defaultSurfaceWidth,
  maxSurfaceWidth,
  SPLIT_MIN_FALLBACK_PX,
  surfacePlacement
} from "@vivd-catalyst/chat-ui/surface-layout";

const SPLIT_MIN = SPLIT_MIN_FALLBACK_PX;
const SIDEBAR = 280;
const SIDEBAR_COLLAPSED = 48;
/** The main area of a window: what the sidebar leaves. */
const mainOf = (windowWidth: number, sidebar = SIDEBAR) => windowWidth - sidebar;

describe("the split between the conversation and what opens at its right", () => {
  it("lets each side keep 380 px", () => {
    expect(SPLIT_MIN).toBe(380);
  });

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
    for (const windowWidth of [1040, 1280, 1440, 2000, 2560]) {
      for (const sidebar of [SIDEBAR, SIDEBAR_COLLAPSED]) {
        const main = mainOf(windowWidth, sidebar);
        for (const chosen of [0, 200, 380, 560, 900, 5000]) {
          const width = clampSurfaceWidth(chosen, main, SPLIT_MIN);
          expect(width).toBeGreaterThanOrEqual(SPLIT_MIN);
          expect(main - width).toBeGreaterThanOrEqual(SPLIT_MIN);
        }
      }
    }
    expect(maxSurfaceWidth(1000, SPLIT_MIN)).toBe(620);
  });

  it("opens a file or a view at 45 percent of the main area, at most 720 px", () => {
    for (const kind of ["file_preview", "tool_display"] as const) {
      expect(defaultSurfaceWidth(kind, mainOf(1280))).toBe(450);
      expect(defaultSurfaceWidth(kind, mainOf(1440))).toBe(522);
      expect(defaultSurfaceWidth(kind, mainOf(2000))).toBe(720);
      expect(defaultSurfaceWidth(kind, mainOf(1280, SIDEBAR_COLLAPSED))).toBe(554);
    }
  });

  it("leaves the conversation the wider side at the width a file opens at", () => {
    for (const windowWidth of [1280, 1440, 2000]) {
      for (const sidebar of [SIDEBAR, SIDEBAR_COLLAPSED]) {
        const main = mainOf(windowWidth, sidebar);
        const width = clampSurfaceWidth(defaultSurfaceWidth("file_preview", main), main, SPLIT_MIN);
        expect(main - width).toBeGreaterThan(width);
      }
    }
  });

  it("opens a file at the minimum in a main area where 45 percent would be less", () => {
    const main = 800;
    expect(defaultSurfaceWidth("file_preview", main)).toBe(360);
    expect(clampSurfaceWidth(defaultSurfaceWidth("file_preview", main), main, SPLIT_MIN)).toBe(380);
  });

  it("keeps the widths of the kinds that name pixels", () => {
    expect(defaultSurfaceWidth("inbox_item", 1000)).toBe(520);
    expect(defaultSurfaceWidth("page", 2000)).toBe(640);
    expect(defaultSurfaceWidth("app_view", 1000)).toBe(560);
    expect(defaultSurfaceWidth(undefined, 1000)).toBe(560);
    // Before the area is measured a share has nothing to be a share of.
    expect(defaultSurfaceWidth("file_preview", undefined)).toBe(720);
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

  it("stays within the thread and leaves the position alone without a block", () => {
    expect(
      scrollTopKeepingPlace({
        scrollTop: 40,
        maxScrollTop: 900,
        atEnd: false,
        blockTop: { before: 300, now: 100 }
      })
    ).toBe(0);
    expect(
      scrollTopKeepingPlace({
        scrollTop: 880,
        maxScrollTop: 900,
        atEnd: false,
        blockTop: { before: 100, now: 300 }
      })
    ).toBe(900);
    expect(
      scrollTopKeepingPlace({
        scrollTop: 500,
        maxScrollTop: 900,
        atEnd: false,
        blockTop: undefined
      })
    ).toBe(500);
  });
});
