import { z } from "zod";
import { exitTest as test } from "./exit-fixtures";
import {
  builtPage,
  openChat,
  overviewRoute,
  pageName,
  pageSource,
  pageSurface,
  patchThatAdds,
  patchThatRewrites,
  savePage,
  writePageFiles
} from "./page-surface-fixtures";
import { expect } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// A Page built in chat: the agent writes its files and saves them, and the Page shows beside
// the conversation on the kit the instance serves. The test model runs one tool per message,
// so writing the files and saving them are two messages where an agent takes one turn.

const kitDirectory = "/app-runtime/kit/1.0.0/";
const pageListSchema = z.object({ items: z.array(z.object({ id: z.string() })) });
const pageDetailSchema = z.object({ fileSets: z.array(z.object({ number: z.number() })) });

test("a Page built in chat shows beside the conversation, changes with the next save and is found again after a reload", async ({
  page,
  otherHost,
  refusals
}) => {
  const kitFiles: string[] = [];
  const otherAddresses: string[] = [];
  const runsStarted: string[] = [];
  page.on("request", (request) => {
    const address = new URL(request.url());
    if (address.pathname.startsWith(kitDirectory)) {
      kitFiles.push(address.pathname.slice(kitDirectory.length));
    } else if (address.origin !== apiOrigin && address.origin !== uiOrigin) {
      if (address.protocol !== "data:" && address.protocol !== "about:") {
        otherAddresses.push(request.url());
      }
    } else if (request.method() === "POST" && /\/runs$/u.test(address.pathname)) {
      runsStarted.push(address.pathname);
    }
  });

  await openChat(page);
  await expect(pageSurface(page)).toBeHidden();
  await writePageFiles(page, patchThatAdds(pageSource("Revenue overview")));
  await savePage(page);

  // The save opened the Page beside the conversation, as revision 1.
  const surface = pageSurface(page);
  await expect(surface).toBeVisible();
  await expect(surface).toHaveAccessibleName(pageName);
  await expect(surface).toContainText("Revision 1");
  const built = builtPage(page);
  await expect(built.getByRole("heading", { name: "Revenue overview" })).toBeVisible();
  const card = page.getByTestId("page-card");
  await expect(card).toHaveAttribute("data-state", "built");
  await expect(card).toContainText("Shown");

  // The Page runs without an origin: no cookie, no storage of the interface.
  const frame = page
    .frames()
    .find((candidate) => candidate.url() === "about:srcdoc" && candidate.parentFrame() !== null);
  if (!frame) {
    throw new Error("The Page's frame is not there");
  }
  expect(await frame.evaluate(() => window.origin)).toBe("null");
  // A frame without an origin has neither: the browser refuses the read itself.
  expect(
    await frame.evaluate(() =>
      [() => document.cookie, () => typeof window.localStorage].map((read) => {
        try {
          return read();
        } catch (error) {
          return error instanceof Error ? error.name : "refused";
        }
      })
    )
  ).toEqual(["SecurityError", "SecurityError"]);
  // A request to another host is refused by the Page's policy, and the browser says so.
  expect(
    await frame.evaluate(
      (address) =>
        fetch(address).then(
          () => "answered",
          () => "refused"
        ),
      `${otherHost.origin}/rows`
    )
  ).toBe("refused");
  await expect
    .poll(() =>
      refusals.filter((line) => /violates the following Content Security Policy/u.test(line))
    )
    .toHaveLength(1);
  expect(otherHost.requests).toEqual([]);

  // The second route reads pasted JSON. A link in a Page has no address, which the instance
  // takes from it when it serves the Page: the router moves on the click. The chart engine is asked for when a chart draws.
  expect(kitFiles).not.toContain("charts.js");
  await built.getByText("Data", { exact: true }).click();
  const rows = built.getByRole("textbox", { name: "Rows as JSON" });
  await expect(rows).toBeVisible();
  expect(kitFiles).not.toContain("charts.js");
  const runsBefore = runsStarted.length;
  await rows.fill(JSON.stringify([{ month: "January", revenue: 120 }]));
  const table = built.getByRole("table").first();
  await expect(table.getByRole("cell", { name: "January" })).toBeVisible();
  const chart = built.getByRole("figure", { name: "Revenue by month" });
  await expect(chart.locator("canvas, svg").first()).toBeVisible();
  expect(kitFiles.filter((file) => file === "charts.js")).toHaveLength(1);
  // Other JSON draws again, in the Page alone: no run is started.
  await rows.fill(
    JSON.stringify([
      { month: "January", revenue: 120 },
      { month: "February", revenue: 80 }
    ])
  );
  await expect(table.getByRole("cell", { name: "February" })).toBeVisible();
  await expect(chart.getByRole("rowheader", { name: "February" })).toBeAttached();
  expect(runsStarted).toHaveLength(runsBefore);
  expect(kitFiles.filter((file) => file === "charts.js")).toHaveLength(1);

  // The chart follows the width of the surface, also when the surface gets narrower.
  const drawing = chart.locator("canvas, svg").first();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await drawing.boundingBox())?.width ?? 0).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 720 });

  // The source of the revision, read-only.
  await surface.getByRole("radio", { name: "Files" }).click();
  const files = surface.getByRole("navigation", { name: "Source files" });
  await expect(files.getByText("src/routes/data.tsx")).toBeVisible();
  await expect(surface.getByRole("region", { name: "src/routes/index.tsx" })).toContainText(
    "Revenue overview"
  );
  await surface.getByRole("radio", { name: "Preview" }).click();
  // The Page kept its state under the files.
  await expect(table.getByRole("cell", { name: "February" })).toBeVisible();

  // The agent changes the Page: the next save is revision 2, on the route the reader was on.
  await writePageFiles(
    page,
    patchThatRewrites(
      "src/routes/index.tsx",
      overviewRoute("Revenue overview"),
      overviewRoute("Revenue this year")
    )
  );
  await savePage(page);
  await expect(surface).toContainText("Revision 2");
  await expect(builtPage(page).getByRole("textbox", { name: "Rows as JSON" })).toBeVisible();
  await builtPage(page).getByText("Overview", { exact: true }).click();
  await expect(builtPage(page).getByRole("heading", { name: "Revenue this year" })).toBeVisible();
  await expect(card).toHaveCount(2);
  await expect(card.last()).toContainText("Revision 2");
  await expect(card.last()).toContainText("Shown");
  await expect(card.first().getByRole("button", { name: "Open" })).toBeVisible();

  // The files of revision 2 say which one the save changed, and open on it.
  await surface.getByRole("radio", { name: "Files" }).click();
  await expect(files.getByText("Changed")).toHaveCount(1);
  await expect(surface.getByRole("region", { name: "src/routes/index.tsx" })).toContainText(
    "Revenue this year"
  );

  // The history of the Page lists both revisions.
  const conversationId = /\/c\/([^/?#]+)/u.exec(page.url())?.[1];
  expect(conversationId).toBeDefined();
  const pagesAddress = `${apiOrigin}/api/v1/conversations/${conversationId}/pages`;
  const listed = await page.request.get(pagesAddress, { headers: { Origin: uiOrigin } });
  expect(listed.ok()).toBe(true);
  const [stored, ...others] = pageListSchema.parse(await listed.json()).items;
  expect(others).toEqual([]);
  const detail = await page.request.get(`${pagesAddress}/${stored?.id}`, {
    headers: { Origin: uiOrigin }
  });
  expect(detail.ok()).toBe(true);
  expect(pageDetailSchema.parse(await detail.json()).fileSets.map((set) => set.number)).toEqual([
    2, 1
  ]);

  // After a reload the conversation shows its cards, and a card opens its revision.
  await page.reload();
  await expect(card).toHaveCount(2);
  await expect(pageSurface(page)).toBeHidden();
  await card.last().getByRole("button", { name: "Open" }).click();
  await expect(pageSurface(page)).toContainText("Revision 2");
  await expect(builtPage(page).getByRole("heading", { name: "Revenue this year" })).toBeVisible();

  // On a phone the Page covers the conversation and closes back to it.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(pageSurface(page)).toHaveAttribute("data-surface-mode", "covering");
  await expect(builtPage(page).getByRole("heading", { name: "Revenue this year" })).toBeVisible();
  await pageSurface(page).getByRole("radio", { name: "Files" }).click();
  await expect(pageSurface(page).getByRole("button", { name: "All files" })).toBeVisible();

  // Nothing the Page needed came from another host.
  expect(otherAddresses).toEqual([]);
  expect([...new Set(kitFiles)].sort()).toEqual([
    "charts.js",
    "kit.js",
    "react.js",
    "router.js",
    "ui.css",
    "ui.js"
  ]);
});

