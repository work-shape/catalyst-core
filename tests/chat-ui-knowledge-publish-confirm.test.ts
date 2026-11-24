// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  knowledgeBaseKindOn,
  resolveBuildRights,
  type BuildAsset,
  type BuildSource,
  type KnowledgeBaseSource,
  type KnowledgeRead,
  type PublishQuestionAnswer
} from "@work-shape/catalyst-chat-ui/build-area";
import { platformContext } from "./chat-ui-build-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";

// A Knowledge Base whose publish processes or embeds documents again asks for one confirmation
// of the count and cost (KB-8). The Build publish dialog shows the statement and passes the
// confirmation it read; a publish refused because the numbers changed since says so.

const noop = () => undefined;
const ready = <Answer>(data: Answer): KnowledgeRead<Answer> => ({ status: "ready", data });
const CONFIRMATION = "c".repeat(64);
const STATEMENT = "Re-embed with text-embedding-3-large: 1,200 passages, about 480,000 tokens.";

const draft: BuildAsset = {
  id: "asset_handbook",
  kind: "knowledge_base",
  name: "handbook-kb",
  scope: { kind: "instance" },
  revision: 3,
  publishedRevision: 2,
  draftRevision: 3,
  config: {
    name: "handbook-kb",
    title: "Handbook",
    description: "The staff handbook and its appendices.",
    methods: ["semantic", "keyword"],
    indexing: { embedding: { binding: "embed-large" } }
  },
  updatedAt: "2026-10-25T10:00:00.000Z"
};

const source: KnowledgeBaseSource = {
  useState: () => ready({ id: draft.id, name: draft.name, status: "ok", revision: 2, tables: [] }),
  check: async () => ({ ok: false, refused: false, message: undefined }),
  query: async () => ({ ok: false, refused: false, message: undefined }),
  search: async () => ({ ok: false, refused: false, message: undefined }),
  useDataStores: () => ready({ items: [] }),
  useStoreTables: () => ready([]),
  useKnowledgeBases: () => ready({ items: [] }),
  useDocuments: () => ready({ documents: [] }),
  retry: async () => ({ ok: true, data: {} }),
  remove: async () => ({ ok: true, data: {} }),
  addFiles: async () => ({ ok: true, data: { count: 0 } }),
  uploadFile: async () => ({ ok: true, data: { count: 0 } }),
  useOpenableFiles: () => ready({ items: [] })
};

const unmounts: (() => void)[] = [];

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  vi.unstubAllGlobals();
});

async function mount(input: {
  question: PublishQuestionAnswer;
  publish: BuildSource["writes"]["publish"];
  locale?: "en" | "de";
}): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const frame: BuildSource = {
    kinds: [{ kind: "knowledge_base", canCreate: true, canDelete: true }],
    rights: resolveBuildRights(
      { permissions: ["config_assets.write", "config_assets.publish"] },
      platformContext()
    ),
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: () => ({
      rows: [],
      error: undefined,
      hasMore: false,
      loadingMore: false,
      loadMore: noop,
      retry: noop
    }),
    useAsset: () => ({ status: "ready", asset: draft, loadedAt: 1, reload: async () => "loaded" }),
    exists: async () => true,
    checkName: async () => ({ available: true }),
    publishQuestion: async () => input.question,
    writes: {
      put: async () => ({ revision: 3 }),
      readFiles: async () => [],
      delete: async () => undefined,
      publish: input.publish,
      revert: async () => ({ revision: 3 }),
      revisions: async () => ({ items: [] })
    }
  };
  const planted = knowledgeBaseKindOn(() => source);
  const kinds = buildAssetKinds.map((kind) => (kind.kind === "knowledge_base" ? planted : kind));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(
            TranslationProvider,
            { locale: input.locale ?? "en", children: null },
            createElement(
              BuildAssetKindsProvider,
              { value: kinds },
              createElement(
                BuildNavigationProvider,
                {
                  value: {
                    location: { kindPath: "knowledge-bases", name: draft.name },
                    open: noop,
                    href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
                  }
                },
                createElement(BuildFrame, { source: frame })
              )
            )
          )
        )
      )
    );
  });
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
  });
  return container;
}

