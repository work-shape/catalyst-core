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
    authorLabel: undefined
  };
  const others: FollowUpQueueItem = {
    id: "fu_other",
    text: "And add a summary",
    own: false,
    authorLabel: "Anna Berg"
  };

  function model(overrides: Partial<FollowUpQueueModel>): FollowUpQueueModel {
    return {
      items: [own, others],
      phase: "waiting",
      withdrawingIds: new Set(),
      queueing: false,
      dispatching: false,
      error: undefined,
      queue: () => undefined,
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

  function render(value: FollowUpQueueModel | undefined, locale: "en" | "de" = "en"): string {
    return renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
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

  it.each(["en", "de"] as const)("shows B's server label in A's tab in %s", (locale) => {
    const item = followUpQueueItem(fromB, "a");
    expect(item.own).toBe(false);
    const markup = render(model({ items: [item] }), locale);
    expect(markup).toContain(locale === "en" ? "From Bea Berg" : "Von Bea Berg");
    expect(markup).not.toContain('aria-label="Edit"');
  });

  it("keeps B's own tab unchanged when the server includes B's label", () => {
    const item = followUpQueueItem(fromB, "b");
    expect(item.own).toBe(true);
    const markup = render(model({ items: [item] }));
    expect(markup).toContain('aria-label="Edit"');
    expect(markup).toContain('aria-label="Remove"');
    expect(markup).not.toContain("From Bea Berg");
  });

  it.each(["en", "de"] as const)(
    "uses the generic text for an unavailable author in %s",
    (locale) => {
      const item = followUpQueueItem({ ...fromB, authorDisplayLabel: undefined }, "a");
      const markup = render(model({ items: [item] }), locale);
      expect(markup).toContain(
        locale === "en" ? "From another member" : "Von einem anderen Mitglied"
      );
      expect(markup).not.toContain("Bea Berg");
    }
  );

  it("lists the queued messages oldest first while the run goes", () => {
    const markup = render(model({}));
    expect(markup).toContain('aria-label="Queued messages"');
    expect(markup).toContain("Queued");
    expect(markup).toContain("Sends after the current answer.");
    expect(markup.indexOf(own.text)).toBeLessThan(markup.indexOf(others.text));
    expect(markup).not.toContain("Send now");
  });

  it("offers Edit and Remove only on the reader's own message and names the other author", () => {
    const markup = render(model({ items: [others] }));
    expect(markup).toContain("From Anna Berg");
    expect(markup).not.toContain('aria-label="Edit"');
    expect(markup).not.toContain('aria-label="Remove"');

    const ownMarkup = render(model({ items: [own] }));
    expect(ownMarkup).toContain('aria-label="Edit"');
    expect(ownMarkup).toContain('aria-label="Remove"');
  });

  it("says the queue is paused after a stop, with Send now and Discard", () => {
    const markup = render(model({ phase: "paused" }));
    expect(markup).toContain("Queue paused");
    // The run's own notice says why. The queue says what restarts it: a message sent now runs
    // first, and the queue goes on after its answer.
    expect(markup).toContain("Continues after the next message is answered.");
    expect(markup).not.toContain("Sends after the current answer.");
    expect(markup).toContain("Send now");
    expect(markup).toContain("Discard");
    // The oldest message is the reader's own; the other one's row only names its author.
    expect(markup).toContain("From Anna Berg");
    expect(markup).not.toContain("Only they can send it now.");
  });

  it("offers Send now only to the author of the oldest message, and Discard to an author", () => {
    const othersOnly = render(model({ items: [others], phase: "paused" }));
    expect(othersOnly).toContain("Queue paused");
    expect(othersOnly).not.toContain("Send now");
    expect(othersOnly).not.toContain("Discard");

    const othersFirst = render(model({ items: [others, own], phase: "paused" }));
    expect(othersFirst).not.toContain("Send now");
    expect(othersFirst).toContain("Discard");
    // Where Send now is not offered, the oldest row says why.
    for (const markup of [othersOnly, othersFirst]) {
      expect(markup).toContain("From Anna Berg · Only they can send it now.");
    }
    expect(render(model({ items: [others] }))).not.toContain("Only they can send it now.");
  });

  it("reads in German", () => {
    const markup = render(model({ phase: "paused" }), "de");
    expect(markup).toContain("Warteschlange angehalten");
    expect(markup).toContain("Geht nach der nächsten Antwort weiter.");
    expect(markup).toContain("Jetzt senden");
    expect(markup).toContain("Von Anna Berg");
    expect(render(model({ items: [others], phase: "paused" }), "de")).toContain(
      "Von Anna Berg · Nur dieses Mitglied kann sie jetzt senden."
    );
  });

  it("shows nothing while the queue is empty, and an error where the reader acted", () => {
    expect(render(model({ items: [] }))).toBe("");
    expect(render(undefined)).toBe("");
    const failed = render(model({ items: [], error: "The message could not be queued." }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("The message could not be queued.");
  });
});
