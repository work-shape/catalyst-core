import { z } from "zod";
import { exitTest as test } from "./exit-fixtures";
import {
  builtPage,
  expectShownRevision,
  openChat,
  overviewRoute,
  pageName,
  pageSource,
  pageSurface,
  rewritePageFile,
  savePage,
  viewerPageSource,
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
  await writePageFiles(page, viewerPageSource("Revenue overview"));
  await savePage(page);

  // The save opened the Page beside the conversation, as revision 1.
  const surface = pageSurface(page);
  await expect(surface).toBeVisible();
  await expect(surface).toHaveAccessibleName(pageName);
  await expectShownRevision(surface, 1);
  const built = builtPage(page);
  await expect(built.getByRole("heading", { name: "Revenue overview" })).toBeVisible();
  // Replaces the deleted test of e2e/page-surface.spec.ts (09ba98a28), "a plain HTML Page has
  // the platform's margin, type and colours, follows dark, and keeps a rule of its own": the
  // Page's own script reached the interface through the kit, and `getContext()` settled.
  await expect(built.getByText("Shown to E2E Pages")).toBeVisible();
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
  // Cookies remain inaccessible. The runtime supplies an isolated, temporary storage shim
  // for unsaved Pages, so familiar localStorage reads can render the agent's App.
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
  ).toEqual(["SecurityError", "object"]);
  expect(await frame.evaluate(() => window.localStorage.length)).toBe(0);
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
  await rewritePageFile(page, "src/routes/index.tsx", overviewRoute("Revenue this year"));
  await savePage(page);
  await expectShownRevision(surface, 2);
  await expect(builtPage(page).getByRole("textbox", { name: "Rows as JSON" })).toBeVisible();
  await builtPage(page).getByText("Overview", { exact: true }).click();
  await expect(builtPage(page).getByRole("heading", { name: "Revenue this year" })).toBeVisible();
  // One card per Page folder (APPCARD-1): the earlier save is a line in the run's work.
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-revision", "2");
  await expect(card).toContainText("Shown");

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

  // After a reload the conversation shows its card, and the card opens its revision.
  await page.reload();
  await expect(card).toHaveCount(1);
  await expect(pageSurface(page)).toBeHidden();
  await card.getByRole("button", { name: "Open" }).click();
  await expectShownRevision(pageSurface(page), 2);
  await expect(builtPage(page).getByRole("heading", { name: "Revenue this year" })).toBeVisible();

  // On a phone the Page covers the conversation and closes back to it.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(pageSurface(page)).toHaveAttribute("data-surface-mode", "covering");
  await expect(builtPage(page).getByRole("heading", { name: "Revenue this year" })).toBeVisible();
  await pageSurface(page).getByRole("radio", { name: "Files" }).click();
  await expect(pageSurface(page).getByRole("button", { name: "All files" })).toBeVisible();

  // Replaces the deleted test of e2e/page-surface.spec.ts (09ba98a28), "a Page opened from the
  // dock beside another page is told who looks at it": beside the Agents the dock's surface
  // stands in the interface's page host, so the Page's `getContext()` settles there too.
  await page.setViewportSize({ width: 1280, height: 720 });
  const workspace = /\/w\/([^/]+)\/c\//u.exec(new URL(page.url()).pathname)?.[1];
  expect(workspace).toBeDefined();
  await page.goto(`/w/${workspace}/agents?chat=${conversationId}`);
  const dockCard = page.getByRole("region", { name: "Chat" }).getByTestId("page-card").last();
  await expect(dockCard).toBeVisible();
  await expect(pageSurface(page)).toBeHidden();
  await dockCard.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/agents\?chat=/u);
  await expect(builtPage(page).getByText("Shown to E2E Pages")).toBeVisible();

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
  await writePageFiles(page, pageSource("Revenue overview"));
  await savePage(page);
  await expect(builtPage(page).getByRole("heading", { name: "Revenue overview" })).toBeVisible();

  const broken = overviewRoute("Revenue overview").replace("</h1>", "</h1");
  await rewritePageFile(page, "src/routes/index.tsx", broken);
  await savePage(page);

  // The revision that was built stays; the findings stand under it.
  const surface = pageSurface(page);
  await expectShownRevision(surface, 1);
  await expect(builtPage(page).getByRole("heading", { name: "Revenue overview" })).toBeVisible();
  const findings = surface.getByTestId("page-build-errors");
  await expect(findings).toContainText("1 build error");
  // What the viewer is looking at and what to do stands under the count, without unfolding.
  await expect(findings).toContainText(
    "The preview still shows the last version. Ask the agent to fix the error."
  );
  await findings.getByRole("button", { name: "1 build error" }).click();
  await expect(findings).toContainText("src/routes/index.tsx, line 5");
  await expect(findings).toContainText('Expected ">" but found "}"');
  // The thread says the same on the card of the refused save.
  const refused = page
    .getByTestId("page-card")
    .filter({ hasText: "The preview could not be built" });
  await expect(refused).toHaveAttribute("data-state", "errors");
  await expect(refused).toContainText("Nothing new is shown. Ask the agent to fix the error.");
});
