import { randomUUID } from "node:crypto";
import type { FrameLocator, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

const admin = { email: "e2e-apps@example.test", password: "e2e-apps-password" };

const member = { email: "e2e-apps-member@example.test", password: "e2e-apps-member-password" };

async function signIn(page: Page, person: typeof admin) {
  const response = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  expect((await page.request.get(`${apiOrigin}/api/v1/me`)).ok()).toBe(true);
}

async function saveApp(page: Page, source: string, script: string, kit = "1.6.0") {
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: `Sandbox ${randomUUID()}` }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = z.object({ id: z.string() }).parse(await created.json()).id;
  const name = `sandbox-${randomUUID().slice(0, 8)}`;
  const url = `${apiOrigin}/api/v1/assets/app/${name}`;
  const saved = await requestWithOrigin(page, "put", url, {
    data: {
      workspaceId,
      expectedRevision: null,
      files: [
        {
          path: "app.yaml",
          text: `id: ${name}\nname: Leave requests\nkit: ${kit}\nentry: index.html\n`
        },
        {
          path: "index.html",
          text: `<!doctype html><title>Leave requests</title>${source}<script type="module" src="./main.js"></script>`
        },
        { path: "main.js", text: script }
      ]
    },
    timeout: 90_000
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  return { workspaceId, name, url, path: `/w/${workspaceId}/app-drafts/${name}` };
}

function appFrame(page: Page): FrameLocator {
  return page.getByTestId("page-preview-frame").contentFrame().frameLocator("iframe");
}

test("agent-style localStorage renders, survives reloads and stays private to the person and App", async ({
  page,
  browser,
  baseURL,
  pageErrors
}, testInfo) => {
  test.setTimeout(180_000);
  await signIn(page, admin);
  const app = await saveApp(
    page,
    '<h1>Leave requests</h1><p id="saved"></p><output id="burst"></output><button id="save">Keep date</button><button id="kit">Save with kit</button><output id="kit-result"></output>',
    `import { storage } from "@work-shape/catalyst-app-kit";
// The pattern agents and customers write: reading storage at module evaluation must not throw.
const current = window.localStorage.getItem("leave-date") || "No date";
document.querySelector("#saved").textContent = current;
document.querySelector("#burst").textContent = localStorage.getItem("burst") || "";
document.querySelector("#save").addEventListener("click", () => { for (let index = 0; index < 100; index++) { if (index % 2 === 0) localStorage.setItem("burst", String(index)); else localStorage.setItem("leave-date", index === 99 ? "2026-11-01" : String(index)); } document.querySelector("#saved").textContent = "2026-11-01"; });
document.querySelector("#kit").addEventListener("click", async () => { await storage.set("filters", { status: "open" }); document.querySelector("#kit-result").textContent = JSON.stringify(await storage.get("filters")); });`
  );
  const otherContext = await browser.newContext({ baseURL });
  await pageErrors.watch(otherContext);
  const otherPage = await otherContext.newPage();
  try {
    await signIn(otherPage, member);
    const joined = await requestWithOrigin(
      page,
      "post",
      `${apiOrigin}/api/v1/workspaces/${app.workspaceId}/members`,
      { data: { email: member.email } }
    );
    expect(joined.ok()).toBe(true);
    const published = await requestWithOrigin(page, "post", `${app.url}/publish`, {
      data: { workspaceId: app.workspaceId, revision: 1, audience: "workspace" }
    });
    expect(published.ok(), await published.text()).toBe(true);
    const publishedPath = `/w/${app.workspaceId}/apps/${app.name}`;
    await page.goto(publishedPath);
    await expect(appFrame(page).locator("#saved")).toHaveText("No date");
    // A persistence response, not a sleep or the optimistic DOM change, is the reload barrier.
    const kept = page.waitForResponse(
      (response) =>
        response.url().endsWith("/storage") &&
        response.request().method() === "POST" &&
        response.status() === 200
    );
    await appFrame(page).getByRole("button", { name: "Keep date" }).click();
    const saved = await kept;
    expect(saved.request().postDataJSON()).toMatchObject({
      mutation: { type: "batch", clear: false, values: { burst: "98", "leave-date": "2026-11-01" } }
    });
    expect(saved.headers()["operation-run-id"]).toBeTruthy();
    await page.reload();
    await expect(appFrame(page).locator("#saved")).toHaveText("2026-11-01");
    await expect(appFrame(page).locator("#burst")).toHaveText("98");
    await appFrame(page).getByRole("button", { name: "Save with kit" }).click();
    await expect(appFrame(page).locator("#kit-result")).toHaveText('{"status":"open"}');
    if (process.env.E2E_SHOTS_DIR) {
      await page.screenshot({ path: testInfo.outputPath("accept-fix-2-storage.png") });
    }
    await otherPage.goto(publishedPath);
    await expect(appFrame(otherPage).locator("#saved")).toHaveText("No date");
    // A new browser session of the same person reads the server snapshot, too.
    const samePerson = await browser.newContext({ baseURL });
    try {
      await pageErrors.watch(samePerson);
      const samePage = await samePerson.newPage();
      await signIn(samePage, admin);
      await samePage.goto(publishedPath);
      await expect(appFrame(samePage).locator("#saved")).toHaveText("2026-11-01");
    } finally {
      await samePerson.close();
    }
    const second = await saveApp(
      page,
      '<p id="saved"></p>',
      'document.querySelector("#saved").textContent = localStorage.getItem("leave-date") || "No date";',
      "1.1.0"
    );
    await page.goto(second.path);
    await expect(appFrame(page).locator("#saved")).toHaveText("No date");
  } finally {
    await otherContext.close();
  }
});

// The messages this spec's tests cause on purpose (see allowed-page-errors.ts).
test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "outside-app-font-refused",
        reason:
          "The font spec deliberately names Google Fonts and proves CSP prevents a network request.",
        matches:
          /^Loading the font 'https:\/\/fonts\.googleapis\.com\/blocked\.woff2' violates the following Content Security Policy directive: "font-src 'self' data:"\. The action has been blocked\.\s*$/u,
        tests: [
          "folder, kit and data fonts render in draft and published Apps without outside requests"
        ]
      }
    ]
  }
});

