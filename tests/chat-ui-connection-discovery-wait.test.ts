// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { BuildAsset } from "@work-shape/catalyst-chat-ui/build-area";
import { platformContext } from "./chat-ui-build-fixtures";
import { mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { connectionAsset, connectionDetail } from "./chat-ui-connection-fixtures";
import { settingsUser } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS } from "./support/assertions";

// The Discovered tools section of a Connection's page waits only for a discovery that was asked
// for, and stops at a failure written after it asked. Where nobody is signed in whose sign-in
// reads the tools, it says so at once and leads to the page's sign-in.

const WAIT = { timeout: CONDITION_WAIT_MS };
const WAITING = "Reading the tools of the server.";

afterEach(async () => {
  await unmountBuildPages();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/**
 * The page of a Connection made on the instance, read by an admin who may change it. `detail`
 * is read at every `connections.get`; `mine` answers the reader's own sign-ins.
 */
async function openPage(
  asset: BuildAsset,
  detail: () => Partial<ConnectionDetail>,
  mine: { name: string; state: string }[] = [],
  opened: (page: HTMLElement) => Element | null = section
) {
  const calls: string[] = [];
  const detailPath = apiOperations["connections.get"].path.replace(":name", asset.name);
  const discoverPath = apiOperations["connections.discover"].path.replace(":name", asset.name);
  const page = await mountBuildPage(
    asset,
    "connections",
    (request, url) => {
      if (url.pathname === apiOperations["platform.context.get"].path) {
        return Response.json(platformContext([], ["connection.write"]));
      }
      if (request.method === "GET" && url.pathname === detailPath) {
        return Response.json(connectionDetail(asset.name, detail()));
      }
      if (request.method === "POST" && url.pathname === discoverPath) {
        calls.push("connections.discover");
        return Response.json({ status: "queued" });
      }
      if (url.pathname === apiOperations["connections.mine"].path) {
        return Response.json({
          connections: mine.map((row) => ({ ...row, title: "Mail" })),
          ownServers: { mayAdd: false, entries: [] }
        });
      }
      return undefined;
    },
    [],
    { user: settingsUser({ roles: ["user", "admin"] }) }
  );
  await vi.waitFor(() => expect(opened(page)).not.toBeNull(), WAIT);
  return { page, calls };
}

function section(page: HTMLElement) {
  return page.querySelector<HTMLElement>("section#discovered, #discovered");
}

function discoverButton(page: HTMLElement) {
  return [...(section(page)?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Read tools again"
  );
}

const OAUTH = { registration: "dcr" as const, providerHost: "login.example.test" };

describe("The tools of a Connection nobody is signed in to", () => {
  it("say at once that the reader's own sign-in is missing on a personal Connection", async () => {
    // As found on staging: a personal Connection with no sign-in for anyone. The instance
    // reads none of its tools, and wrote why.
    const asset = connectionAsset("mail", {
      origin: "runtime",
      authScheme: "oauth",
      credentialMode: "user",
      ownerPrincipalId: "user_admin"
    });
    const { page } = await openPage(
      asset,
      () => ({
        health: "needs_configuration",
        lastErrorCode: "oauth_required",
        recordedAt: "2026-11-16T08:00:00.000Z",
        sharedCredential: false,
        operations: [],
        oauth: OAUTH
      }),
      [{ name: "mail", state: "not_connected" }]
    );
    await vi.waitFor(
      () => expect(page.querySelector('[data-connection-discovered-sign-in="own"]')).not.toBeNull(),
      WAIT
    );
    expect(section(page)?.textContent).not.toContain(WAITING);
    expect(discoverButton(page)?.disabled).toBe(true);
    // The hint leads to the sign-in the page offers.
    expect(page.querySelector("#sign-in")).not.toBeNull();
  });

  it("say at once that nobody is signed in to a shared Connection", async () => {
    const asset = connectionAsset("crm", { origin: "runtime", authScheme: "oauth" });
    const { page } = await openPage(asset, () => ({
      health: "needs_configuration",
      recordedAt: "2026-11-16T08:00:00.000Z",
      operations: [],
      oauth: OAUTH
    }));
    await vi.waitFor(
      () =>
        expect(page.querySelector('[data-connection-discovered-sign-in="shared"]')).not.toBeNull(),
      WAIT
    );
    expect(section(page)?.textContent).not.toContain(WAITING);
  });
});

describe("Reading the tools again", () => {
  it("waits for the discovery it asked for and stops at the failure written after it", async () => {
    const asset = connectionAsset("crm", { origin: "runtime" });
    let recordedAt = "2026-11-16T08:00:00.000Z";
    const { page, calls } = await openPage(asset, () => ({
      health: "failed",
      lastErrorCode: "upstream_unauthorized",
      recordedAt,
      operations: []
    }));
    // The failure is older than the page: it opens without waiting.
    await vi.waitFor(
      () => expect(section(page)?.textContent).toContain("The tools could not be read."),
      WAIT
    );
    expect(section(page)?.textContent).not.toContain(WAITING);
    await act(async () => discoverButton(page)?.click());
    await vi.waitFor(() => expect(calls).toEqual(["connections.discover"]), WAIT);
    await vi.waitFor(() => expect(section(page)?.textContent).toContain(WAITING), WAIT);
    // The discovery failed: the instance wrote the state anew, with the same reason.
    recordedAt = "2026-11-16T08:00:07.000Z";
    await vi.waitFor(
      () => expect(section(page)?.textContent).toContain("The tools could not be read."),
      WAIT
    );
    expect(section(page)?.textContent).not.toContain(WAITING);
  });
});

describe("A Connection whose type reads no tools", () => {
  it("says nothing about tools and reads the Connection no more than a write asks", async () => {
    // A document source: it signs in, syncs documents and has no tools to read.
    const asset = connectionAsset("files", {
      origin: "runtime",
      connectorType: "document_source",
      authScheme: "oauth"
    });
    let reads = 0;
    const { page } = await openPage(
      asset,
      () => {
        reads += 1;
        return { operations: [], oauth: OAUTH };
      },
      [],
      (opened) => opened.querySelector("[data-connection-about-edit]")
    );
    await vi.waitFor(() => expect(reads).toBeGreaterThan(0), WAIT);
    await vi.waitFor(() => expect(page.querySelector("#sign-in")).not.toBeNull(), WAIT);
    expect(section(page)).toBeNull();
    expect(page.querySelector("#operations")).toBeNull();
    expect(page.textContent).not.toContain(WAITING);

    // A write reads it again once; nothing is on its way, so nothing is polled for.
    await act(async () =>
      page.querySelector<HTMLButtonElement>("[data-connection-about-edit]")?.click()
    );
    const title = page.querySelector<HTMLInputElement>(
      '[data-connection-about-form] [data-connection-field="title"]'
    );
    await act(async () => {
      if (title) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          title,
          "Team files"
        );
        title.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    const before = reads;
    await act(async () =>
      page.querySelector<HTMLFormElement>("[data-connection-about-form]")?.requestSubmit()
    );
    await vi.waitFor(
      () => expect(page.querySelector("[data-connection-about-form]")).toBeNull(),
      WAIT
    );
    await vi.waitFor(() => expect(reads).toBe(before + 1), WAIT);
    // Longer than the two seconds between the reads of a page that waits.
    await act(() => new Promise((resolve) => setTimeout(resolve, 2_500)));
    expect(reads).toBe(before + 1);
    expect(section(page)).toBeNull();
  });
});
