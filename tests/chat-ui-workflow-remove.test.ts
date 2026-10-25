import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  createInstanceSource,
  WorkflowRemoveKnowledge
} from "@work-shape/catalyst-chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { recordedApiClient } from "./support/recorded-api-client";

// KBW-2c (Knowledge Bases check 112): the question before a Workflow is deleted names the
// Knowledge Bases it fed, each with its documents, and counts those the reader cannot open.

const render = (node: ReactNode, locale: "en" | "de") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));

const view = {
  knowledgeBases: [
    { name: "contracts", title: "Contracts", documents: 12 },
    { name: "handbook", title: "Handbook", documents: 1 }
  ],
  hidden: { knowledgeBases: 2, documents: 40 }
};

const asset = {
  id: "asset_import",
  kind: "workflow",
  name: "import",
  title: "Import",
  scope: { kind: "instance" },
  revision: 4,
  draftRevision: 4,
  publishedRevision: 4,
  createdAt: "2026-10-10T09:00:00.000Z",
  updatedAt: "2026-10-17T09:00:00.000Z",
  config: { name: "import", manifest: { id: "import", name: "Import", steps: [] } }
};

describe("the question before a Workflow is deleted (KBW-2c)", () => {
  it("names each Knowledge Base it fed with its documents, and counts the hidden ones, in both languages", () => {
    const en = render(createElement(WorkflowRemoveKnowledge, { view }), "en");
    expect(en).toContain("It put documents into these knowledge bases");
    expect(en).toContain("Contracts");
    expect(en).toContain("12 documents");
    expect(en).toContain("Handbook");
    expect(en).toContain("1 document");
    expect(en).toContain("2 knowledge bases you cannot open");
    expect(en).toContain("40 documents");
    const de = render(createElement(WorkflowRemoveKnowledge, { view }), "de");
    expect(de).toContain("Er hat Dokumente in diese Wissensbasen gelegt");
    expect(de).toContain("12 Dokumente");
    expect(de).toContain("1 Dokument");
    expect(de).toContain("2 Wissensbasen, die du nicht öffnen kannst");
    expect(de).toContain("endgültig gelöscht");
  });

  it("says nothing of Knowledge Bases where the Workflow fed none", () => {
    expect(
      render(
        createElement(WorkflowRemoveKnowledge, {
          view: { knowledgeBases: [], hidden: { knowledgeBases: 0, documents: 0 } }
        }),
        "en"
      )
    ).toBe("");
  });

  it("asks the instance what the delete ends, and deletes at the revision it asked at", async () => {
    const { client, calls } = recordedApiClient(({ operation }) =>
      operation === "assets.get"
        ? asset
        : operation === "knowledge_bases.workflow_sources"
          ? view
          : { version: 7, revision: 5, warnings: [] }
    );
    const removal = createInstanceSource(client, "test").removal;
    expect(await removal?.read("import", new AbortController().signal)).toEqual({
      revision: 4,
      ...view
    });
    await removal?.remove("import", 4);
    expect(
      calls.map((call) => [
        call.operation,
        call.params,
        call.body ? JSON.parse(call.body) : undefined
      ])
    ).toEqual([
      ["assets.get", { kind: "workflow", name: "import" }, undefined],
      ["knowledge_bases.workflow_sources", { workflow: "import" }, undefined],
      ["assets.delete", { kind: "workflow", name: "import" }, { expectedRevision: 4 }]
    ]);
  });

  it("answers no Knowledge Base where the instance has none", async () => {
    const { client } = recordedApiClient(({ operation }) =>
      operation === "assets.get"
        ? asset
        : Response.json(
            { error: { code: "NOT_FOUND", message: "Module 'knowledge' is off on this instance" } },
            { status: 404 }
          )
    );
    expect(
      await createInstanceSource(client, "test").removal?.read(
        "import",
        new AbortController().signal
      )
    ).toEqual({ revision: 4, knowledgeBases: [], hidden: { knowledgeBases: 0, documents: 0 } });
  });
});
