// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { TranslationProvider } from "./chat-ui-render-harness";
import { CONDITION_WAIT_MS } from "./support/assertions";
import { useDraftAttachmentController } from "./support/chat-ui";

// ACCEPT-FIX-10 C14: attaching a file on the start page made a conversation named after the
// file before anything was sent. The file now waits in the composer; the conversation is made
// when the first message is sent, and the message goes once its files are ready.

const createdAt = "2026-10-19T09:00:00.000Z";
const conversation = {
  id: "conv_files",
  clientInstanceId: "ci_1",
  collaborationWorkspaceId: "cw_personal",
  createdByUserId: "user_1",
  createdByExternalUserId: "ext_1",
  visibility: "private",
  title: "Perso.pdf",
  status: "active",
  createdAt,
  updatedAt: createdAt,
  retainedUntil: "2027-10-19T09:00:00.000Z"
};
const attachment = {
  id: "attachment_1",
  conversationId: "conv_files",
  fileId: "file_1",
  filename: "Perso.pdf",
  mimeType: "application/pdf",
  byteSize: 7,
  status: "ready",
  artifactRefs: {},
  processingMetadata: {},
  warnings: [],
  createdAt,
  updatedAt: createdAt
};

type Controller = ReturnType<typeof useDraftAttachmentController>;

/** `refusals` uploads are refused before one is taken; files stay `processing` for good if set. */
async function startPage(
  server: {
    refusals?: number;
    processing?: boolean;
    refusedFile?: string;
    /** The answer to the conversation's create waits for this. */
    createHeld?: Promise<void>;
  } = {}
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const calls: string[] = [];
  let refusals = server.refusals ?? 0;
  const client = createApiClient({
    baseUrl: "https://chat.example.com",
    fetchImpl: async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      const method = (request instanceof Request ? request.method : init?.method) ?? "GET";
      const files = url.pathname.endsWith("/draft-attachments");
      if (method === "DELETE" && url.searchParams.get("discardEmpty") === "true") {
        calls.push(`discard ${url.pathname.split("/").at(-1)}`);
        return Response.json(conversation);
      }
      if (method === "DELETE") {
        calls.push(`remove ${url.pathname.split("/").at(-1)}`);
        return new Response(null, { status: 204 });
      }
      if (!files) {
        calls.push("create conversation");
        await server.createHeld;
        return Response.json(conversation);
      }
      calls.push(`${method === "POST" ? "upload" : "list"} files of ${url.pathname.split("/")[4]}`);
      const sent = init?.body instanceof FormData ? init.body.get("file") : null;
      const refused = sent instanceof File && sent.name === server.refusedFile;
      if (method === "POST" && (refused || refusals > 0)) {
        if (!refused) refusals -= 1;
        return Response.json(
          { error: { code: "VALIDATION_FAILED", message: "File type is not allowed" } },
          { status: 400 }
        );
      }
      if (method === "POST") {
        expect(url.searchParams.get("agentName")).toBe("file_agent");
        const taken = { ...attachment, id: `attachment_${sent instanceof File ? sent.name : ""}` };
        return Response.json({ attachment: taken, attachments: [taken], outcome: "created" });
      }
      const status = server.processing ? "preprocessing" : "ready";
      return Response.json({ items: [{ ...attachment, status }] });
    }
  });
  const shown = vi.fn();
  let controller: Controller | undefined;
  function Probe({ workspace, selected }: { workspace: string; selected?: string }) {
    controller = useDraftAttachmentController({
      enabled: true,
      apiBaseUrl: "https://chat.example.com",
      authScope: "staged-test",
      client,
      selectedConversationId: selected,
      agentName: "file_agent",
      collaborationWorkspaceId: workspace,
      isAuthenticated: true,
      createConversationForFiles: () =>
        client.conversations.create({ body: { title: "Perso.pdf", locale: "de" } }),
      showConversationForFiles: shown,
      onError: () => undefined
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (workspace: string, selected?: string) =>
    act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(TranslationProvider, {
            locale: "de",
            children: createElement(Probe, { workspace, ...(selected ? { selected } : {}) })
          })
        )
      );
    });
  await render("cw_personal");
  return {
    controller: () => controller,
    calls,
    shown,
    openWorkspace: render,
    /** Sends staged files, or none, as the start page does before it starts the message. */
    send: async () => {
      let conversationId: string | undefined;
      await act(async () => {
        conversationId = await controller?.sendStagedFiles();
      });
      return conversationId;
    },
    /** What the workspace does once the message of the conversation was submitted. */
    submitted: (conversationId: string) =>
      act(async () => controller?.clearConversationUploads(conversationId)),
    unmount: () => act(() => root.unmount())
  };
}