const TITLE =
  "folder, kit and data fonts render in draft and published Apps without outside requests";

const kitRoot = `${apiOrigin}/app-runtime/kit/1.5.0`;

// CSS font-family alone proves nothing: document.fonts.load must return an actual loaded face.
async function expectLoadedFonts(frame: FrameLocator, families: string[]): Promise<void> {
  const loaded = await frame.locator("body").evaluate(async (_, names) => {
    return Promise.all(
      names.map(async (family) => {
        const faces = await document.fonts.load(`32px "${family}"`, "Hamburgefonts äöüß");
        return {
          family,
          loaded: faces.length > 0 && faces.every((face) => face.status === "loaded")
        };
      })
    );
  }, families);
  expect(loaded).toEqual(families.map((family) => ({ family, loaded: true })));
}

async function expectFonts(frame: FrameLocator): Promise<void> {
  await expect(frame.getByRole("heading", { name: "Font specimens" })).toBeVisible();
  await expectLoadedFonts(frame, [
    "Folder Font",
    "Inter",
    "Lora",
    "IBM Plex Mono",
    "Bungee",
    "Data Font"
  ]);
  await expect(frame.locator("#chart svg")).toBeVisible();
  await expect(frame.locator("#chart")).toContainText("A");
  expect(
    await frame.locator("body").evaluate(async () => {
      try {
        await document.fonts.load('32px "Outside Font"');
        return "loaded";
      } catch {
        return "blocked";
      }
    })
  ).toBe("blocked");
}