/** Opens the publish dialog and confirms it. */
async function publishFrom(page: HTMLElement): Promise<void> {
  const offered = page.querySelector<HTMLButtonElement>("[data-build-publish]");
  if (!offered) throw new Error("No publish button");
  await act(async () => offered.click());
  await act(async () => undefined);
  // The page holds more dialogs than this one: the confirm is the one named Publish.
  const confirm = [...document.querySelectorAll("dialog button")].find(
    (button): button is HTMLButtonElement =>
      button instanceof HTMLButtonElement && button.textContent?.trim() === "Publish"
  );
  if (!confirm) throw new Error("No confirm button");
  await act(async () => confirm.click());
}

/** The server's processing sentence, which the dialog words anew from its fields. */
const SERVER_SENTENCE = "The server's processing sentence.";

/** Opens the publish dialog without confirming it. */
async function openDialog(page: HTMLElement): Promise<string> {
  const offered = page.querySelector<HTMLButtonElement>("[data-build-publish]");
  if (!offered) throw new Error("No publish button");
  await act(async () => offered.click());
  await act(async () => undefined);
  return document.querySelector("[data-build-publish-question=ready]")?.textContent ?? "";
}

const pointers = { draftRevision: 3, publishedRevision: 3 };

describe("Publishing a Knowledge Base that embeds again", () => {
  // fix: the dialog words what is processed again from the statement's fields, in the reader's
  // language, not from the server's sentence.
  it("words the processing line from the statement's fields, with its cost", async () => {
    const question = (cost: NonNullable<PublishQuestionAnswer["processing"]>["cost"]) => ({
      lines: ["Re-embed with text-embedding-3-large: 1,200 passages.", SERVER_SENTENCE],
      confirmation: CONFIRMATION,
      processing: { count: 3, line: 1, cost }
    });
    const text = await openDialog(
      await mount({
        question: question({ kind: "estimate", min: 0.5, max: 2, currency: "USD" }),
        publish: vi.fn(async () => pointers)
      })
    );
    expect(text).toContain("Re-embed with text-embedding-3-large");
    expect(text).toContain("$0.50 to $2.00");
    expect(text).not.toContain(SERVER_SENTENCE);
    for (const unmount of unmounts.splice(0)) unmount();
    const unpriced = await openDialog(
      await mount({
        question: question({ kind: "unavailable" }),
        publish: vi.fn(async () => pointers)
      })
    );
    expect(unpriced).toContain("no price");
  });

  // ACCEPT-2d: the dialog asked to publish the id; it names the Knowledge Base by its title.
  it("names it by its title, shows what it embeds and passes the confirmation it read", async () => {
    const publish = vi.fn(async () => pointers);
    const page = await mount({
      question: { lines: [STATEMENT], confirmation: CONFIRMATION },
      publish
    });
    await act(async () => page.querySelector<HTMLButtonElement>("[data-build-publish]")?.click());
    const dialog = [...document.body.querySelectorAll("dialog")].find((each) => each.open);
    expect(dialog?.textContent).toContain("Publish Handbook?");
    expect(dialog?.textContent).not.toContain(draft.name);
    for (const unmount of unmounts.splice(0)) unmount();
    await publishFrom(
      await mount({ question: { lines: [STATEMENT], confirmation: CONFIRMATION }, publish })
    );
    expect(document.body.textContent).toContain(STATEMENT);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: draft.name, revision: 3, confirmProcessing: CONFIRMATION })
    );
  });

  it("passes none where the question names none", async () => {
    const publish = vi.fn(
      async (_input: Parameters<BuildSource["writes"]["publish"]>[0]) => pointers
    );
    await publishFrom(await mount({ question: { lines: [] }, publish }));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).not.toHaveProperty("confirmProcessing");
  });

  it("says that the numbers changed when the confirmation no longer holds", async () => {
    const refusal = Object.assign(new Error("refused"), {
      payload: {
        error: {
          code: "VALIDATION_FAILED",
          message: "Confirm with assets.publish confirmProcessing: 'd…'",
          details: { reason: "knowledge_reindex_confirmation_required", confirmation: "d" }
        }
      }
    });
    const page = await mount({
      question: { lines: [STATEMENT], confirmation: CONFIRMATION },
      publish: async () => {
        throw refusal;
      }
    });
    await publishFrom(page);
    await act(async () => undefined);
    expect(page.textContent).toContain("changed in the meantime");
    expect(page.textContent).not.toContain("confirmProcessing");
  });
});
