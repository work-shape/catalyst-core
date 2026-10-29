import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "./test";
import { apiOrigin, signIn, uiOrigin } from "./view-fixtures";

// A chat embedded in another site acts with the host's session token, which the server does not
// take for the person in their own session. It tells the interface so on the read of the
// person (`embedded`), and the chat leaves out what the server refuses it: "Always allow" on a
// confirmation card above all. The person's own browser session is told nothing of this.

const serverCredential = process.env.E2E_SERVER_CREDENTIAL ?? "e2e-server-to-server-credential";
const shotsDir = process.env.E2E_SHOTS_DIR;
const TOOL = "e2e.confirm_reversible";

// The interface in German, as the browser asks for it.
test.use({
  locale: "de-DE"
});

const meSchema = z.object({ id: z.string(), embedded: z.literal(true).optional() });

/** A token the host's backend issues for one of its people. */
async function issueToken(request: Page["request"]): Promise<string> {
  const issued = await request.post(`${apiOrigin}/api/v1/instance/session-tokens`, {
    headers: { "x-server-credential": serverCredential },
    data: {
      externalUserId: `embedded-${randomUUID()}`,
      displayLabel: "Embedded Visitor",
      roles: ["user"],
      permissionRefs: ["demo-tools"]
    }
  });
  expect(issued.ok()).toBe(true);
  return z.object({ chatSessionToken: z.string() }).parse(await issued.json()).chatSessionToken;
}

test("the read of the person tells an embedding host's session, and not their own", async ({
  page,
  request
}) => {
  const token = await issueToken(request);
  const embedded = await request.get(`${apiOrigin}/api/v1/me`, {
    headers: { authorization: `Bearer ${token}` }
  });
  expect(embedded.ok()).toBe(true);
  expect(meSchema.parse(await embedded.json()).embedded).toBe(true);

  const headers = await signIn(page, uiOrigin);
  const own = await page.request.get(`${apiOrigin}/api/v1/me`, { headers });
  expect(own.ok()).toBe(true);
  expect(meSchema.parse(await own.json())).not.toHaveProperty("embedded");
});

for (const width of [390, 1280]) {
  test(`an embedded chat offers a confirmation without Always allow at ${width}`, async ({
    page,
    context,
    request
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const siteUrl = new URL(uiOrigin);
    siteUrl.hostname = siteUrl.hostname === "localhost" ? "127.0.0.1" : "localhost";
    const siteOrigin = siteUrl.origin;
    const token = await issueToken(request);
    const created = await request.post(`${apiOrigin}/api/v1/conversations`, {
      headers: { authorization: `Bearer ${token}` },
      data: { title: `Embedded ${randomUUID()}` }
    });
    expect(created.ok()).toBe(true);
    const conversation = z
      .object({ id: z.string(), collaborationWorkspaceId: z.string() })
      .parse(await created.json());

    const sitePage = await (await request.get(`${uiOrigin}/e2e-widget.html`)).text();
    const embedding = sitePage.replace(
      "</body>",
      `<script type="module">
            window.mountChatWidget({
              container: document.getElementById("root"),
              apiBaseUrl: ${JSON.stringify(apiOrigin)},
              token: ${JSON.stringify(token)},
              route: ${JSON.stringify({
                kind: "conversation",
                collaborationWorkspaceId: conversation.collaborationWorkspaceId,
                conversationId: conversation.id
              })}
            });
          </script></body>`
    );
    // The development server's reload channel is not part of the page.
    await context.routeWebSocket(/.*/u, () => undefined);
    // A page the test answers itself has no network address, so the browser takes it for a
    // public one and asks before it may call this machine. A deployed instance has no such step.
    await context.grantPermissions(["local-network-access"]);
    // The site is bundled with the widget: its files are the interface's, its page is its own.
    await context.route(`${siteOrigin}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/another-site") {
        await route.fulfill({ contentType: "text/html", body: embedding });
        return;
      }
      await route.fulfill({
        response: await route.fetch({ url: `${uiOrigin}${url.pathname}${url.search}` })
      });
    });
    await page.goto(`${siteOrigin}/another-site`);

    await page
      .getByPlaceholder("Nachricht")
      .fill(`/tool ${TOOL} ${JSON.stringify({ text: "Notiz" })}`);
    await page.getByRole("button", { name: "Nachricht senden" }).click();

    const card = page.getByTestId("tool-decision-card");
    await expect(card).toBeVisible();
    // The card asks for no run of governance: its buttons are there at once, with no console error.
    await expect(card.getByRole("button", { name: "Erlauben", exact: true })).toBeEnabled();
    await expect(card.getByRole("button", { name: "Ablehnen", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Immer erlauben" })).toHaveCount(0);
    await expect(card).not.toContainText("Immer erlauben");
    await expect(page.getByRole("link", { name: /Problem an Workshape melden/u })).toHaveCount(0);
    if (shotsDir) {
      await mkdir(shotsDir, { recursive: true });
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(shotsDir, `embedded-chat-de-${width}.png`) });
    }
    await card.getByRole("button", { name: "Ablehnen", exact: true }).click();
    await expect(card).toHaveCount(0);
  });
}
