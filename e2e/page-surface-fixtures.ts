import type { FrameLocator, Locator, Page } from "@playwright/test";
import { expect } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// What the specs about a Page beside the conversation share: the member who builds Pages, the
// messages the test model reads as tool calls, and the source of the Page they build.

/** The member of these specs, from `tests/fixtures/e2e-users/page-surface.yaml`. */
const pageBuilder = {
  email: "e2e-pages@example.test",
  password: "e2e-pages-password"
};

/** The folder of the Execution Workspace the Page is written to. */
const pageFolder = "revenue";
/** What the preview is called: the name its manifest gives it, not the folder it opens. */
export const pageName = "Revenue";

const rootRoute = `import { createRootRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: () => (
    <main className="flex flex-col gap-4 p-4">
      <nav className="flex gap-4">
        <Link to="/">Overview</Link>
        <Link to="/data">Data</Link>
      </nav>
      <Outlet />
    </main>
  )
});
`;

export const overviewRoute = (
  heading: string
) => `import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => <h1>${heading}</h1>
});
`;

/** A route that reads rows from pasted JSON and shows them as a table and as a chart. */
const dataRoute = `import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Chart,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea
} from "@work-shape/catalyst-app-kit";

interface Row {
  month: string;
  revenue: number;
}

function readRows(text: string): Row[] {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function Data() {
  const [text, setText] = useState("");
  const rows = readRows(text);
  return (
    <section className="flex flex-col gap-4">
      <Textarea
        aria-label="Rows as JSON"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {rows.length === 0 ? (
        <p>Paste rows to see them.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.month}>
                  <TableCell>{row.month}</TableCell>
                  <TableCell>{row.revenue}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Chart
            type="bar"
            rows={rows}
            x="month"
            series={[{ field: "revenue", label: "Revenue" }]}
            locale="en"
            ariaLabel="Revenue by month"
            emptyLabel="No rows"
          />
        </>
      )}
    </section>
  );
}

export const Route = createFileRoute("/data")({ component: Data });
`;

/** The Page with its two routes, by path inside its folder. */
export const pageSource = (heading: string): Record<string, string> => ({
  "app.yaml": "id: revenue\nname: Revenue\nkit: 1.0.0\n",
  "src/routes/__root.tsx": rootRoute,
  "src/routes/index.tsx": overviewRoute(heading),
  "src/routes/data.tsx": dataRoute
});

/**
 * A Page as plain HTML that sets one rule of its own, on the heading's margin, and leaves
 * everything else about its look to the platform. Four of its class names are also names of
 * utility classes of the library, and its only rule for one of them changes the letters. Its
 * script imports the kit the way a Page that reads data does and draws a chart with the kit's
 * `drawChart`, and shows nothing by a component.
 */
export const plainPageSource: Record<string, string> = {
  "app.yaml": "id: revenue\nname: Revenue\nkit: 1.2.0\nentry: index.html\n",
  "index.html": `<!doctype html>
<html>
  <head>
    <title>Margin calculator</title>
    <style>
      h1 { margin-bottom: 40px; }
      .hidden { text-transform: uppercase; }
    </style>
  </head>
  <body>
    <h1>Margin calculator</h1>
    <p>Price and cost give the <a href="#margin">margin</a>.</p>
    <label for="price">Price</label>
    <input id="price" value="120">
    <button id="calculate">Calculate</button>
    <p id="viewer"></p>
    <div id="names">
      <div class="table">Rows</div>
      <div class="collapse">Details</div>
      <div class="container">Frame</div>
      <div class="hidden">Later</div>
    </div>
    <table>
      <thead><tr><th>Month</th><th>Margin</th></tr></thead>
      <tbody><tr><td>January</td><td>32 %</td></tr><tr><td>February</td><td>35 %</td></tr></tbody>
    </table>
    <div id="chart" style="height: 200px"></div>
    <script type="module">
      import { getContext } from "@work-shape/catalyst-app-kit";
      import { drawChart } from "@work-shape/catalyst-app-kit/charts";
      const context = await getContext();
      document.getElementById("viewer").textContent = "Shown to " + context.viewer.displayName;

      const container = document.getElementById("chart");
      const spec = {
        type: "bar",
        categories: ["January", "February", "March"],
        series: [{ label: "Margin", values: [32, 35, 31] }],
        stacked: false,
        formatValue: (value) => value + " %"
      };
      const palette = () => {
        const probe = document.createElement("span");
        container.append(probe);
        const token = (name) => {
          probe.style.color = "var(" + name + ")";
          return getComputedStyle(probe).color;
        };
        const text = getComputedStyle(container);
        const colours = {
          series: [token("--chart-1"), token("--chart-2")],
          text: token("--muted-foreground"),
          line: token("--border"),
          surface: token("--background"),
          tooltipSurface: token("--popover"),
          tooltipText: token("--popover-foreground"),
          fontFamily: text.fontFamily,
          fontSize: Number.parseFloat(text.fontSize)
        };
        probe.remove();
        return colours;
      };
      const chart = drawChart(container, spec, palette());
      // A drawn chart keeps its size, so the Page fits it to its element again.
      new ResizeObserver(() => chart.resize()).observe(container);
      new MutationObserver(() => chart.update(spec, palette())).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"]
      });
    </script>
  </body>
</html>
`
};

