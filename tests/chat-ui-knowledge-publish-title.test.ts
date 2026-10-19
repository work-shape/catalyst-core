// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { BuildAsset } from "@work-shape/catalyst-chat-ui/build-area";
import { mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { CONDITION_WAIT_MS } from "./support/assertions";

// ACCEPT-2d, cosmetic: the Publish dialog of a Knowledge Base asked "richtlinien-nordlicht
// veröffentlichen?", the id. It names the Knowledge Base by the title people read.

afterEach(unmountBuildPages);

const NAME = "richtlinien-nordlicht";

function draftAhead(): BuildAsset {
  return {
    id: "asset_richtlinien",
    kind: "knowledge_base",
    name: NAME,
    scope: { kind: "instance" },
    revision: 2,
    draftRevision: 2,
    publishedRevision: 1,
    config: { name: NAME, title: "Richtlinien Nordlicht", methods: ["keyword"] },
    allowed: ["write", "publish"],
    updatedAt: "2026-10-19T10:00:00.000Z"
  };
}

async function until<T>(read: () => T | null | undefined): Promise<T> {
  let found: T | null | undefined;
  await vi.waitFor(
    async () => {
      await act(async () => undefined);
      found = read();
      expect(found).toBeTruthy();
    },
    { timeout: CONDITION_WAIT_MS }
  );
  if (found === null || found === undefined) throw new Error("not found");
  return found;
}

describe("the Publish dialog of a Knowledge Base", () => {
  it("names it by its title, never by its id", async () => {
    const statePath = apiOperations["knowledge_bases.get"].path.replace(":knowledgeBase", NAME);
    const container = await mountBuildPage(draftAhead(), "knowledge-bases", (_request, url) =>
      url.pathname === statePath
        ? Response.json({ id: "asset_richtlinien", name: NAME, status: "ready", tables: [] })
        : undefined
    );

    const publish = await until(() =>
      container.querySelector<HTMLButtonElement>("[data-build-publish]")
    );
    await act(async () => publish.click());

    const dialog = await until(() =>
      [...document.body.querySelectorAll("dialog")].find((each) => each.open)
    );
    expect(dialog.textContent).toContain("Publish Richtlinien Nordlicht?");
    expect(dialog.textContent).not.toContain(NAME);
  });
});
