import { describe, expect, it } from "vitest";
import { createElement } from "react";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { QueryClient } from "@tanstack/react-query";
import {
  INBOX_API_BASE_URL,
  InboxList,
  item,
  now,
  render,
  renderItem
} from "./chat-ui-inbox-harness";

// NOTIFY-a: a notice in its reader's Inbox reads as its title and paragraph, leads to the run
// or the App it names, and asks for nothing but "mark handled".

const notice = (preview: ApprovalRequestView["preview"]) => ({
  kind: "notice",
  summary: "Buchhaltungscheck 2026-09",
  origin: undefined,
  requestedBy: { id: "sp_monthly", displayLabel: "Monatscheck" },
  addresseeUserId: "user-ada",
  canDecide: true,
  preview
});

const appNotice = {
  title: "Buchhaltungscheck 2026-09",
  text: "12 Auffälligkeiten in 3 Mandanten.",
  link: { kind: "app", workspaceId: "cws_team", app: "findings" }
};

describe("inbox item of a notice", () => {
  it("shows the title, the paragraph and the App it leads to, with one answer", () => {
    const markup = renderItem(notice(appNotice));

    expect(markup).toMatch(/<h3[^>]*>Buchhaltungscheck 2026-09<\/h3>/u);
    expect(markup).toContain("12 Auffälligkeiten in 3 Mandanten.");
    expect(markup).toMatch(/href="\/w\/cws_team\/apps\/findings"[^>]*>App öffnen<\/a>/u);
    expect(markup).toMatch(/data-decision="approve"[^>]*>Als erledigt markieren<\/button>/u);
    expect(markup.match(/data-decision=/gu)).toHaveLength(1);
    // Nothing to explain: no comment field.
    expect(markup).not.toContain("<textarea");
    expect(renderItem(notice(appNotice), { locale: "en" })).toMatch(
      /data-decision="approve"[^>]*>Mark handled<\/button>/u
    );
  });

  it("leads to the run it is about", () => {
    const markup = renderItem(
      notice({
        ...appNotice,
        link: { kind: "workflow_run", workspaceId: "cws_team", workflowId: "wf_1", runId: "wfr_1" }
      }),
      { locale: "en" }
    );
    expect(markup).toMatch(
      /href="\/w\/cws_team\/workflows\/wf_1\/runs\/wfr_1"[^>]*>Open the run<\/a>/u
    );
  });

  // LU-6: the reader of a run's notice may tell the Workflow's builders about the result, once.
  describe("feedback on the result", () => {
    const runNotice = {
      ...notice({
        ...appNotice,
        link: { kind: "workflow_run", workspaceId: "cws_team", workflowId: "wf_1", runId: "wfr_1" }
      }),
      id: "apr_notice"
    };
    const host = (resultFeedback: boolean) => ({
      currentUserId: "user-ada",
      personalWorkspaceAgentName: () => undefined,
      startRevision: () => undefined,
      agentDisplayName: () => undefined,
      openConversation: () => undefined,
      resultFeedback
    });
    /** The reader's own comment on the run, as the notice read it. */
    const read = (own: Record<string, unknown> | null) => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(["feedback", "result", INBOX_API_BASE_URL, "apr_notice"], own);
      return queryClient;
    };

    it("is offered once the reader's comment is known to be none, and only with the module on", () => {
      const offered = renderItem(runNotice, {
        locale: "en",
        host: host(true),
        queryClient: read(null)
      });
      expect(offered).toMatch(
        /data-testid="result-feedback-action"[^>]*>.*Feedback on this result/u
      );
      // Until the comment is read nothing is offered, and nothing with the module off.
      expect(renderItem(runNotice, { locale: "en", host: host(true) })).not.toContain(
        "result-feedback"
      );
      expect(
        renderItem(runNotice, { locale: "en", host: host(false), queryClient: read(null) })
      ).not.toContain("result-feedback");
      // A notice that leads to an App has no run to comment on.
      expect(
        renderItem(
          { ...notice(appNotice), id: "apr_notice" },
          { locale: "en", host: host(true), queryClient: read(null) }
        )
      ).not.toContain("result-feedback");
    });

    it("says the state of the comment once sent, in German", () => {
      const own = {
        id: "fb_1",
        state: "handled",
        text: "Der Kontoauszug war doch da.",
        includesExchange: false,
        createdAt: "2026-10-29T10:00:00.000Z"
      };
      const markup = renderItem(runNotice, { host: host(true), queryClient: read(own) });
      expect(markup).toMatch(/data-feedback-state="handled"[^>]*>.*Feedback erledigt/u);
      expect(markup).not.toContain("result-feedback-action");
      // The comment is the reader's own; the notice does not show it back.
      expect(markup).not.toContain("Der Kontoauszug war doch da.");
    });
  });

  it("offers no answer once handled, and no link where it names none", () => {
    const markup = renderItem({
      ...notice({ title: appNotice.title, text: appNotice.text }),
      status: "approved",
      canDecide: false
    });
    expect(markup).toContain("12 Auffälligkeiten in 3 Mandanten.");
    expect(markup).not.toContain("data-decision=");
    expect(markup).not.toContain("href=");
  });

  it.each([
    ["de", "Erledigt"],
    ["en", "Done"]
  ] as const)("labels a handled notice neutrally in the item and list (%s)", (locale, label) => {
    const handled: Partial<ApprovalRequestView> = {
      ...notice(appNotice),
      status: "approved",
      canDecide: false
    };
    const markup = renderItem(handled, { locale });
    const list = render(
      createElement(InboxList, {
        tab: "decided",
        state: { status: "ready", items: [item(handled)] },
        now,
        onOpenItem: () => undefined
      }),
      locale
    );
    for (const html of [markup, list]) {
      expect(html).toContain(`>${label}</span>`);
      expect(html).not.toContain("bg-success-soft");
      expect(html).not.toMatch(/>(Approved|Genehmigt)<\/span>/u);
    }
  });

  it("names the row by its kind and title", () => {
    const markup = render(
      createElement(InboxList, {
        tab: "to_decide",
        state: { status: "ready", items: [item(notice(appNotice))] },
        now,
        onOpenItem: () => undefined
      }),
      "en"
    );
    expect(markup).toContain("Buchhaltungscheck 2026-09");
    expect(markup).toContain("lucide-bell");
  });
});
