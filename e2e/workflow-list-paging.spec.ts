import { expect, test, type Page } from "@playwright/test";
import { showWorkflowsUntil } from "./workflow-list-paging";

// DISCOVERY-PAGING: the walk a spec makes through the Workflow list's "Show more", against a
// list that needs no instance. It keeps the order the screen has: a press asks for its page at
// once and draws its loading state a task later, then draws the page a task after the answer.
// The first walk pressed again into the loading button, which the last page then took away.

const ORIGIN = "http://workflow-list.test";

/** The list page: the first page drawn, and "Show more" while a cursor follows. */
const LIST_PAGE = `<!doctype html>
<section data-testid="workflows-area">
  <ul aria-label="Workflows"></ul>
  <div data-workflows-more=""><button type="button">Show more</button></div>
</section>
<script>
  const list = document.querySelector("ul");
  const more = document.querySelector("[data-workflows-more]");
  const button = more.querySelector("button");
  let cursor = "";
  function draw(page) {
    for (const title of page.items) {
      const row = document.createElement("li");
      row.textContent = title;
      list.append(row);
    }
    if (page.nextCursor === undefined) more.remove();
    else cursor = page.nextCursor;
  }
  async function read() {
    const answer = await fetch("${ORIGIN}/api/v1/assets/workflow?limit=50&cursor=" + cursor);
    const page = await answer.json();
    setTimeout(() => {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      draw(page);
    }, 0);
  }
  button.addEventListener("click", () => {
    void read();
    setTimeout(() => {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }, 0);
  });
  draw(${JSON.stringify({ items: ["Published 0"], nextCursor: "1" })});
</script>`;

/**
 * Opens the list over `pages` answers, the page after cursor `n` being `pages[n]`; each answer
 * waits `delayMs`. `advance` false answers every read with the first cursor again.
 */
async function openList(page: Page, pages: number, delayMs: number, advance = true) {
  await page.route(`${ORIGIN}/api/v1/assets/workflow*`, async (route) => {
    const from = Number(new URL(route.request().url()).searchParams.get("cursor"));
    const last = from === pages - 1;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      json: {
        items: Array.from({ length: 50 }, (_, index) => `Draft ${from}-${index}`),
        ...(last ? {} : { nextCursor: String(advance ? from + 1 : 1) })
      }
    });
  });
  await page.route(`${ORIGIN}/`, (route) =>
    route.fulfill({ contentType: "text/html", body: LIST_PAGE })
  );
  await page.goto(`${ORIGIN}/`);
  return page.getByRole("list", { name: "Workflows" });
}

test.describe("the walk through the Workflow list's Show more", () => {
  test("reaches a Workflow on the last of many pages answered at once", async ({ page }) => {
    const list = await openList(page, 12, 0);
    await showWorkflowsUntil(page, list.getByText("Draft 11-49"));
    await expect(list.getByText("Draft 11-49")).toBeVisible();
    await expect(page.locator("[data-workflows-more]")).toHaveCount(0);
  });

  test("reaches a Workflow across pages answered late", async ({ page }) => {
    const list = await openList(page, 4, 400);
    await showWorkflowsUntil(page, list.getByText("Draft 3-0"));
    await expect(list.getByText("Draft 3-0")).toBeVisible();
  });

  test("fails, and quickly, where the list ends without the Workflow", async ({ page }) => {
    test.setTimeout(20_000);
    const list = await openList(page, 3, 0);
    await expect(showWorkflowsUntil(page, list.getByText("Never listed"))).rejects.toThrow(
      "The list ended without the Workflow"
    );
  });

  test("fails, and quickly, where a press reads no page it had not read", async ({ page }) => {
    test.setTimeout(20_000);
    const list = await openList(page, 5, 0, false);
    await expect(showWorkflowsUntil(page, list.getByText("Draft 4-0"))).rejects.toThrow(
      "A press of Show more read no page the list had not read"
    );
  });
});
