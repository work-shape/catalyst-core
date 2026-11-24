import {
  QueryClient,
  QueryObserver,
  environmentManager,
  focusManager
} from "@tanstack/react-query";
import { ApiError, type DraftAttachment } from "@work-shape/catalyst-api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachedFilesTitle,
  draftAttachmentPolling,
  uploadErrorMessage,
  uploadFileWithRetry,
  isAbandonedDraftConversation,
  terminalRunNotice
} from "./support/chat-ui";
import { createTranslationContext } from "./support/chat-ui/shared";

const file = () => new File(["content"], "Perso.pdf", { type: "application/pdf" });
const { t } = createTranslationContext("de");

describe("draft attachment upload", () => {
  it("retries an upload the gateway gave up on, with the file already read", async () => {
    const received: File[] = [];
    const result = await uploadFileWithRetry(
      file(),
      async (readFile) => {
        received.push(readFile);
        if (received.length < 3) {
          throw new ApiError(502, "API request failed", undefined);
        }
        return "stored";
      },
      0
    );

    expect(result).toBe("stored");
    expect(received).toHaveLength(3);
    expect(received[0]?.name).toBe("Perso.pdf");
    expect(received[0]?.type).toBe("application/pdf");
    expect(await received[0]?.text()).toBe("content");
  });

  it("waits as long as a rate-limited answer says and then stores the file", async () => {
    const waits: number[] = [];
    let calls = 0;
    const limited = new ApiError(429, "Too many requests. Try again later.", {
      error: { code: "RATE_LIMITED", details: { retryAfterSeconds: 17 } }
    });
    const result = await uploadFileWithRetry(
      file(),
      async () => {
        calls += 1;
        // More refusals than the attempts a gateway failure gets.
        if (calls <= 4) {
          throw limited;
        }
        return "stored";
      },
      0,
      async (ms) => {
        waits.push(ms);
      }
    );

    expect(result).toBe("stored");
    expect(waits).toEqual([17000, 17000, 17000, 17000]);

    // An instance that never lets the file through is not waited on for ever.
    waits.length = 0;
    await expect(
      uploadFileWithRetry(
        file(),
        () => Promise.reject(limited),
        0,
        async (ms) => {
          waits.push(ms);
        }
      )
    ).rejects.toBe(limited);
    expect(waits).toHaveLength(5);
  });

  it("does not retry an answer from the API", async () => {
    let calls = 0;
    const rejected = new ApiError(400, "File exceeds the configured upload size limit", undefined);
    await expect(
      uploadFileWithRetry(
        file(),
        async () => {
          calls += 1;
          throw rejected;
        },
        0
      )
    ).rejects.toBe(rejected);

    expect(calls).toBe(1);
    expect(uploadErrorMessage(rejected, "Perso.pdf", t)).toBe(
      "Perso.pdf: File exceeds the configured upload size limit"
    );
  });

  it("names the file when the upload keeps failing or the file cannot be read", async () => {
    const gatewayFailure = new ApiError(502, "API request failed", undefined);
    expect(uploadErrorMessage(gatewayFailure, "Perso.pdf", t)).toContain("„Perso.pdf“");

    const unreadable = file();
    unreadable.arrayBuffer = () => Promise.reject(new DOMException("gone", "NotReadableError"));
    let calls = 0;
    const error = await uploadFileWithRetry(unreadable, async () => (calls += 1), 0).catch(
      (caught: unknown) => caught
    );

    expect(calls).toBe(0);
    expect(uploadErrorMessage(error, "Perso.pdf", t)).toContain("nicht gelesen werden");
  });
});

describe("abandoned draft conversation", () => {
  const emptied = {
    conversationId: "conv_draft",
    selectedConversationId: "conv_draft",
    messagesLoaded: true,
    messageCount: 0,
    running: false
  };

  it("names a conversation of attached files in the person's language until the title job does", () => {
    // ACCEPT-1c C8: a German conversation started with files was called "2 attached files".
    const two = [file(), file()];
    expect(attachedFilesTitle(two, "de")).toBe("2 angehängte Dateien");
    expect(attachedFilesTitle([file()], "de")).toBe("Perso.pdf");
  });

  it("returns to the start page only when the open conversation holds nothing", () => {
    expect(isAbandonedDraftConversation(emptied)).toBe(true);
    expect(isAbandonedDraftConversation({ ...emptied, messageCount: 2 })).toBe(false);
    expect(isAbandonedDraftConversation({ ...emptied, running: true })).toBe(false);
    expect(isAbandonedDraftConversation({ ...emptied, selectedConversationId: "conv_other" })).toBe(
      false
    );
  });
});

