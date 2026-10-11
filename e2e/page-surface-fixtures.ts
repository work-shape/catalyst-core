import type { FrameLocator, Locator, Page } from "@playwright/test";
import { expect } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// What the specs about a Page beside the conversation share: the member who builds Pages, the
// messages the test model reads as tool calls, and the source of the Page they build.

/** The member of these specs, from `tests/fixtures/e2e-app.yaml`. */
const pageBuilder = {
  email: "e2e-pages@example.test",
  password: "e2e-pages-password"
};

export const pageName = "Revenue";
/** The folder of the Execution Workspace the Page is written to. */
const pageFolder = "revenue";

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

const linesOf = (text: string) => text.replace(/\n$/u, "").split("\n");

/** A patch that writes new files into the Page's folder. */
export function patchThatAdds(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([path, text]) => {
      const lines = linesOf(text);
      return [
        "--- /dev/null",
        `+++ b/${pageFolder}/${path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`)
      ].join("\n");
    })
    .join("\n");
}

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
export async function writePageFiles(page: Page, patch: string): Promise<void> {
  await sendToolCall(page, "workspace.apply_patch", { patch });
}

/** Lets the agent give one file of the Page's folder another text. */
export async function rewritePageFile(page: Page, path: string, content: string): Promise<void> {
  await sendToolCall(page, "workspace.write_file", { path: `${pageFolder}/${path}`, content });
}

/** Lets the agent save the Page's folder as a revision. */
export async function savePage(page: Page): Promise<void> {
  await sendToolCall(page, "page.save", { name: pageName, directory: pageFolder });
}

/** The surface of the Page beside the conversation. */
export function pageSurface(page: Page): Locator {
  return page.locator('aside[data-surface-kind="page"]');
}

/** The Page itself: the one frame inside the shell the instance answers with. */
export function builtPage(page: Page): FrameLocator {
  return pageSurface(page).getByTestId("page-preview-frame").contentFrame().frameLocator("iframe");
}
