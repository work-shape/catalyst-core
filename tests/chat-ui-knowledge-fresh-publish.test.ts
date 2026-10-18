// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { BuildAsset } from "@work-shape/catalyst-chat-ui/build-area";
import { mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { CONDITION_WAIT_MS } from "./support/assertions";

// ACCEPT-FIX-8, E7, through the page's own reads of the instance: right after a publish the
// Knowledge Base's store is being made and has no documents table, and listing the documents
// answered a raw SQL error. The page asks for no documents until the state says the store is
// ready, and says meanwhile that it is being made.

afterEach(unmountBuildPages);

const NAME = "richtlinien";

function knowledgeBase(): BuildAsset {
  return {
    id: "asset_richtlinien",
    kind: "knowledge_base",
    name: NAME,
    scope: { kind: "instance" },
    revision: 1,
    draftRevision: 1,
    publishedRevision: 1,
    config: { name: NAME, title: "Richtlinien", methods: ["keyword"] },
    allowed: ["write"],
    updatedAt: "2026-10-18T10:00:00.000Z"
  };
}

async function until(check: () => void): Promise<void> {
  await vi.waitFor(
    async () => {
      await act(async () => undefined);
      check();
    },
    { timeout: CONDITION_WAIT_MS }
  );
}

describe("a Knowledge Base opened right after its publish", () => {
  it("asks for no documents while its store is made, and shows no SQL error", async () => {
    const statePath = apiOperations["knowledge_bases.get"].path.replace(":knowledgeBase", NAME);
    const documentsPath = apiOperations["knowledge_bases.list_documents"].path.replace(
      ":knowledgeBase",
      NAME
    );
    let stateReads = 0;
    let documentReads = 0;
    const container = await mountBuildPage(knowledgeBase(), "knowledge-bases", (_request, url) => {
      if (url.pathname === statePath) {
        stateReads += 1;
        return Response.json({
          id: "asset_richtlinien",
          name: NAME,
          status: "preparing",
          tables: []
        });
      }
      if (url.pathname === documentsPath) {
        documentReads += 1;
        return Response.json(
          {
            error: {
              code: "INTERNAL",
              message:
                "Listing the documents names a table or view that does not exist (SQLSTATE 42P01)"
            }
          },
          { status: 500 }
        );
      }
      return undefined;
    });

    await until(() =>
      expect(container.querySelector("[data-knowledge-documents-preparing]")?.textContent).toBe(
        "Its store is being made. The documents show here by themselves once it is ready."
      )
    );
    expect(stateReads).toBeGreaterThan(0);
    expect(documentReads).toBe(0);
    expect(container.textContent).not.toContain("SQLSTATE");
  });
});
