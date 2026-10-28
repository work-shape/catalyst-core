// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import JSZip from "jszip";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { TranslationProvider } from "./chat-ui-render-harness";
import { useDraftAttachmentController } from "./support/chat-ui";

// A .zip handed to the composer of a project's chat is unpacked into a folder of the project
// (projects spec, section 5); in a chat without a project it stays one attached file.

const createdAt = "2026-10-28T09:00:00.000Z";
const attachment = {
  id: "attachment_1",
  conversationId: "conv_1",
  fileId: "file_1",
  filename: "Angebote.zip",
  mimeType: "application/zip",
  byteSize: 7,
  status: "ready",
  artifactRefs: {},
  processingMetadata: {},
  warnings: [],
  createdAt,
  updatedAt: createdAt
};
const view = (maxFileBytes: number, taken: string[] = []) => ({
  items: taken.map((path) => ({
    path,
    version: 2,
    byteSize: 1,
    mimeType: "text/plain",
    origin: "upload",
    updatedAt: createdAt
  })),
  usage: { files: taken.length, bytes: taken.length },
  limits: { maxFiles: 50, maxFileBytes, maxProjectBytes: 1_000_000, versionsPerFile: 20 }
});

async function startChat(
  chat: { projectId?: string; maxFileBytes?: number; taken?: string[]; confirm?: boolean } = {}
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const confirm = vi.fn(() => chat.confirm ?? true);
  vi.stubGlobal("confirm", confirm);
  vi.stubGlobal("window", Object.assign(globalThis.window ?? {}, { confirm }));
  const calls: string[] = [];
  const client = createApiClient({
    baseUrl: "https://chat.example.com",
    fetchImpl: async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      const method = (request instanceof Request ? request.method : init?.method) ?? "GET";
      if (url.pathname.includes("/project-files/")) {
        if (method === "GET") {
          calls.push("list project files");
          return Response.json(view(chat.maxFileBytes ?? 1_000_000, chat.taken));
        }
        const path = url.searchParams.get("path") ?? "";
        const replaces = url.searchParams.get("replaces");
        calls.push(`project file ${path}${replaces ? ` replaces v${replaces}` : ""}`);
        return Response.json({ path, version: 1, change: "created" });
      }
      if (method === "POST") {
        const sent = init?.body instanceof FormData ? init.body.get("file") : null;
        const filename = sent instanceof File ? sent.name : "";
        calls.push(`attach ${filename}`);
        const taken = { ...attachment, filename };
        return Response.json({ attachment: taken, attachments: [taken], outcome: "created" });
      }
      return Response.json({ items: [] });
    }
  });
  const errors: string[] = [];
  let controller: ReturnType<typeof useDraftAttachmentController> | undefined;
  function Probe() {
    controller = useDraftAttachmentController({
      enabled: true,
      apiBaseUrl: "https://chat.example.com",
      authScope: "composer-zip-test",
      client,
      selectedConversationId: "conv_1",
      ...(chat.projectId ? { projectId: chat.projectId } : {}),
      collaborationWorkspaceId: "cw_1",
      isAuthenticated: true,
      createConversationForFiles: () => Promise.reject(new Error("no conversation is made")),
      showConversationForFiles: () => undefined,
      onError: (message) => errors.push(message)
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(TranslationProvider, { locale: "de", children: createElement(Probe) })
      )
    );
  });
  return {
    calls,
    errors,
    confirm,
    /** Picks the files and waits until the composer has nothing left to upload. */
    choose: async (files: File[]) => {
      await act(async () => controller?.onFilesSelected(files));
      await vi.waitFor(() => expect(controller?.visibleUploadingAttachments).toEqual([]));
    },
    uploading: () => controller?.visibleUploadingAttachments ?? [],
    unmount: () => act(() => root.unmount())
  };
}