describe("the notice of a run that ended as failed or cancelled", () => {
  const en = createTranslationContext("en").t;
  const interrupted = {
    class: "run_failed" as const,
    message: "Written for operators",
    category: "runtime_interrupted"
  };
  const stillInterrupted = "The reply was interrupted. Please send your message again.";

  it("names a stopped or interrupted reply, never by the reason code or the worker's words", () => {
    const cancelled = { class: "run_cancelled" as const, message: "user_requested" };
    expect(terminalRunNotice(cancelled, en)).toBe("The reply was stopped.");

    const notStarted = { ...interrupted, code: "AGENT_RUN_NOT_STARTED" };
    expect(terminalRunNotice(notStarted, en)).toContain("could not be started");
    // A platform failure names no administrator to fix it (PLATFORM-REPORT).
    expect(terminalRunNotice(notStarted, en)).not.toMatch(/administrator/iu);
    expect(terminalRunNotice({ ...interrupted, code: "AGENT_RUN_WORKER_LOST" }, en)).toBe(
      stillInterrupted
    );
    for (const category of ["internal_error", "abort_error", "unknown_error"]) {
      const failed = { class: "run_failed" as const, message: "Agent run failed", category };
      expect(terminalRunNotice(failed, en)).toBe(stillInterrupted);
    }
  });

  it("says which tool a reply that stood still waited on, naming no worker", () => {
    const notTaken = {
      ...interrupted,
      code: "AGENT_RUN_COMMAND_NOT_TAKEN",
      tool: "workspace.exec"
    };
    const silent = { ...interrupted, code: "AGENT_RUN_TOOL_SILENT", tool: "web.fetch" };
    expect(terminalRunNotice(notTaken, en)).toContain("not of your input");
    expect(terminalRunNotice(silent, en)).toContain("web.fetch");
    for (const error of [notTaken, silent]) {
      expect(terminalRunNotice(error, en)).not.toMatch(/worker/iu);
    }
    expect(terminalRunNotice({ ...interrupted, code: "AGENT_RUN_IDLE" }, en)).toBe(
      stillInterrupted
    );
  });

  it("names the rate card about an unpriced model only to a reader who sees it", () => {
    const notPriced = {
      class: "run_failed" as const,
      message: "The model has no price on the rate card",
      category: "app_error",
      code: "MODEL_NOT_PRICED"
    };
    expect(terminalRunNotice(notPriced, en)).not.toContain("rate card");
    expect(terminalRunNotice(notPriced, en, { seesRateCard: true })).toContain("rate card");
  });

  it("shows the message of any other failure, and nothing for an error that ended no run", () => {
    const failed = { ...interrupted, message: "Budget is used up", category: "app_error" };
    expect(terminalRunNotice(failed, en)).toBe("Budget is used up");
    expect(terminalRunNotice({ class: "send_failed", message: "Offline" }, en)).toBeUndefined();
    expect(terminalRunNotice(undefined, en)).toBeUndefined();
  });
});

type DraftAttachmentStatus = DraftAttachment["status"];

/** The composer's read of the draft attachments, with the instance answering from `answers`. */
function observeDraftAttachments(answers: DraftAttachmentStatus[]) {
  const read = vi.fn((): Promise<DraftAttachment[]> =>
    Promise.resolve([
      {
        id: "att_1",
        conversationId: "conv_1",
        fileId: "file_1",
        filename: "Perso.pdf",
        byteSize: 7,
        status: answers.shift() ?? "ready",
        artifactRefs: {},
        processingMetadata: {},
        warnings: [],
        createdAt: "2026-10-12T08:00:00.000Z",
        updatedAt: "2026-10-12T08:00:00.000Z"
      }
    ])
  );
  const client = new QueryClient();
  // As the provider does: from here the cache hears the page come back.
  client.mount();
  const observer = new QueryObserver(client, {
    queryKey: ["draft-attachments"],
    queryFn: read,
    ...draftAttachmentPolling
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return {
    read,
    status: () => observer.getCurrentResult().data?.[0]?.status,
    close: () => {
      unsubscribe();
      client.unmount();
      client.clear();
    }
  };
}

describe("draft attachment polling", () => {
  const page = { visibilityState: "hidden" };

  beforeEach(() => {
    vi.useFakeTimers();
    // The tests run without a browser: the page is a stub, and the library is told it is in one.
    page.visibilityState = "hidden";
    vi.stubGlobal("document", page);
    environmentManager.setIsServer(() => false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("learns that a file is ready while the page is hidden", async () => {
    const composer = observeDraftAttachments(["queued", "preprocessing", "ready"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(composer.status()).toBe("queued");

    await vi.advanceTimersByTimeAsync(1000);
    expect(composer.status()).toBe("preprocessing");
    await vi.advanceTimersByTimeAsync(1000);
    expect(composer.status()).toBe("ready");

    // Nothing is processed any more, so nothing is asked.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(composer.read).toHaveBeenCalledTimes(3);
    composer.close();
  });

  it("reads the list again when the page comes back", async () => {
    const composer = observeDraftAttachments(["ready", "failed"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(composer.read).toHaveBeenCalledTimes(1);

    page.visibilityState = "visible";
    focusManager.onFocus();
    await vi.advanceTimersByTimeAsync(0);
    expect(composer.status()).toBe("failed");
    composer.close();
  });
});
