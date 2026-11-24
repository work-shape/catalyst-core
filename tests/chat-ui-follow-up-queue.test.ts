import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  FollowUpQueue,
  FollowUpQueueProvider,
  type FollowUpQueueModel
} from "@work-shape/catalyst-chat-ui/follow-up-queue";
import {
  composerTextAfterEdit,
  followUpDispatchReread,
  followUpQueueItem,
  followUpQueuePhase,
  isFollowUpDispatchOverdue,
  type FollowUpQueueItem
} from "@work-shape/catalyst-chat-ui/follow-up-queue-state";
import type { ConversationFollowUp } from "@work-shape/catalyst-api-client";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

describe("follow-up queue phase", () => {
  it("waits while the run goes, a decision pending included", () => {
    for (const runStatus of ["queued", "running", "waiting_for_decision", "cancelling"] as const) {
      expect(followUpQueuePhase({ runStatus, sentNow: false, dispatchOverdue: true })).toBe(
        "waiting"
      );
    }
  });

  it("pauses after a failed or stopped run", () => {
    expect(
      followUpQueuePhase({ runStatus: "failed", sentNow: false, dispatchOverdue: false })
    ).toBe("paused");
    expect(
      followUpQueuePhase({ runStatus: "cancelled", sentNow: false, dispatchOverdue: false })
    ).toBe("paused");
  });

  it("sends again once Send now is accepted, though the thread still names the stopped run", () => {
    // The server starts the run a moment after it answers; the first re-read may come before.
    expect(
      followUpQueuePhase({ runStatus: "cancelled", sentNow: true, dispatchOverdue: false })
    ).toBe("sending");
    expect(
      followUpQueuePhase({ runStatus: "cancelled", sentNow: true, dispatchOverdue: true })
    ).toBe("paused");
  });

  it("sends after a completed run until the re-reads are spent, then pauses", () => {
    expect(
      followUpQueuePhase({ runStatus: "completed", sentNow: false, dispatchOverdue: false })
    ).toBe("sending");
    expect(
      followUpQueuePhase({ runStatus: undefined, sentNow: false, dispatchOverdue: false })
    ).toBe("sending");
    expect(
      followUpQueuePhase({ runStatus: undefined, sentNow: false, dispatchOverdue: true })
    ).toBe("paused");
  });
});

describe("follow-up dispatch re-reads", () => {
  it("reads the thread again a bounded few times while the next message should start", () => {
    const delays = [0, 1, 2, 3, 4].map(
      (attempts) =>
        followUpDispatchReread({ phase: "sending", nextFollowUpId: "fu_1", attempts })?.delayMs
    );
    expect(delays).toEqual([500, 1_500, 3_000, 6_000, undefined]);
    expect(
      followUpDispatchReread({ phase: "waiting", nextFollowUpId: "fu_1", attempts: 0 })
    ).toBeUndefined();
    expect(
      followUpDispatchReread({ phase: "sending", nextFollowUpId: undefined, attempts: 0 })
    ).toBeUndefined();
  });

  it("counts as overdue only for the message the spent re-reads waited on", () => {
    const rereads = { followUpId: "fu_1", attempts: 4 };
    expect(isFollowUpDispatchOverdue({ nextFollowUpId: "fu_1", rereads })).toBe(true);
    // The first one started: the next one gets re-reads of its own.
    expect(isFollowUpDispatchOverdue({ nextFollowUpId: "fu_2", rereads })).toBe(false);
    expect(
      isFollowUpDispatchOverdue({ nextFollowUpId: "fu_1", rereads: { ...rereads, attempts: 3 } })
    ).toBe(false);
  });
});

describe("edit takes a queued message back into the composer", () => {
  it("fills an empty field and keeps what is already typed after it", () => {
    expect(composerTextAfterEdit("", "Queued text")).toBe("Queued text");
    expect(composerTextAfterEdit("  \n", "Queued text")).toBe("Queued text");
    expect(composerTextAfterEdit("New draft", "Queued text")).toBe("Queued text\n\nNew draft");
  });
});

