import { expect, type Locator, type Page, type Request } from "@playwright/test";

// The Workflow list shows the published Workflows first, then the drafts, a page at a time
// behind the shared "Show more". A spec that looks for one Workflow presses it until that one
// is shown, with no bound on the number of pages.
//
// A press is over once its page is drawn, not once its request was sent: the list asks the
// instance at once and draws its loading state a task later, so a press that only waited for
// the request saw the old button, still enabled, and pressed again into the loading one.

const MORE = "[data-workflows-more] button";
const LIST_PATHS = new Set(["/api/v1/workflows", "/api/v1/assets/workflow"]);
/** How long one press may take, from the click to its page on the screen. */
const PRESS_MS = 10_000;

/** Marks the document once the list starts loading, or adds or removes rows or "Show more". */
function watchPress() {
  const root = document.documentElement;
  root.dataset.workflowsPress = "pressed";
  const area = document.querySelector('[data-testid="workflows-area"]');
  if (area === null) return;
  const rows = "li, [data-workflows-more]";
  const changed = (node: Node) =>
    node instanceof Element && (node.matches(rows) || node.querySelector(rows) !== null);
  const observer = new MutationObserver((records) => {
    const drawn = records.some((record) =>
      record.type === "attributes"
        ? record.target instanceof Element &&
          record.target.closest("[data-workflows-more]") !== null
        : [...record.addedNodes, ...record.removedNodes].some(changed)
    );
    if (!drawn) return;
    root.dataset.workflowsPress = "drawn";
    observer.disconnect();
  });
  observer.observe(area, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-busy"]
  });
}

/** The press changed the list, and the list is not loading any more. */
function pressDrawn(): boolean {
  return (
    document.documentElement.dataset.workflowsPress === "drawn" &&
    document.querySelector('[data-workflows-more] button[aria-busy="true"]') === null
  );
}

/**
 * Presses the Workflow list's "Show more" until `target` is shown. Each press must read a
 * page the list had not read before, so a list that stops advancing fails within one press.
 */
export async function showWorkflowsUntil(page: Page, target: Locator): Promise<void> {
  const reads = new Set<string>();
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (LIST_PATHS.has(url.pathname)) {
      reads.add(`${url.pathname}?${url.searchParams.get("cursor") ?? ""}`);
    }
  };
  page.on("request", onRequest);
  try {
    const more = page.locator(MORE);
    await expect(target.or(more).first()).toBeVisible();
    while (!(await target.isVisible())) {
      expect(await more.count(), "The list ended without the Workflow").toBeGreaterThan(0);
      const read = reads.size;
      await page.evaluate(watchPress);
      await more.click({ timeout: PRESS_MS });
      await page.waitForFunction(pressDrawn, undefined, { timeout: PRESS_MS });
      expect(reads.size, "A press of Show more read no page the list had not read").toBeGreaterThan(
        read
      );
    }
  } finally {
    page.off("request", onRequest);
  }
}
