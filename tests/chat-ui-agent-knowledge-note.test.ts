// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import type { BuildAsset } from "@work-shape/catalyst-chat-ui/build-area";
import {
  listedKind,
  mountBuildPage,
  unmountBuildPages,
  type EditableAgentField
} from "./chat-ui-build-page-harness";
import { CONDITION_WAIT_MS } from "./support/assertions";

// ACCEPT-FIX-8, C11: the Knowledge Base chooser of an agent said "Only a published knowledge
// base answers" when it offered nothing, though the Knowledge Base was published and belonged
// to another workspace. The note now says which Knowledge Bases the list holds, and an
// unpublished one says so on its own row.

const en = createTranslationContext("en").t;
const de = createTranslationContext("de").t;
const OWNER = "cw_owner";
const AGENT_FIELDS: readonly EditableAgentField[] = ["knowledgeBases"];

afterEach(unmountBuildPages);

function agent(scope: BuildAsset["scope"]): BuildAsset {
  return {
    id: "asset_empfang",
    kind: "agent",
    name: "empfang",
    scope,
    revision: 3,
    config: { name: "empfang", displayName: "Empfang", instructions: "Help." },
    allowed: ["write"],
    updatedAt: "2026-10-17T01:00:00.000Z"
  };
}

/** One published and one unpublished Knowledge Base of the owner's workspace, none of the instance. */
function answer(request: Request, url: URL): Response | undefined {
  const kind = listedKind(request, url);
  if (kind === undefined) return undefined;
  if (kind !== "knowledge_base" || url.searchParams.get("workspaceId") !== OWNER)
    return Response.json({ items: [] });
  const listed = (name: string, title: string, published: boolean) => ({
    id: `asset_${name}`,
    kind,
    name,
    title,
    scope: { kind: "workspace", workspaceId: OWNER },
    revision: 1,
    draftRevision: 1,
    ...(published ? { publishedRevision: 1 } : {}),
    updatedAt: "2026-10-18T09:00:00.000Z"
  });
  return Response.json({
    items: [listed("richtlinien", "Richtlinien", true), listed("entwurf", "Entwurf", false)]
  });
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

async function openChooser(container: HTMLElement) {
  const label = en("knowledge.agentSection");
  const chooser = () => container.querySelector<HTMLElement>(`button[aria-label^="${label}:"]`);
  await until(() => expect(chooser()).not.toBeNull());
  await act(async () => chooser()?.click());
}

const rows = () =>
  [...document.querySelectorAll("[cmdk-item]:not([data-picker-more])")].map(
    (row) => row.textContent ?? ""
  );

describe("the Knowledge Base chooser of an agent says why one is missing or does not answer", () => {
  it("names the workspace and the instance as what it lists, and marks an unpublished one", async () => {
    const container = await mountBuildPage(
      agent({ kind: "workspace", workspaceId: OWNER }),
      "agents",
      answer,
      AGENT_FIELDS
    );
    await openChooser(container);
    await until(() => expect(rows()).toHaveLength(2));

    expect(document.body.textContent).toContain(
      "Lists the knowledge bases of this agent's workspace and of the instance. One of another workspace is not offered here."
    );
    expect(document.body.textContent).not.toContain("Only a published knowledge base answers.");
    const [published, unpublished] = rows();
    expect(published).toBe("Richtlinien");
    expect(unpublished).toContain("Entwurf");
    expect(unpublished).toContain("Not published yet: it answers once it is published");
  });

  it("names only the instance for an agent of the instance, whose list is empty here", async () => {
    const container = await mountBuildPage(
      agent({ kind: "instance" }),
      "agents",
      answer,
      AGENT_FIELDS
    );
    await openChooser(container);
    await until(() =>
      expect(document.body.textContent).toContain(
        "Lists the instance's knowledge bases. One that a workspace owns is not offered here."
      )
    );
    expect(rows()).toEqual([]);
  });

  it("says the same in German", () => {
    expect(de("knowledge.agentNoteWorkspace")).toBe(
      "Hier stehen die Wissensbasen aus dem Arbeitsbereich dieses Agenten und die der Instanz. Eine aus einem anderen Arbeitsbereich steht hier nicht zur Wahl."
    );
    expect(de("knowledge.agentNoteInstance")).toBe(
      "Hier stehen die Wissensbasen der Instanz. Eine, die einem Arbeitsbereich gehört, steht hier nicht zur Wahl."
    );
    expect(de("knowledge.agentUnpublished")).toBe(
      "Noch nicht veröffentlicht: Sie antwortet, sobald sie veröffentlicht ist"
    );
  });
});