const pdf = () => new File(["content"], "Perso.pdf", { type: "application/pdf" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("files attached before the first message", () => {
  it("wait in the composer and make no conversation", async () => {
    const page = await startPage();
    try {
      await act(async () => page.controller()?.onFilesSelected([pdf()]));
      expect(page.calls).toEqual([]);
      expect(page.controller()?.visibleUploadingAttachments).toMatchObject([
        { filename: "Perso.pdf", status: "staged" }
      ]);
      // A staged file does not hold the message back.
      expect(page.controller()?.sendBlockedReason).toBeUndefined();
    } finally {
      await page.unmount();
    }
  });

  it("go to the conversation made as the message is sent, once they are ready", async () => {
    const page = await startPage();
    try {
      await act(async () => page.controller()?.onFilesSelected([pdf()]));
      let conversationId: string | undefined;
      await act(async () => {
        conversationId = await page.controller()?.sendStagedFiles();
      });
      expect(conversationId).toBe("conv_files");
      expect(page.calls).toEqual([
        "create conversation",
        "upload files of conv_files",
        "list files of conv_files"
      ]);
      expect(page.controller()?.visibleUploadingAttachments).toEqual([]);
      expect(page.shown).not.toHaveBeenCalled();
    } finally {
      await page.unmount();
    }
  });

  it("can be taken out before sending, and a message without files makes nothing", async () => {
    const page = await startPage();
    try {
      await act(async () => page.controller()?.onFilesSelected([pdf()]));
      const id = page.controller()?.visibleUploadingAttachments[0]?.id ?? "";
      await act(async () => page.controller()?.onRemoveDraftAttachment(id));
      expect(page.controller()?.visibleUploadingAttachments).toEqual([]);
      let conversationId: string | undefined = "unset";
      await act(async () => {
        conversationId = await page.controller()?.sendStagedFiles();
      });
      expect(conversationId).toBeUndefined();
      expect(page.calls).toEqual([]);
    } finally {
      await page.unmount();
    }
  });

  it("stay in the composer when the upload is refused, and go with the next send", async () => {
    // An upload the API refuses leaves no draft attachment to retry in the conversation.
    // ACCEPT-2d: the conversation made for it took nothing and is discarded, so no row named
    // after the refused file is left; the next send makes a new one.
    const page = await startPage({ refusals: 1 });
    try {
      await act(async () => page.controller()?.onFilesSelected([pdf()]));
      let refusal: unknown;
      await act(async () => {
        refusal = await page
          .controller()
          ?.sendStagedFiles()
          .catch((error: unknown) => error);
      });
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal instanceof Error ? refusal.message : "").toBe(
        "Perso.pdf: File type is not allowed"
      );
      expect(page.shown).not.toHaveBeenCalled();
      expect(page.controller()?.visibleUploadingAttachments).toMatchObject([
        { filename: "Perso.pdf", status: "staged" }
      ]);

      let conversationId: string | undefined;
      await act(async () => {
        conversationId = await page.controller()?.sendStagedFiles();
      });
      expect(conversationId).toBe("conv_files");
      expect(page.calls).toEqual([
        "create conversation",
        "upload files of conv_files",
        "discard conv_files",
        "create conversation",
        "upload files of conv_files",
        "list files of conv_files"
      ]);
      expect(page.controller()?.visibleUploadingAttachments).toEqual([]);
    } finally {
      await page.unmount();
    }
  });

  it("stop waiting for processing once the page is gone", async () => {
    const page = await startPage({ processing: true });
    await act(async () => page.controller()?.onFilesSelected([pdf()]));
    let settled = false;
    const sent = page
      .controller()
      ?.sendStagedFiles()
      .then(
        () => (settled = true),
        () => (settled = true)
      );
    await vi.waitFor(() => expect(page.calls).toContain("list files of conv_files"), {
      timeout: CONDITION_WAIT_MS
    });
    await page.unmount();
    await sent;
    expect(settled).toBe(true);
    const lists = page.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(page.calls).toHaveLength(lists);
  });

  it("open the conversation when its files stay in processing too long", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const page = await startPage({ processing: true });
    try {
      await act(async () => page.controller()?.onFilesSelected([pdf()]));
      let refusal: unknown;
      const sent = page
        .controller()
        ?.sendStagedFiles()
        .catch((error: unknown) => {
          refusal = error;
        });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
        await sent;
      });
      expect(refusal instanceof Error ? refusal.message : "").toBe(
        "Wait for file processing to finish before sending."
      );
      // The files are in the conversation, which goes on reading them where it opens.
      expect(page.shown).toHaveBeenCalledWith(expect.objectContaining({ id: "conv_files" }));
    } finally {
      vi.useRealTimers();
      await page.unmount();
    }
  });

  it("take a file a failed send already uploaded out of its conversation when it is removed", async () => {
    const page = await startPage({ refusedFile: "Vertrag.docx" });
    try {
      const docx = new File(["content"], "Vertrag.docx", { type: "application/msword" });
      await act(async () => page.controller()?.onFilesSelected([pdf(), docx]));
      await act(async () => {
        await page
          .controller()
          ?.sendStagedFiles()
          .catch(() => undefined);
      });
      expect(page.controller()?.visibleUploadingAttachments.map((file) => file.filename)).toEqual([
        "Perso.pdf",
        "Vertrag.docx"
      ]);
      const uploadedId =
        page.controller()?.visibleUploadingAttachments.find((file) => file.filename === "Perso.pdf")
          ?.id ?? "";
      await act(async () => page.controller()?.onRemoveDraftAttachment(uploadedId));
      await vi.waitFor(() => expect(page.calls).toContain("remove attachment_Perso.pdf"), {
        timeout: CONDITION_WAIT_MS
      });
    } finally {
      await page.unmount();
    }
  });

  it("leave a failed send's conversation to the message once they are all taken out", async () => {
    // Removing every file after a failed send left that conversation empty, and the text-only
    // message then made a second one.
    const page = await startPage({ refusedFile: "Vertrag.docx" });
    try {
      const docx = new File(["content"], "Vertrag.docx", { type: "application/msword" });
      await act(async () => page.controller()?.onFilesSelected([pdf(), docx]));
      await act(async () => {
        await page
          .controller()
          ?.sendStagedFiles()
          .catch(() => undefined);
      });
      for (const file of page.controller()?.visibleUploadingAttachments ?? []) {
        await act(async () => page.controller()?.onRemoveDraftAttachment(file.id));
      }
      expect(page.controller()?.visibleUploadingAttachments).toEqual([]);
      await vi.waitFor(() => expect(page.calls).toContain("remove attachment_Perso.pdf"), {
        timeout: CONDITION_WAIT_MS
      });

      expect(await page.send()).toBe("conv_files");
      // The text message failed to start: its retry goes to the same conversation.
      expect(await page.send()).toBe("conv_files");
      expect(page.calls.filter((call) => call === "create conversation")).toHaveLength(1);

      // The message was submitted: the next start page makes its own.
      await page.submitted("conv_files");
      expect(await page.send()).toBeUndefined();
    } finally {
      await page.unmount();
    }
  });

  it("keep their conversation for a retry when the message fails to start after the upload", async () => {
    const page = await startPage();
    try {
      await act(async () => page.controller()?.onFilesSelected([pdf()]));
      expect(await page.send()).toBe("conv_files");
      // The message's start failed; the files are in the conversation, the composer is empty.
      expect(page.controller()?.visibleUploadingAttachments).toEqual([]);
      // Another conversation's message says nothing about this one.
      await page.submitted("conv_other");
      expect(await page.send()).toBe("conv_files");
      expect(page.calls.filter((call) => call === "create conversation")).toHaveLength(1);

      await page.submitted("conv_files");
      expect(await page.send()).toBeUndefined();
      expect(page.calls.filter((call) => call === "create conversation")).toHaveLength(1);
    } finally {
      await page.unmount();
    }
  });

  it("let their conversation go once the start page is left for a conversation", async () => {
    // A message that started after its page was gone is never acknowledged on the start page.
    const page = await startPage();
    try {
      await act(async () => page.controller()?.onFilesSelected([pdf()]));
      expect(await page.send()).toBe("conv_files");
      await page.openWorkspace("cw_personal", "conv_files");
      await page.openWorkspace("cw_personal");
      expect(await page.send()).toBeUndefined();
    } finally {
      await page.unmount();
    }
  });

  it.each([
    ["a conversation opens", "cw_personal", "conv_elsewhere"],
    ["another workspace opens", "cw_nordlicht", undefined]
  ] as const)(
    "are not held for the next start page when %s while theirs is made",
    async (_move, workspace, selected) => {
      let answerCreate = () => {};
      const createHeld = new Promise<void>((resolve) => {
        answerCreate = resolve;
      });
      const page = await startPage({ createHeld });
      try {
        await act(async () => page.controller()?.onFilesSelected([pdf()]));
        const sent = page.controller()?.sendStagedFiles();
        await vi.waitFor(() => expect(page.calls).toContain("create conversation"), {
          timeout: CONDITION_WAIT_MS
        });
        await page.openWorkspace(workspace, selected);
        await act(async () => {
          answerCreate();
          await sent;
        });
        await page.openWorkspace(workspace);
        expect(await page.send()).toBeUndefined();
      } finally {
        await page.unmount();
      }
    }
  );

  it("are let go with a failed send's conversation when the person opens another workspace", async () => {
    // Sending again after the switch would put the files in the old workspace's conversation
    // while the composer stands in the new one.
    const page = await startPage({ refusals: 1 });
    try {
      await act(async () => page.controller()?.onFilesSelected([pdf()]));
      await act(async () => {
        await page
          .controller()
          ?.sendStagedFiles()
          .catch(() => undefined);
      });
      expect(page.controller()?.visibleUploadingAttachments).toHaveLength(1);

      await page.openWorkspace("cw_nordlicht");
      expect(page.controller()?.visibleUploadingAttachments).toEqual([]);

      await act(async () => page.controller()?.onFilesSelected([pdf()]));
      await act(async () => {
        await page.controller()?.sendStagedFiles();
      });
      expect(page.calls).toEqual([
        "create conversation",
        "upload files of conv_files",
        "discard conv_files",
        "create conversation",
        "upload files of conv_files",
        "list files of conv_files"
      ]);
    } finally {
      await page.unmount();
    }
  });
});
