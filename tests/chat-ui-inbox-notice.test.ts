import { describe, expect, it } from "vitest";
import { createElement } from "react";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { InboxList, item, now, render, renderItem } from "./chat-ui-inbox-harness";

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