async function archive(
  name: string,
  entries: Record<string, string>,
  options: { declared?: number } = {}
): Promise<File> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) {
    zip.file(path, content, { compression: "DEFLATE" });
  }
  const bytes = await zip.generateAsync({ type: "uint8array" });
  if (options.declared !== undefined) {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at < bytes.length - 4; at += 1) {
      if (data.getUint32(at, true) === 0x04034b50) data.setUint32(at + 22, options.declared, true);
      if (data.getUint32(at, true) === 0x02014b50) data.setUint32(at + 24, options.declared, true);
    }
  }
  const copy = new ArrayBuffer(bytes.length);
  new Uint8Array(copy).set(bytes);
  return new File([copy], name, { type: "application/zip" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a .zip in the composer of a project's chat", () => {
  it("lands as a folder of the project, and attaches nothing", async () => {
    const chat = await startChat({ projectId: "prj_1" });
    try {
      await chat.choose([
        await archive("Angebote.zip", { "a.md": "hello", "sub/b.csv": "1,2", ".DS_Store": "x" })
      ]);
      expect(chat.calls.sort()).toEqual([
        "list project files",
        "project file Angebote/a.md",
        "project file Angebote/sub/b.csv"
      ]);
      expect(chat.errors).toEqual([]);
      expect(chat.uploading()).toEqual([]);
    } finally {
      await chat.unmount();
    }
  });

  it("takes the other files of the same drop as attachments, as before", async () => {
    const chat = await startChat({ projectId: "prj_1" });
    try {
      await chat.choose([
        await archive("Angebote.zip", { "a.md": "hello" }),
        new File(["pdf"], "Perso.pdf", { type: "application/pdf" })
      ]);
      expect(chat.calls.sort()).toEqual([
        "attach Perso.pdf",
        "list project files",
        "project file Angebote/a.md"
      ]);
    } finally {
      await chat.unmount();
    }
  });

  it("asks before it replaces files of the project, and keeps them when declined", async () => {
    const declined = await startChat({
      projectId: "prj_1",
      taken: ["Angebote/a.md"],
      confirm: false
    });
    try {
      await declined.choose([await archive("Angebote.zip", { "a.md": "hello" })]);
      expect(declined.confirm).toHaveBeenCalledOnce();
      expect(declined.calls).toEqual(["list project files"]);
    } finally {
      await declined.unmount();
    }
    const agreed = await startChat({ projectId: "prj_1", taken: ["Angebote/a.md"] });
    try {
      await agreed.choose([await archive("Angebote.zip", { "a.md": "hello" })]);
      expect(agreed.calls).toEqual([
        "list project files",
        "project file Angebote/a.md replaces v2"
      ]);
    } finally {
      await agreed.unmount();
    }
  });

  it("is stopped at the cap when its entries are larger than they declare, sending nothing", async () => {
    const chat = await startChat({ projectId: "prj_1", maxFileBytes: 100 });
    try {
      await chat.choose([
        await archive("Bombe.zip", { "a.txt": "x".repeat(50_000) }, { declared: 3 })
      ]);
      expect(chat.calls).toEqual(["list project files"]);
      expect(chat.errors).toEqual([
        "a.txt ist größer, als eine Projektdatei sein darf (100 Byte)."
      ]);
      expect(chat.uploading()).toEqual([]);
    } finally {
      await chat.unmount();
    }
  });

  it("is refused with a plain sentence when an entry climbs out of its folder", async () => {
    const chat = await startChat({ projectId: "prj_1" });
    try {
      await chat.choose([await archive("Boese.zip", { "ok.txt": "ok", "../evil.txt": "bad" })]);
      expect(chat.calls).toEqual(["list project files"]);
      expect(chat.errors).toEqual([
        "Boese.zip wurde nicht entpackt: Es enthält Pfade, die mit .. aus dem Ordner herausführen."
      ]);
    } finally {
      await chat.unmount();
    }
  });
});

describe("a .zip in the composer of a chat without a project", () => {
  it("is attached as one file, unopened", async () => {
    const chat = await startChat();
    try {
      await chat.choose([await archive("Angebote.zip", { "a.md": "hello" })]);
      expect(chat.calls).toEqual(["attach Angebote.zip"]);
    } finally {
      await chat.unmount();
    }
  });
});
