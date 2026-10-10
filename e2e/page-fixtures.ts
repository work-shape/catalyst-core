import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { expect } from "./test";
import { apiOrigin, signIn, uiOrigin } from "./view-fixtures";

// What the specs about Pages share: how a Page gets into a conversation and into a frame.
//
// No operation stores a Page yet, so the fixture writes what a save writes: the rows of the Page
// and of its one file set, and the files below the root of the instance's `files` store. From
// there on everything is the product: the member asks for the address of the Page and a frame
// on the interface's origin loads it.

const databaseUrl = `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
/** `clientInstance.id` and the root of `infrastructure.objectStorage.files` in the suite's config. */
const clientInstanceId = "demo-e2e";
const filesRoot = resolve(".tmp/e2e/files");

export const pageFrameTitle = "Page under test";

const contentTypes: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml"
};

export interface PageFiles {
  /** Markup placed in the body of `index.html`, before the Page's script. */
  html?: string;
  /** The Page's module script. The policy of a Page runs no inline script, so it is a file. */
  script?: string;
  /** More files of the file set, by path. */
  files?: Record<string, string>;
}

/** The entry file of a Page as a build writes it: one stylesheet, one module script. */
function indexHtml(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./assets/style.css"></head><body><h1 id="page-title">Page</h1>${html}<script type="module" src="./assets/main.js"></script></body></html>`;
}

/**
 * Stores a Page of one revision in a new conversation of the signed-in member and returns the
 * address `pages.preview` gives that member for it.
 */
export async function storePage(
  page: Page,
  headers: Record<string, string>,
  input: PageFiles
): Promise<{ url: string; conversationId: string; pageId: string; fileSetId: string }> {
  const created = await page.request.post(`${apiOrigin}/api/v1/conversations`, {
    headers,
    data: { title: `Page ${randomUUID()}` }
  });
  expect(created.ok()).toBe(true);
  const conversationId = z.object({ id: z.string() }).parse(await created.json()).id;

  const pageId = `page_${randomUUID()}`;
  const fileSetId = `fset_${randomUUID()}`;
  const files: Record<string, string> = {
    "index.html": indexHtml(input.html ?? ""),
    // The mark comes first: a script that is stopped by what it tries has still run.
    "assets/main.js": `document.body.setAttribute("data-ran", "true");\n${input.script ?? ""}\n`,
    "assets/style.css": "#page-title { color: rgb(1, 2, 3); }",
    ...input.files
  };
  const index = [];
  for (const [path, content] of Object.entries(files)) {
    const bytes = Buffer.from(content);
    const target = resolve(filesRoot, "pages", pageId, fileSetId, "dist", ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    index.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      contentType: contentTypes[path.split(".").at(-1) ?? ""] ?? "application/octet-stream"
    });
  }
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      insert into pages (id, client_instance_id, conversation_id, name, created_at)
      values (${pageId}, ${clientInstanceId}, ${conversationId}, 'Page', now())
    `;
    await sql`
      insert into file_sets (
        id, client_instance_id, owner_kind, owner_id, number, kit_version, manifest,
        source_files, built_files, source_file_count, built_file_count, total_bytes, created_at
      ) values (
        ${fileSetId}, ${clientInstanceId}, 'page', ${pageId}, 1, '1.0.0',
        ${sql.json({ entry: "index.html" })}, ${sql.json([])}, ${sql.json(index)}, 0,
        ${index.length}, ${index.reduce((total, file) => total + file.bytes, 0)}, now()
      )
    `;
  } finally {
    await sql.end();
  }

  const preview = await page.request.post(
    `${apiOrigin}/api/v1/conversations/${encodeURIComponent(conversationId)}/pages/${pageId}/preview`,
    { headers, data: {} }
  );
  expect(preview.ok()).toBe(true);
  const { url } = z.object({ url: z.string() }).parse(await preview.json());
  return { url: `${apiOrigin}${url}`, conversationId, pageId, fileSetId };
}

/**
 * Signs the member in, stores the Page and shows it in a frame on the interface's origin. The
 * frame has no sandbox attribute and no policy of its own: whatever holds the Page in is what
 * the instance answers with. Returns the frame of the Page itself, inside the shell.
 */
export async function openPage(page: Page, input: PageFiles): Promise<FrameLocator> {
  const headers = await signIn(page, uiOrigin);
  const stored = await storePage(page, headers, input);
  await page.goto(`${uiOrigin}/`);
  await page.evaluate(
    ({ address, title }) => {
      const frame = document.createElement("iframe");
      frame.title = title;
      frame.src = address;
      frame.style.cssText =
        "position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:2147483647;background:white";
      document.body.appendChild(frame);
    },
    { address: stored.url, title: pageFrameTitle }
  );
  return pageFrame(page);
}

/**
 * The Page's own script ran, so whatever a test planted in it was tried. Not for a Page that
 * tried to move its frame: the browser shows its own page in a frame it refused to move.
 */
export async function expectPageRan(page: Page): Promise<void> {
  await expect(pageFrame(page).locator("body")).toHaveAttribute("data-ran", "true");
}

/** The frame of the Page: the one frame inside the shell the instance answered with. */
export function pageFrame(page: Page): FrameLocator {
  return page.frameLocator(`iframe[title="${pageFrameTitle}"]`).frameLocator("iframe");
}
