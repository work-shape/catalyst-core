import type { Locator } from "@playwright/test";
import { apiBaseUrl, reviewer, shoot, signIn, tabName } from "./inbox-fixtures";
import { expect, test } from "./test";

// How the Inbox behaves while a tab's list is read for the first time. The test writes
// nothing, so it needs no place in the serial Inbox file. A reviewer's lists are the whole
// instance's, whichever account reads them, and only a reviewer has tabs: an account of its
// own would not keep other tests' requests out. The test therefore reads each list and the
// counts once and keeps those answers, so what other tests write while it runs never reaches
// its page.

/**
 * A list answer held this long is one the reader does not wait for on a machine with room. How
 * long the answer really took is measured on the page: under load it can be a slow one.
 */
const INBOX_FAST_ANSWER_MS = 60;
/** A list answer long enough to notice. */
const INBOX_SLOW_ANSWER_MS = 700;
/**
 * How far the two clocks of the watch may differ. The browser counts the delay of a loading
 * layout on the animation clock, which stands at the start of a frame; the watch reads the
 * time inside the frame, when it sees the layout come into the page and when it sees it show.
 * So a layout that waited the whole delay can read up to one frame short of it: 178.2 ms
 * against 180 ms was measured beside other files. One frame at 60 Hz.
 */
const INBOX_FRAME_MS = 17;
/** How long a tab is watched after the click: longer than the slow answer. */
const INBOX_WATCH_MS = 1_100;

test("a tab opened for the first time flashes no loading layout for a fast answer and shows it for a slow one", async ({
  page
}) => {
  await signIn(page, reviewer);
  let answerAfterMs = INBOX_FAST_ANSWER_MS;
  // The first answer of each list and of the counts, by address: every later read gets the same.
  const listAnswers = new Map<
    string,
    { status: number; headers: Record<string, string>; body: Buffer }
  >();
  await page.route(
    (url) =>
      url.origin === new URL(apiBaseUrl).origin &&
      /^\/api\/v1\/approval-requests(?:\/mine|\/pending-count)?$/u.test(url.pathname),
    async (route) => {
      const request = route.request();
      // The lists are held; the counts on the tabs are only kept.
      if (!new URL(request.url()).pathname.endsWith("/pending-count")) {
        await new Promise((resolve) => setTimeout(resolve, answerAfterMs));
      }
      if (request.method() !== "GET") {
        await route.continue();
        return;
      }
      let answer = listAnswers.get(request.url());
      if (!answer) {
        const response = await route.fetch();
        answer = {
          status: response.status(),
          headers: response.headers(),
          body: await response.body()
        };
        listAnswers.set(request.url(), answer);
      }
      await route.fulfill(answer);
    }
  );
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  // A tab by its label. What another test left in a list before this one read the counts
  // stands as a count after the label: "My requests, 3 items".
  const tabNamed = (label: string) =>
    inbox.getByRole("tab", { name: new RegExp(`^${label}(?: ?, \\d+ items?)?$`, "u") });
  const openInbox = async () => {
    await page.goto("/inbox");
    await expect(inbox.getByRole("tab")).toHaveCount(3);
    await expect(inbox.getByRole("tabpanel").getByRole("status")).toHaveCount(0);
  };
  // What each frame after the click shows: a loading layout the reader can see, and the
  // sentence of an empty list. The times are counted from the moment the loading layout came
  // into the page, so they say how long the reader waited, whatever else the machine is doing.
  interface Watched {
    frames: number;
    loadingFrames: number;
    emptyTexts: string[];
    /** How long the library keeps a loading layout unseen. */
    loadingDelayMs: number;
    /** Whether a loading layout came into the page at all, seen or not. */
    loadingMounted: boolean;
    /** When it first showed and when the answer replaced it, if they did while watched. */
    shownAfterMs: number | undefined;
    answeredAfterMs: number | undefined;
  }
  const watch = () =>
    page.evaluate(
      (watchMs) =>
        new Promise<Watched>((resolve) => {
          const seen = { frames: 0, loadingFrames: 0, emptyTexts: new Set<string>() };
          const times: { mounted?: number; shown?: number; answered?: number } = {};
          const loadingNow = () =>
            document.querySelector('[data-testid="inbox-area"] [role="tabpanel"] [role="status"]');
          const mounts = new MutationObserver(() => {
            const now = performance.now();
            if (loadingNow()) {
              times.mounted ??= now;
            } else if (times.mounted !== undefined) {
              times.answered ??= now;
            }
          });
          mounts.observe(document.body, { childList: true, subtree: true });
          const delay = getComputedStyle(document.documentElement).getPropertyValue(
            "--duration-loading-delay"
          );
          const started = performance.now();
          const frame = () => {
            const area = document.querySelector('[data-testid="inbox-area"]');
            const loading = loadingNow();
            seen.frames += 1;
            if (loading && Number.parseFloat(getComputedStyle(loading).opacity) > 0) {
              seen.loadingFrames += 1;
              times.shown ??= performance.now();
            }
            const empty = area?.querySelector('[data-testid="inbox-empty"]')?.textContent;
            if (empty) {
              seen.emptyTexts.add(empty);
            }
            if (performance.now() - started < watchMs) {
              requestAnimationFrame(frame);
            } else {
              mounts.disconnect();
              const since = (time: number | undefined) =>
                time === undefined || times.mounted === undefined
                  ? undefined
                  : time - times.mounted;
              resolve({
                ...seen,
                emptyTexts: [...seen.emptyTexts],
                loadingDelayMs: Number.parseFloat(delay),
                loadingMounted: times.mounted !== undefined,
                shownAfterMs: since(times.shown),
                answeredAfterMs: since(times.answered)
              });
            }
          };
          requestAnimationFrame(frame);
        }),
      INBOX_WATCH_MS
    );
  const emptyTextNow = async () =>
    (await inbox.getByTestId("inbox-empty").count()) > 0
      ? [await inbox.getByTestId("inbox-empty").innerText()]
      : [];

  // The rule itself, whatever the answer took: no loading layout shows before the delay is over.
  const expectUnseenForTheDelay = (seen: Watched) => {
    expect(seen.loadingDelayMs).toBeGreaterThan(0);
    expect(seen.shownAfterMs ?? seen.loadingDelayMs).toBeGreaterThanOrEqual(
      seen.loadingDelayMs - INBOX_FRAME_MS
    );
  };

  // A fast answer: the list is there before a loading layout would show, so none does, and
  // the sentence of another tab's empty list never stands in.
  await openInbox();
  for (const name of ["My requests", "Decided"]) {
    const before = await emptyTextNow();
    const frames = watch();
    await tabNamed(name).click();
    const seen = await frames;
    await expect(tabNamed(name)).toHaveAttribute("aria-selected", "true");
    expect(seen.frames).toBeGreaterThan(10);
    expectUnseenForTheDelay(seen);
    // Beside a whole suite on a loaded machine the answer can take longer than the delay: the
    // loading layout is then right to show. An answer inside the delay shows none.
    const answeredInsideTheDelay =
      seen.answeredAfterMs !== undefined && seen.answeredAfterMs <= seen.loadingDelayMs;
    if (!seen.loadingMounted || answeredInsideTheDelay) {
      expect(seen.loadingFrames).toBe(0);
    }
    // Only the sentence that stood before the click and the one this tab ends with.
    const allowed = [...before, ...(await emptyTextNow())];
    expect(seen.emptyTexts.filter((text) => !allowed.includes(text))).toEqual([]);
  }

  // A slow answer: the library's loading layout shows while the reader waits.
  answerAfterMs = INBOX_SLOW_ANSWER_MS;
  await openInbox();
  const frames = watch();
  await tabNamed("My requests").click();
  const slow = await frames;
  expect(slow.loadingFrames).toBeGreaterThan(0);
  expectUnseenForTheDelay(slow);
  await expect(inbox.getByRole("tabpanel").getByRole("status")).toHaveCount(0);
});

