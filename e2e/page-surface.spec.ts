import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { exitTest as test } from "./exit-fixtures";
import {
  builtPage,
  openChat,
  overviewRoute,
  pageName,
  pageSource,
  pageSurface,
  ownSurfacePageSource,
  patchThatAdds,
  plainPageSource,
  rewritePageFile,
  savePage,
  writePageFiles
} from "./page-surface-fixtures";
import { expect } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// A Page built in chat: the agent writes its files and saves them, and the Page shows beside
// the conversation on the kit the instance serves. The test model runs one tool per message,
// so writing the files and saving them are two messages where an agent takes one turn.

const kitDirectory = "/app-runtime/kit/1.0.0/";
/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;
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
  await rewritePageFile(page, "src/routes/index.tsx", overviewRoute("Revenue this year"));
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

// Felix, 2026-10-12, on a Page an agent built as plain HTML: "I'm seeing it has no padding at
// all". Fails without the stylesheet for a plain Page of kit 1.2.0 and the two lines the build writes into every
// HTML file of a plain Page, also one whose script imports the kit for its data: the body had no
// padding, the heading the size of the text, and nothing in the frame followed the mode.
test("a plain HTML Page has the platform's margin, type and colours, follows dark, and keeps a rule of its own", async ({
  page
}) => {
  const kitFiles: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/app-runtime/kit/")) {
      kitFiles.push(pathname.slice("/app-runtime/kit/".length));
    }
  });
  await openChat(page);
  await writePageFiles(page, patchThatAdds(plainPageSource));
  await savePage(page);
  const built = builtPage(page);
  const heading = built.getByRole("heading", { name: "Margin calculator" });
  await expect(heading).toBeVisible();
  // The Page's own script reached the interface through the kit, beside the theme script.
  await expect(built.getByText("Shown to E2E Pages")).toBeVisible();

  /** What the frame computed for the look of the Page. */
  const look = () =>
    built.locator("body").evaluate((body) => {
      const root = body.ownerDocument.documentElement;
      const styleOf = (selector: string) => {
        const element = body.querySelector(selector);
        if (!element) {
          throw new Error(`The Page has no ${selector}`);
        }
        return getComputedStyle(element);
      };
      const tokens = getComputedStyle(root);
      /** A token of the stylesheet as the browser computes it for a property of an element. */
      const computed = (property: "padding-left" | "font-size" | "color", value: string) => {
        const probe = body.ownerDocument.createElement("span");
        probe.style.setProperty(property, value);
        body.append(probe);
        const result = getComputedStyle(probe).getPropertyValue(property);
        probe.remove();
        return result;
      };
      return {
        dark: root.classList.contains("dark"),
        background: getComputedStyle(body).backgroundColor,
        surface: computed("color", tokens.getPropertyValue("--background")),
        padding: getComputedStyle(body).paddingLeft,
        gutter: computed("padding-left", "var(--layout-gutter)"),
        headingSize: styleOf("h1").fontSize,
        titleSize: computed("font-size", "var(--text-title-lg)"),
        headingMargin: styleOf("h1").marginBottom,
        paragraphMargin: styleOf("p").marginBottom,
        linkColor: styleOf("a").color,
        linkLine: styleOf("a").textDecorationLine,
        textColor: styleOf("p").color,
        buttonBackground: styleOf("button").backgroundColor,
        buttonBorder: styleOf("button").borderTopWidth,
        fieldBorder: styleOf("input").borderTopWidth
      };
    });

  const light = await look();
  // The margin Felix missed, and the platform's type and colours, all from its tokens.
  expect(light.gutter).not.toBe("0px");
  expect(light.padding).toBe(light.gutter);
  expect(light.headingSize).toBe(light.titleSize);
  expect(light.background).toBe(light.surface);
  // A link is the colour of the text around it, and its line says it is one.
  expect([light.linkColor, light.linkLine]).toEqual([light.textColor, "underline"]);
  expect([light.buttonBorder, light.fieldBorder]).toEqual(["1px", "1px"]);
  expect(light.buttonBackground).toBe(light.surface);
  // The Page's own rule wins over the base rule for the same property, and the base rule
  // still holds where the Page set nothing.
  expect(light.headingMargin).toBe("40px");
  expect(light.paragraphMargin).not.toBe("0px");
  // The Page's class names mean what its own rules say. The library has utility classes of
  // the same names, which would lay the first out as a table and hide the second and the last.
  expect(
    await built.locator("#names > div").evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return [
          element.className,
          style.display,
          style.visibility,
          style.maxWidth,
          style.textTransform
        ];
      })
    )
  ).toEqual([
    ["table", "block", "visible", "none", "none"],
    ["collapse", "block", "visible", "none", "none"],
    ["container", "block", "visible", "none", "none"],
    ["hidden", "block", "visible", "none", "uppercase"]
  ]);
  // The chart the Page's script draws with the kit's `drawChart` takes its colours from the
  // tokens of the stylesheet of a plain Page: the labels are drawn in the quiet text colour.
  const chart = () =>
    built.locator("#chart").evaluate((container) => {
      const probe = container.ownerDocument.createElement("span");
      probe.style.color = "var(--muted-foreground)";
      container.append(probe);
      const quiet = getComputedStyle(probe).color;
      probe.remove();
      const labels = [...container.querySelectorAll("svg text")];
      return {
        width: container.querySelector("svg")?.getBoundingClientRect().width ?? 0,
        months: labels.filter((label) => label.textContent === "February").length,
        labelsInQuiet:
          labels.length > 0 && labels.every((label) => getComputedStyle(label).fill === quiet),
        quiet
      };
    });
  await expect.poll(async () => (await chart()).months).toBe(1);
  const lightChart = await chart();
  expect(lightChart.width).toBeGreaterThan(200);
  expect(lightChart.labelsInQuiet).toBe(true);
  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, "plain-page-light.png") });
  }

  // The interface turns dark and the Page follows without a reload.
  await page.getByRole("button", { name: "E2E Pages account" }).click();
  await page.getByRole("menuitem", { name: "Switch to dark theme" }).click();
  await expect.poll(async () => (await look()).dark).toBe(true);
  const dark = await look();
  expect(dark.background).toBe(dark.surface);
  expect(dark.background).not.toBe(light.background);
  expect(dark.linkColor).toBe(dark.textColor);
  expect(dark.linkColor).not.toBe(light.linkColor);
  // A control changes its colours over the library's duration, so its fill is waited for.
  await expect.poll(async () => (await look()).buttonBackground).toBe(dark.surface);
  expect(dark.headingMargin).toBe("40px");
  expect(
    await page
      .locator("main")
      .first()
      .evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = getComputedStyle(element).getPropertyValue("--background");
        element.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      })
  ).toBe(dark.background);
  await expect.poll(async () => (await chart()).labelsInQuiet).toBe(true);
  expect((await chart()).quiet).not.toBe(lightChart.quiet);
  if (shotsDir) {
    await page.screenshot({ path: join(shotsDir, "plain-page-dark.png") });
  }

  // On a phone the Page covers the conversation, keeps the narrow margin and fits its width.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(pageSurface(page)).toHaveAttribute("data-surface-mode", "covering");
  await expect(heading).toBeVisible();
  const narrow = await look();
  expect(narrow.gutter).not.toBe("0px");
  expect(narrow.padding).toBe(narrow.gutter);
  expect(
    await built
      .locator("html")
      .evaluate((root) => root.scrollWidth <= root.clientWidth && root.clientWidth <= 390)
  ).toBe(true);
  if (shotsDir) {
    await page.screenshot({ path: join(shotsDir, "plain-page-dark-390.png") });
  }

  // The stylesheet of a plain Page and the theme script came with the build. The library's
  // stylesheet did not, though the Page's script imports the kit and its charts.
  expect(kitFiles).toEqual(
    expect.arrayContaining(["1.2.0/theme.js", "1.2.0/page.css", "1.2.0/charts.js"])
  );
  expect(kitFiles).not.toContain("1.2.0/ui.css");
});