test("a save the build refuses says what it found, in the thread and under the Page", async ({
  page
}) => {
  await openChat(page);
  await writePageFiles(page, patchThatAdds(pageSource("Revenue overview")));
  await savePage(page);
  await expect(builtPage(page).getByRole("heading", { name: "Revenue overview" })).toBeVisible();

  const broken = overviewRoute("Revenue overview").replace("</h1>", "</h1");
  await writePageFiles(
    page,
    patchThatRewrites("src/routes/index.tsx", overviewRoute("Revenue overview"), broken)
  );
  await savePage(page);

  // The revision that was built stays; the findings stand under it.
  const surface = pageSurface(page);
  await expect(surface).toContainText("Revision 1");
  await expect(builtPage(page).getByRole("heading", { name: "Revenue overview" })).toBeVisible();
  const findings = surface.getByTestId("page-build-errors");
  await expect(findings).toContainText("1 build error");
  // What the viewer is looking at and what to do stands under the count, without unfolding.
  await expect(findings).toContainText(
    "The preview still shows revision 1. Ask the agent to fix the error."
  );
  await findings.getByRole("button", { name: "1 build error" }).click();
  await expect(findings).toContainText("src/routes/index.tsx, line 5");
  await expect(findings).toContainText('Expected ">" but found "}"');
  // The thread says the same on the card of the refused save.
  const refused = page.getByTestId("page-card").filter({ hasText: "The Page could not be built" });
  await expect(refused).toHaveAttribute("data-state", "errors");
  await expect(refused).toContainText("Nothing was saved. Ask the agent to fix the error.");
});