/** What a phone shows of the Inbox's tab row: the selected tab, the fade and the page width. */
async function tabRowAt(tab: Locator) {
  return tab.evaluate((node) => {
    const clear = String.raw`(?:transparent|rgba\(0, 0, 0, 0\))`;
    const fadedEdges = (mask: string) => ({
      fadeStart: new RegExp(`^linear-gradient\\(to right, ${clear} 0`, "u").test(mask),
      fadeEnd: new RegExp(`${clear} 100%\\)$`, "u").test(mask)
    });
    const row = node.closest<HTMLElement>('[data-slot="tab-row"]');
    if (!row) {
      throw new Error("The tab stands in no tab row");
    }
    const rowBox = row.getBoundingClientRect();
    const tabBox = node.getBoundingClientRect();
    return {
      overflows: row.scrollWidth > row.clientWidth,
      selectedWhole: tabBox.left >= rowBox.left - 0.5 && tabBox.right <= rowBox.right + 0.5,
      // Which edges fade: the mask runs from transparent at a hidden edge to opaque.
      ...fadedEdges(getComputedStyle(row).maskImage),
      pageSideways: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
}

/**
 * Selects a tab the way a script does, without the focus that would scroll it into view itself:
 * the row has to bring it there.
 */
async function selectWithoutFocus(tab: Locator) {
  await tab.evaluate((node) =>
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
  );
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

test("at 320 the Inbox's tab row shows the selected tab whole, fades the edge that hides tabs and moves no page sideways", async ({
  page
}) => {
  // Signed in at the default width, where the rail with its search shows; then a phone.
  await signIn(page, reviewer);
  await page.setViewportSize({ width: 320, height: 844 });
  // Counts on the tabs that wait, as a busy instance has them: the row then does not fit at 320.
  await page.route(
    (url) =>
      url.origin === new URL(apiBaseUrl).origin &&
      url.pathname === "/api/v1/approval-requests/pending-count",
    async (route) => {
      const response = await route.fetch();
      const body: { mine: object } = await response.json();
      await route.fulfill({
        response,
        json: { ...body, count: 12, mine: { ...body.mine, pending: 3 } }
      });
    }
  );
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const toDecide = inbox.getByRole("tab", { name: tabName("To decide", 12) });
  const decided = inbox.getByRole("tab", { name: "Decided", exact: true });
  // The pictures are taken in both languages, so they find the tabs by place.
  const tabs = page.getByTestId("inbox-area").getByRole("tab");
  const ready = async () => {
    await expect(tabs).toHaveCount(3);
    await selectWithoutFocus(tabs.last());
    // The underline changes colour over a short transition; the picture waits for its end.
    await expect(tabs.first()).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
  };
  await page.goto("/inbox");
  await expect(toDecide).toHaveAttribute("aria-selected", "true");

  await expect
    .poll(() => tabRowAt(toDecide))
    .toEqual({
      overflows: true,
      selectedWhole: true,
      fadeStart: false,
      fadeEnd: true,
      pageSideways: 0
    });

  await selectWithoutFocus(decided);
  await expect
    .poll(() => tabRowAt(decided))
    .toEqual({
      overflows: true,
      selectedWhole: true,
      fadeStart: true,
      fadeEnd: false,
      pageSideways: 0
    });

  await shoot(page, "ui-lib-1-inbox-tabs-decided", ready, [1280, 390]);
  await shoot(
    page,
    "ui-lib-1-inbox-tabs-to-decide",
    async () => {
      await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    },
    [390]
  );
});