// Review of kit 1.2.0, measured: a Page that set only `body { background; color }` got, in dark
// mode, the platform's dark fill under the author's dark text, 1.43 to 1 on a field and a
// button, and the platform's light accent and muted colours on the author's white card, about
// 1.97 to 1. Fails without the text colour beside every token fill and without links and quiet
// text taking the colour of the text around them.
test("a plain HTML Page with a surface of its own keeps every plain element readable in light and dark", async ({
  page
}) => {
  await openChat(page);
  await writePageFiles(page, patchThatAdds(ownSurfacePageSource));
  await savePage(page);
  const built = builtPage(page);
  await expect(built.getByRole("heading", { name: "Margin calculator" })).toBeVisible();

  /** The contrast of each element's text against what is painted behind it, by selector. */
  const contrasts = (selectors: string[]) =>
    built.locator("body").evaluate((body, list) => {
      const canvas = body.ownerDocument.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("The frame has no canvas");
      }
      const paint = (color: string) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
      };
      const luminance = () => {
        const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
        const linear = (value: number) => {
          const part = value / 255;
          return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
      };
      return list.map((selector): [string, number] => {
        const element = body.querySelector(selector);
        if (!element) {
          throw new Error(`The Page has no ${selector}`);
        }
        // The fills from the document down to the element, each over the one before.
        const chain: Element[] = [];
        for (let current: Element | null = element; current; current = current.parentElement) {
          chain.unshift(current);
        }
        paint("white");
        for (const ancestor of chain) {
          const style = getComputedStyle(ancestor);
          paint(style.backgroundColor);
          if (style.backgroundImage !== "none") {
            throw new Error(`${selector} stands on an image`);
          }
        }
        const behind = luminance();
        paint(getComputedStyle(element).color);
        const text = luminance();
        const ratio = (Math.max(behind, text) + 0.05) / (Math.min(behind, text) + 0.05);
        return [selector, Math.round(ratio * 100) / 100];
      });
    }, selectors);
  const elements = [
    "h1",
    "p",
    "a",
    "code",
    "small",
    "label",
    "input",
    "select",
    "textarea",
    "button",
    "pre",
    "blockquote",
    // Quiet text inside quiet text, which thinned twice came to 2.78 to 1 on a white card.
    "blockquote small",
    "figcaption small",
    "th",
    "td"
  ];
  const readable = async () => {
    const measured = await contrasts(elements);
    return measured.filter(([, ratio]) => ratio < 4.5);
  };

  expect(await readable()).toEqual([]);

  await page.getByRole("button", { name: "E2E Pages account" }).click();
  await page.getByRole("menuitem", { name: "Switch to dark theme" }).click();
  await expect
    .poll(() => built.locator("html").evaluate((root) => root.classList.contains("dark")))
    .toBe(true);
  // A control changes its colours over the library's duration and is hard to read halfway, so
  // the fill it ends on is waited for before anything is measured.
  await expect
    .poll(() =>
      built.locator("button").evaluate((button) => {
        const probe = button.ownerDocument.createElement("span");
        probe.style.color = "var(--background)";
        button.after(probe);
        const fill = getComputedStyle(probe).color;
        probe.remove();
        return getComputedStyle(button).backgroundColor === fill;
      })
    )
    .toBe(true);
  expect(await readable()).toEqual([]);
  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, "plain-page-own-surface-dark.png") });
    await writeFile(
      join(shotsDir, "plain-page-own-surface-dark.json"),
      JSON.stringify(await contrasts(elements))
    );
  }
});

test("a save the build refuses says what it found, in the thread and under the Page", async ({
  page
}) => {
  await openChat(page);
  await writePageFiles(page, patchThatAdds(pageSource("Revenue overview")));
  await savePage(page);
  await expect(builtPage(page).getByRole("heading", { name: "Revenue overview" })).toBeVisible();

  const broken = overviewRoute("Revenue overview").replace("</h1>", "</h1");
  await rewritePageFile(page, "src/routes/index.tsx", broken);
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
  const refused = page
    .getByTestId("page-card")
    .filter({ hasText: "The preview could not be built" });
  await expect(refused).toHaveAttribute("data-state", "errors");
  await expect(refused).toContainText("Nothing new is shown. Ask the agent to fix the error.");
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
  await rewritePageFile(page, "src/routes/index.tsx", overviewRoute("Revenue this year"));
  await savePage(page);
  await expect(surface).toContainText("Revision 2");
  await expect(builtPage(page).getByRole("heading", { name: "Revenue this year" })).toBeVisible();

  // Leaving the conversation and coming back shows its cards and opens nothing.
  const conversation = new URL(page.url()).pathname;
  expect(conversation).toMatch(/\/c\//u);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
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
