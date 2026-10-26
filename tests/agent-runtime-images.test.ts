import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  asClientInstanceId,
  asConversationAttachmentId,
  asManagedArtifactId,
  asManagedFileId,
  type ModelProviderConfig,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import { modelContentImages, modelContentText } from "@work-shape/catalyst-model-provider";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { defineTool } from "@work-shape/catalyst-tool-sdk";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createConversationWithMessages, noReportedUsage } from "./helpers/agent-runtime";
import { withTestModelGateway, type FakeModelProvider } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";

describe("local agent runtime", () => {
  it("sends the page images of the current run and names those of an earlier run instead", async () => {
    const f = await pageImageFixture("page-images-earlier-run");

    await f.runToEnd("Check pages one and two", [1, 2]);
    await f.runToEnd("And what about the signature?", []);

    // The second request of the first run answers the two tool calls of that run.
    expect(f.imageSizes(1)).toEqual([8, 8]);
    expect(f.text(1)).toContain("[Visual context loaded]");
    // The next run carries no image and read none from storage.
    expect(f.imageSizes(2)).toEqual([]);
    expect(f.artifactReads()).toBe(2);
    const marker = f.text(2);
    expect(marker).toContain("[Visual context not loaded:");
    expect(marker).not.toContain("[Visual context loaded]");
    expect(marker).toContain(
      "fileId: file_contract, artifactId: art_page_1, mimeType: image/png, page: 1"
    );
    expect(marker).toContain(
      "fileId: file_contract, artifactId: art_page_2, mimeType: image/png, page: 2"
    );
  });

  it("leaves the oldest images out of a request once its image bytes pass the budget", async () => {
    const twelveMiB = 12 * 1024 * 1024;
    const f = await pageImageFixture("page-images-budget", { imageBytes: twelveMiB });

    await f.runToEnd("Check pages one to three", [1, 2, 3]);

    // Three images of 12 MiB are above the budget of 32 MiB; the two newest stay.
    expect(f.imageSizes(1)).toEqual([twelveMiB, twelveMiB]);
    const text = f.text(1);
    expect(text).toContain("[Visual context not loaded:");
    expect(text.slice(text.indexOf("[Visual context not loaded:"))).toContain("page: 1");
    expect(text.match(/\[Visual context loaded\]/gu)).toHaveLength(2);
  });

  it("keeps every page of a run that views fifteen pages in the model's rendition, four times over", async () => {
    // The largest page measured in the model's rendition on 2026-10-10: a rough colour scan.
    const roughScanJpegBytes = 446_005;
    const f = await pageImageFixture("page-images-fifteen-pages", {
      imageBytes: roughScanJpegBytes
    });
    const pages = Array.from({ length: 4 * 15 }, (_, index) => index + 1);

    await f.runToEnd("Read the whole contract", pages);

    expect(f.imageSizes(1)).toEqual(pages.map(() => roughScanJpegBytes));
    expect(f.text(1)).not.toContain("[Visual context not loaded:");
  });

  it("counts a page stored as PNG before the model's rendition at its real size", async () => {
    // The same rough scan as the 160 DPI PNG that pages were stored as before.
    const roughScanPngBytes = 5_438_051;
    const f = await pageImageFixture("page-images-old-png", { imageBytes: roughScanPngBytes });
    const pages = Array.from({ length: 15 }, (_, index) => index + 1);

    await f.runToEnd("Read the whole contract", pages);

    // Six of them fit 32 MiB; the nine oldest are named for loading again.
    expect(f.imageSizes(1)).toEqual(Array.from({ length: 6 }, () => roughScanPngBytes));
    expect(f.text(1).match(/\[Visual context not loaded:/gu)).toHaveLength(9);
    expect(f.text(1).match(/\[Visual context loaded\]/gu)).toHaveLength(6);
  });

  it("drops the images a tool loaded before those the user attached, image by image", async () => {
    const sevenMiB = 7 * 1024 * 1024;
    const f = await pageImageFixture("page-images-user-attached", {
      imageBytes: sevenMiB,
      attachedImages: 5
    });

    await f.runToEnd("Compare my photos with page one", [1]);

    // Four attached images of 7 MiB fit the budget of 32 MiB; the fifth and the page do not.
    const request = f.requests[1]?.messages ?? [];
    const user = request.find((message) => message.role === "user");
    expect(modelContentImages(user?.content ?? "").map((image) => image.source?.label)).toEqual([
      "photo-1.png",
      "photo-2.png",
      "photo-3.png",
      "photo-4.png"
    ]);
    expect(modelContentText(user?.content ?? "")).toContain(
      "[1 image was too large to include in the model input and was left out: photo-5.png.]"
    );
    expect(f.imageSizes(1)).toHaveLength(4);
    expect(f.text(1)).toContain("[Visual context not loaded:");
    expect(f.text(1)).not.toContain("[Visual context loaded]");
  });

  it("answers from a stored checkpoint whose later tool results held page images", async () => {
    const f = await pageImageFixture("page-images-checkpoint", { compactOnToolCalls: true });

    await f.runToEnd("Check page one", [1]);
    await f.runToEnd("Go on", []);

    expect(await f.storedContinuation()).toBeDefined();
    expect(f.requests[2]?.continuation).toEqual(f.continuation);
    expect(f.requests[2]?.messages.map((message) => message.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "assistant",
      "user"
    ]);
    expect(f.imageSizes(2)).toEqual([]);
    expect(f.text(2)).toContain("fileId: file_contract, artifactId: art_page_1");
  });
});

/**
 * A runtime whose agent views document pages: each run first calls the page tool for the given
 * pages and then answers. Requests to the model are recorded in order.
 */
async function pageImageFixture(
  name: string,
  options: { imageBytes?: number; compactOnToolCalls?: boolean; attachedImages?: number } = {}
) {
  const clientInstanceId = asClientInstanceId(`${name}-client`);
  const context: RuntimeCallContext = {
    clientInstanceId,
    correlationId: `corr-${name}`,
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
  const store = (await createTestInstance()).stores;
  const conversationId = await createConversationWithMessages(store, {
    clientInstanceId,
    messages: []
  });
  const providerConfig: ModelProviderConfig = {
    id: "test-provider",
    type: "openai-compatible",
    api: "responses",
    model: "test-model",
    contextManagement: { compaction: { compactThresholdTokens: 270_000 } }
  };
  const continuation = {
    providerId: providerConfig.id,
    state: { compaction: { type: "compaction", encrypted_content: "opaque-checkpoint" } }
  };
  const requests: Parameters<FakeModelProvider["complete"]>[0][] = [];
  let pagesToView: number[] = [];
  let artifactReads = 0;
  const runtime = new LocalAgentRuntime(
    withTestModelGateway({
      assetSource: createStaticConfigAssetSource({
        agents: [
          {
            skillNames: [],
            name: "page_agent",
            displayName: "Page Agent",
            instructions: "Help the user.",
            modelProviderId: providerConfig.id,
            toolNames: ["view_document_page"],
            initialPrompts: []
          }
        ]
      }),
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store.conversations,
      modelProviderContinuationStore: store.conversations,
      modelProvider: {
        id: providerConfig.id,
        async complete(request) {
          // The runtime goes on appending to the list it passed, so keep what this request held.
          requests.push({ ...request, messages: [...request.messages] });
          const pages = pagesToView;
          pagesToView = [];
          if (pages.length === 0) {
            return { text: "Done.", toolCalls: [], usage: noReportedUsage() };
          }
          return {
            text: "",
            toolCalls: pages.map((pageNumber) => ({
              toolCallId: `call_${requests.length}_${pageNumber}`,
              toolName: "view_document_page",
              input: { fileId: "file_contract", pageNumber }
            })),
            ...(options.compactOnToolCalls
              ? { continuation, contextManagement: { compacted: true } }
              : {}),
            usage: noReportedUsage()
          };
        }
      },
      toolRegistry: new ToolRegistry({
        tools: [
          defineTool({
            name: "view_document_page",
            effect: "reading",
            description: "View a document page.",
            inputSchema: z.object({ fileId: z.string(), pageNumber: z.number() }),
            async execute() {
              throw new Error("Tool registry execution should not be used by this test");
            }
          })
        ]
      }),
      async runTool(request) {
        const pageNumber = z.object({ pageNumber: z.number() }).parse(request.input).pageNumber;
        return {
          status: "success",
          output: { fileId: "file_contract", pageNumber },
          artifacts: [
            {
              artifactId: asManagedArtifactId(`art_page_${pageNumber}`),
              kind: "document.page_image",
              mimeType: "image/png",
              modelVisibility: { type: "image", mimeType: "image/png" },
              metadata: { fileId: "file_contract", pageNumber }
            }
          ]
        };
      },
      artifactReader: {
        async readArtifact() {
          artifactReads += 1;
          return { bytes: new Uint8Array(options.imageBytes ?? 8), mimeType: "image/png" };
        }
      },
      fileReader: {
        async readFile() {
          return { bytes: new Uint8Array(options.imageBytes ?? 8), mimeType: "image/png" };
        }
      },
      usageGovernance: new ModelUsageGovernance({ store: store.usage, budget: {}, safeguards: {} })
    })
  );
  const requestMessages = (index: number) => requests[index]?.messages ?? [];
  return {
    requests,
    continuation,
    artifactReads: () => artifactReads,
    /** The byte sizes of the images of one recorded request, in order. */
    imageSizes: (index: number) =>
      requestMessages(index).flatMap((message) =>
        modelContentImages(message.content).map((image) => image.data.byteLength)
      ),
    /** The text of every tool message of one recorded request. */
    text: (index: number) =>
      requestMessages(index)
        .filter((message) => message.role === "tool")
        .map((message) => modelContentText(message.content))
        .join("\n"),
    storedContinuation: () =>
      store.conversations.getModelProviderContinuation({
        clientInstanceId,
        conversationId,
        providerId: providerConfig.id
      }),
    async runToEnd(text: string, pages: number[]) {
      pagesToView = pages;
      const userMessage = await store.conversations.appendMessage({
        clientInstanceId,
        conversationId,
        role: "user",
        text
      });
      const run = await runtime.start(
        {
          agentName: "page_agent",
          conversationId,
          inputMessageId: userMessage.id,
          message: {
            text,
            ...(options.attachedImages
              ? {
                  attachmentManifest: {
                    version: 1 as const,
                    attachments: Array.from({ length: options.attachedImages }, (_, index) => ({
                      kind: "image",
                      fileId: asManagedFileId(`file_photo_${index + 1}`),
                      attachmentId: asConversationAttachmentId(`att_photo_${index + 1}`),
                      filename: `photo-${index + 1}.png`,
                      mimeType: "image/png",
                      byteSize: options.imageBytes ?? 8,
                      status: "ready",
                      modelVisibility: { type: "image" as const, mimeType: "image/png" as const }
                    }))
                  }
                }
              : {})
          }
        },
        context
      );
      for await (const event of runtime.observe(run.runId, context)) {
        if (event.type === "run_failed") {
          throw new Error("The run failed");
        }
      }
    }
  };
}