test("a new save opens a closed Page again, and coming back to the conversation opens none", async ({
  page
}) => {
  await openChat(page);
  await writePageFiles(page, patchThatAdds(pageSource("Revenue overview")));
  await savePage(page);
  const surface = pageSurface(page);
  await expect(surface).toContainText("Revision 1");

  // Beside the Page the conversation has the same band and line on top as the Page, up to
  // the seam, so the thread does not show under the agent's name.
  const band = page.locator("header[data-beside-surface]");
  const bandBox = await band.boundingBox();
  const surfaceBox = await surface.boundingBox();
  expect(bandBox?.height).toBe(64);
  expect(Math.round((bandBox?.x ?? 0) + (bandBox?.width ?? 0))).toBe(
    Math.round(surfaceBox?.x ?? -1)
  );
  expect(
    await band.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.borderBottomWidth, style.backgroundImage];
    })
  ).toEqual(["1px", "none"]);
  // The messages hold long strings without a break, the patch and the answer to it. They wrap
  // inside the conversation and none runs under the Page.
  const seam = surfaceBox?.x ?? 0;
  const texts = page.locator(".chat-markdown");
  await expect(texts.first()).toBeVisible();
  expect(
    await texts.evaluateAll(
      (elements, edge) =>
        elements.filter(
          (element) =>
            element.scrollWidth > element.clientWidth ||
            element.getBoundingClientRect().right > edge
        ).length,
      seam
    )
  ).toBe(0);

  await surface.getByRole("button", { name: "Close display panel" }).click();
  await expect(surface).toBeHidden();
  await expect(band).toHaveCount(0);

  // The agent saves again: the Page comes back, on the new revision.
  await writePageFiles(
    page,
    patchThatRewrites(
      "src/routes/index.tsx",
      overviewRoute("Revenue overview"),
      overviewRoute("Revenue this year")
    )
  );
  await savePage(page);
  await expect(surface).toContainText("Revision 2");
  await expect(builtPage(page).getByRole("heading", { name: "Revenue this year" })).toBeVisible();

  // Leaving the conversation and coming back shows its cards and opens nothing.
  const conversation = new URL(page.url()).pathname;
  expect(conversation).toMatch(/\/c\//u);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByTestId("page-card")).toHaveCount(0);
  await expect(surface).toBeHidden();
  // Back through the browser's history. The list cannot say which row is this conversation:
  // the tests of this file share their member and run side by side, every conversation of
  // theirs has the same title, and which one was used last changes while they run.
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe(conversation);
  await expect(page.getByTestId("page-card")).toHaveCount(2);
  await expect(surface).toBeHidden();
  await page.getByTestId("page-card").last().getByRole("button", { name: "Open" }).click();
  await expect(surface).toContainText("Revision 2");
});