/**
 * The plain Page of an author who chose a light surface and dark text and nothing else: a grey
 * body, a white card, and every plain element the platform gives a look to.
 */
export const ownSurfacePageSource: Record<string, string> = {
  "app.yaml": plainPageSource["app.yaml"] ?? "",
  "index.html": `<!doctype html>
<html>
  <head>
    <title>Margin calculator</title>
    <style>
      body { background: #f5f5f5; color: #333; }
      .card { background: #fff; }
    </style>
  </head>
  <body>
    <h1>Margin calculator</h1>
    <div class="card">
      <p>Price and cost give the <a href="#margin">margin</a>, as <code>price - cost</code>.</p>
      <small>Figures of this year</small>
      <label for="price">Price</label>
      <input id="price" value="120">
      <select aria-label="Month"><option>January</option></select>
      <textarea aria-label="Note">A note</textarea>
      <button id="calculate">Calculate</button>
      <pre>margin = price - cost</pre>
      <blockquote>Quoted from the plan <small>and its footnote</small></blockquote>
      <figure><figcaption>Margin by month, <small>in percent</small></figcaption></figure>
      <table>
        <thead><tr><th>Month</th><th>Margin</th></tr></thead>
        <tbody><tr><td>January</td><td>32 %</td></tr></tbody>
      </table>
    </div>
  </body>
</html>
`
};

/** Signs the member in and opens the interface, in English or German. */
export async function openChat(page: Page, locale: "en" | "de" = "en"): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...pageBuilder, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.addInitScript((chosen) => {
    // The script runs in every frame, and the frame of a Page has no storage.
    if (window.top === window) {
      window.localStorage.setItem("vivd-catalyst:locale", chosen);
    }
  }, locale);
  await page.goto("/");
}

/**
 * Sends one message and waits for the run it starts to end. The test model reads a message
 * that starts with `/tool` as one call of that tool, and answers every finished call with one
 * more message, so the number of those answers says how many runs have ended.
 */
export async function sendToolCall(page: Page, tool: string, input: unknown): Promise<void> {
  const answers = page.getByText(/^Tool work completed:/u);
  const before = await answers.count();
  const composer = page.getByPlaceholder(/^(?:Message|Nachricht)$/u);
  await composer.fill(`/tool ${tool} ${JSON.stringify(input)}`);
  // The button is there once the run before has ended.
  await page.getByRole("button", { name: /^(?:Send message|Nachricht senden)$/u }).click();
  await expect(answers).toHaveCount(before + 1);
}

/** Lets the agent write files of the Page. */
export async function writePageFiles(page: Page, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await rewritePageFile(page, path, content);
  }
}

/** Lets the agent give one file of the Page's folder another text. */
export async function rewritePageFile(page: Page, path: string, content: string): Promise<void> {
  await sendToolCall(page, "workspace.write_file", { path: `${pageFolder}/${path}`, content });
}

/** Lets the agent open the Page's folder in the preview, which builds a revision of it. */
export async function savePage(page: Page): Promise<void> {
  await sendToolCall(page, "workspace.open", { path: pageFolder });
}

/** The surface of the Page beside the conversation. */
export function pageSurface(page: Page): Locator {
  return page.locator('aside[data-surface-kind="page"]');
}

/**
 * Waits until the preview shows revision `number`. No member reads the number: the preview
 * names it on its frame for tests alone.
 */
export async function expectShownRevision(surface: Locator, number: number): Promise<void> {
  await expect(surface.locator("[data-page-view]")).toHaveAttribute(
    "data-revision",
    String(number)
  );
}

/** The Page itself: the one frame inside the shell the instance answers with. */
export function builtPage(page: Page): FrameLocator {
  return pageSurface(page).getByTestId("page-preview-frame").contentFrame().frameLocator("iframe");
}
