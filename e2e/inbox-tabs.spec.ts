import { apiBaseUrl, reviewer, signIn } from "./inbox-fixtures";
import { expect, test } from "./test";

// How the Inbox behaves while a tab's list is read for the first time. The test reads the
// reviewer's lists and writes nothing, so it needs no place in the serial Inbox file.

/**
 * A list answer held this long is one the reader does not wait for on a machine with room. How
 * long the answer really took is measured on the page: under load it can be a slow one.
 */
const INBOX_FAST_ANSWER_MS = 60;
/** A list answer long enough to notice. */
const INBOX_SLOW_ANSWER_MS = 700;
/** How long a tab is watched after the click: longer than the slow answer. */
const INBOX_WATCH_MS = 1_100;

test("a tab opened for the first time flashes no loading layout for a fast answer and shows it for a slow one", async ({
  page
}) => {
  await signIn(page, reviewer);
  let answerAfterMs = INBOX_FAST_ANSWER_MS;
  await page.route(
    (url) =>
      url.origin === new URL(apiBaseUrl).origin &&
      /^\/api\/v1\/approval-requests(?:\/mine)?$/u.test(url.pathname),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, answerAfterMs));
      await route.continue();
    }
  );
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
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
    expect(seen.shownAfterMs ?? seen.loadingDelayMs).toBeGreaterThanOrEqual(seen.loadingDelayMs);
  };

  // A fast answer: the list is there before a loading layout would show, so none does, and
  // the sentence of another tab's empty list never stands in.
  await openInbox();
  for (const name of ["My requests", "Decided"]) {
    const before = await emptyTextNow();
    const frames = watch();
    await inbox.getByRole("tab", { name, exact: true }).click();
    const seen = await frames;
    await expect(inbox.getByRole("tab", { name, exact: true })).toHaveAttribute(
      "aria-selected",
      "true"
    );
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
  await inbox.getByRole("tab", { name: "My requests", exact: true }).click();
  const slow = await frames;
  expect(slow.loadingFrames).toBeGreaterThan(0);
  expectUnseenForTheDelay(slow);
  await expect(inbox.getByRole("tabpanel").getByRole("status")).toHaveCount(0);
});
