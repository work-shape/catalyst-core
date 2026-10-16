import { randomUUID } from "node:crypto";
import type { FrameLocator } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

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
      await frame
        .locator("body")
        .screenshot({ path: testInfo.outputPath(`font-specimens-${screen}-light.png`) });
    }
    expect(browserRequests.length).toBeGreaterThan(0); // Both CSS paths tried the outside face.
    expect(outsideRequests).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("React CSS kit imports and font URLs render in draft and published Apps", async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: {
      email: "e2e-superadmin@example.test",
      password: "e2e-superadmin-password",
      rememberMe: true
    }
  });
  expect(signedIn.ok()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: `React fonts ${randomUUID()}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = z.object({ id: z.string() }).parse(await created.json()).id;
  const name = `react-font-specimens-${randomUUID().slice(0, 8)}`;
  const appUrl = `${apiOrigin}/api/v1/assets/app/${name}`;
  const saved = await requestWithOrigin(page, "put", appUrl, {
    data: {
      workspaceId,
      expectedRevision: null,
      files: [
        { path: "app.yaml", text: `id: ${name}\nname: React font specimens\nkit: 1.5.0\n` },
        {
          path: "src/routes/__root.tsx",
          text: `import { createRootRoute, Outlet } from "@tanstack/react-router";
export const Route = createRootRoute({ component: () => <Outlet /> });`
        },
        {
          path: "src/routes/index.tsx",
          text: `import { createFileRoute } from "@tanstack/react-router";
import "../fonts.css";
export const Route = createFileRoute("/")({ component: () => <main><h1>React font specimens</h1><p id="kit-font">Bungee · The quick brown fox · äöüß</p><p id="kit-url-font">Kit URL Font · äöüß</p></main> });`
        },
        {
          path: "src/fonts.css",
          text: `@import url("/app-runtime/kit/1.5.0/fonts/fonts.css");
@font-face { font-family: "Kit URL Font"; src: url(/app-runtime/kit/1.5.0/fonts/bungee/bungee-latin-400-normal.woff2) format("woff2"); }
#kit-font { font-family: Bungee; }
#kit-url-font { font-family: "Kit URL Font"; }`
        }
      ]
    },
    timeout: 90_000
  });
  expect(saved.ok(), await saved.text()).toBe(true);
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
    await expect(frame.getByRole("heading", { name: "React font specimens" })).toBeVisible();
    await expect(frame.locator("#kit-font")).toHaveCSS("font-family", "Bungee");
    await expect(frame.locator("#kit-url-font")).toHaveCSS("font-family", '"Kit URL Font"');
    await expectLoadedFonts(frame, ["Bungee", "Kit URL Font"]);
    await frame
      .locator("body")
      .screenshot({ path: testInfo.outputPath(`react-font-specimens-${screen}.png`) });
  }
});