describe("follow-up queue above the composer", () => {
  const own: FollowUpQueueItem = {
    id: "fu_own",
    text: "Also check the March numbers",
    own: true,
    authorLabel: undefined,
    steering: false,
    attachments: []
  };
  const others: FollowUpQueueItem = {
    id: "fu_other",
    text: "And add a summary",
    own: false,
    authorLabel: "Anna Berg",
    steering: false,
    attachments: []
  };

  function model(overrides: Partial<FollowUpQueueModel>): FollowUpQueueModel {
    return {
      items: [own, others],
      mode: "queue",
      ownRun: true,
      phase: "waiting",
      withdrawingIds: new Set(),
      queueing: false,
      dispatching: false,
      error: undefined,
      queue: () => undefined,
      steer: () => undefined,
      withdraw: () => undefined,
      discardOwn: () => undefined,
      sendNow: () => undefined,
      ...overrides
    };
  }

  function Runtime({ children }: { children: ReactNode }) {
    const runtime = useLocalRuntime({
      async run() {
        return { content: [] };
      }
    });
    return createElement(AssistantRuntimeProvider, { runtime }, children);
  }

  function render(value: FollowUpQueueModel | undefined): string {
    return renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(
          Runtime,
          null,
          createElement(FollowUpQueueProvider, { value, children: createElement(FollowUpQueue) })
        )
      )
    );
  }

  const fromB: ConversationFollowUp = {
    id: "fu_b",
    clientInstanceId: "test",
    conversationId: "shared",
    authorUserId: "b",
    authorDisplayLabel: "Bea Berg",
    text: "A follow-up from B",
    mode: "queue",
    status: "pending",
    position: 1,
    agentName: "test",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z"
  };

  it("names the files of a queued message, and a message of files alone by them", () => {
    const item = followUpQueueItem(
      {
        ...fromB,
        authorUserId: "a",
        attachments: [
          { fileId: "file_1", filename: "screen.png", mimeType: "image/png", byteSize: 70 }
        ]
      },
      "a",
      undefined
    );
    expect(item.attachments).toEqual([
      { fileId: "file_1", filename: "screen.png", mimeType: "image/png" }
    ]);
    expect(render(model({ items: [item] }))).toContain("screen.png");
    expect(render(model({ items: [{ ...item, text: "" }] }))).toContain('title="screen.png"');
  });

  it("names another member's message by the server's label, and offers Edit and Remove only on one's own", () => {
    const fromOther = followUpQueueItem(fromB, "a", undefined);
    expect(fromOther.own).toBe(false);
    const markup = render(model({ items: [fromOther] }));
    expect(markup).toContain("Bea Berg");
    expect(markup).not.toContain('aria-label="Edit"');
    expect(markup).not.toContain('aria-label="Remove"');

    const unknown = followUpQueueItem({ ...fromB, authorDisplayLabel: undefined }, "a", undefined);
    expect(render(model({ items: [unknown] }))).not.toContain("Bea Berg");

    const ownItem = followUpQueueItem(fromB, "b", undefined);
    expect(ownItem.own).toBe(true);
    const ownMarkup = render(model({ items: [ownItem] }));
    expect(ownMarkup).toContain('aria-label="Edit"');
    expect(ownMarkup).toContain('aria-label="Remove"');
    expect(ownMarkup).not.toContain("Bea Berg");
  });

  it("steers only while the run it was sent into goes", () => {
    const steer = { ...fromB, mode: "steer" as const, dispatchedRunId: "run_live" };
    expect(followUpQueueItem(steer, "b", "run_live").steering).toBe(true);
    expect(followUpQueueItem(steer, "b", undefined).steering).toBe(false);
    expect(followUpQueueItem(steer, "b", "run_next").steering).toBe(false);
  });

  it("offers Steer now on the reader's queued message in their own run only", () => {
    const steerNow = />Steer now</u;
    expect(render(model({}))).toMatch(steerNow);
    // Not in someone else's run, not while the queue stands still, not on a steer already.
    expect(render(model({ ownRun: false }))).not.toMatch(steerNow);
    expect(render(model({ phase: "paused" }))).not.toMatch(steerNow);
    expect(render(model({ items: [{ ...own, steering: true }] }))).not.toMatch(steerNow);
  });

  it("offers Send now only to the author of the oldest message once paused, and Discard to an author", () => {
    expect(render(model({}))).not.toContain("Send now");
    const ownFirst = render(model({ phase: "paused" }));
    expect(ownFirst).toContain("Send now");
    expect(ownFirst).toContain("Discard");

    const othersOnly = render(model({ items: [others], phase: "paused" }));
    expect(othersOnly).not.toContain("Send now");
    expect(othersOnly).not.toContain("Discard");

    const othersFirst = render(model({ items: [others, own], phase: "paused" }));
    expect(othersFirst).not.toContain("Send now");
    expect(othersFirst).toContain("Discard");
  });

  it("shows nothing while the queue is empty, and an error where the reader acted", () => {
    expect(render(model({ items: [] }))).toBe("");
    expect(render(undefined)).toBe("");
    const failed = render(model({ items: [], error: "The message could not be queued." }));
    expect(failed).toContain('role="alert"');
  });
});