test(TITLE, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: {
      email: "e2e-superadmin@example.test",
      password: "e2e-superadmin-password",
      rememberMe: true
    }
  });
  expect(signedIn.ok()).toBe(true);
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("vivd-catalyst:theme", "light"));
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: `Fonts ${randomUUID()}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = z.object({ id: z.string() }).parse(await created.json()).id;
  const name = `font-specimens-${randomUUID().slice(0, 8)}`;
  const appUrl = `${apiOrigin}/api/v1/assets/app/${name}`;
  const fontResponse = await page.request.get(
    `${kitRoot}/fonts/bungee/bungee-latin-400-normal.woff2`
  );
  expect(fontResponse.ok()).toBe(true);
  const font = await fontResponse.body();
  // Carry the kit's existing chart library in the App's folder, with its licence comments.
  const chartResponse = await page.request.get(`${kitRoot}/charts.js`);
  expect(chartResponse.ok()).toBe(true);
  const chart = await chartResponse.text();
  const saved = await requestWithOrigin(page, "put", appUrl, {
    data: {
      workspaceId,
      expectedRevision: null,
      files: [
        {
          path: "app.yaml",
          text: `id: ${name}\nname: Font specimens\nkit: 1.5.0\nentry: index.html\n`
        },
        {
          path: "index.html",
          text: `<!doctype html><html><head><link rel="stylesheet" href="/app-runtime/kit/1.5.0/fonts/fonts.css"><link rel="stylesheet" href="./fonts.css"></head><body><h1>Font specimens</h1><p style="font-family:'Folder Font'">Folder Font · Bungee · äöüß</p><p style="font-family:Inter">Inter · The quick brown fox</p><p style="font-family:Lora">Lora · The quick brown fox</p><p style="font-family:'IBM Plex Mono'">IBM Plex Mono · 0123456789</p><p style="font-family:Bungee">Bungee · A display face</p><p style="font-family:'Data Font'">Data Font · inlined WOFF2</p><p style="font-family:'Outside Font'">Outside font falls back</p><div id="chart" style="width:320px;height:200px"></div><script type="module" src="./draw.js"></script></body></html>`
        },
        {
          path: "fonts.css",
          text: `@font-face { font-family: 'Folder Font'; src: url('./folder.woff2') format('woff2'); }\n@font-face { font-family: 'Data Font'; src: url('data:font/woff2;base64,${font.toString("base64")}') format('woff2'); }\n@font-face { font-family: 'Outside Font'; src: url('https://fonts.googleapis.com/blocked.woff2') format('woff2'); }\nbody { font-size: 24px; }`
        },
        { path: "folder.woff2", base64: font.toString("base64") },
        { path: "chart.js", text: chart },
        {
          path: "draw.js",
          text: `import { drawChart } from './chart.js'; drawChart(document.querySelector('#chart'), { type: 'bar', categories: ['A','B'], series: [{ label: 'Revenue', values: [2,5] }], stacked: false, formatValue: String }, { series: ['#336699'], text: '#222222', line: '#cccccc', surface: '#ffffff', tooltipSurface: '#ffffff', tooltipText: '#222222', fontFamily: 'Inter', fontSize: 14 });`
        }
      ]
    },
    timeout: 90_000
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  // The network route sees only requests that actually leave CSP; the request event also
  // reports blocked attempts. Catch any egress before it leaves the test machine.
  const outsideRequests: string[] = [];
  const browserRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "fonts.googleapis.com")
      browserRequests.push(request.url());
  });
  await page.route("https://fonts.googleapis.com/**", async (route) => {
    outsideRequests.push(route.request().url());
    await route.abort();
  });
  try {
    for (const screen of ["app-edit", "app-view"] as const) {
      if (screen === "app-view") {
        const published = await requestWithOrigin(page, "post", `${appUrl}/publish`, {
          data: { workspaceId, revision: 1 }
        });
        expect(published.ok(), await published.text()).toBe(true);
      }
      await page.goto(`/w/${workspaceId}/${screen === "app-edit" ? "app-drafts" : "apps"}/${name}`);
      const frame = page
        .getByTestId(screen)
        .getByTestId("page-preview-frame")
        .contentFrame()
        .frameLocator("iframe");
      await expectFonts(frame);
      // Keep the two requested light-mode specimens in the hosted test artifact.
      if (process.env.E2E_SHOTS_DIR) {
        await frame
          .locator("body")
          .screenshot({ path: testInfo.outputPath(`evidence-font-specimens-${screen}-light.png`) });
      }
    }
    expect(browserRequests.length).toBeGreaterThan(0); // Both CSS paths tried the outside face.
    expect(outsideRequests).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
