import { describe, expect, it } from "vitest";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { item, renderItem } from "./chat-ui-inbox-harness";
import { filterInboxItems, inboxFilterOptions, inboxItemKinds } from "./support/chat-ui";

// LU-4: a comment on an agent's answer in its reviewer's Inbox reads as the agent, its
// revision, who wrote it and when, the comment and the exchange where it was sent along. Its one
// answer is "mark handled", and the Inbox filters it by agent.

const feedback = (
  agent: string,
  preview: Record<string, unknown> = {}
): Partial<ApprovalRequestView> => ({
  id: `apr_${agent}`,
  kind: "feedback_review",
  summary: `Feedback on the agent '${agent}'`,
  origin: undefined,
  requestedBy: { id: "user-kai", displayLabel: "Kai" },
  canDecide: true,
  preview: {
    feedbackId: `fb_${agent}`,
    agent: { name: agent, displayName: `${agent} display`, revision: 4 },
    text: "The answer forgot the land register extract.",
    gone: false,
    ...preview
  }
});

describe("inbox item of feedback", () => {
  it("names the agent, its revision and the author, and offers to mark it handled", () => {
    const markup = renderItem(
      feedback("loans", {
        exchange: { question: "Which documents?", answer: "The payslips." }
      }),
      { locale: "en" }
    );
    expect(markup).toMatch(/<h3[^>]*>Feedback on loans display<\/h3>/u);
    expect(markup).toContain("From Kai, ");
    expect(markup).toContain("Version 4");
    expect(markup).toContain("The answer forgot the land register extract.");
    expect(markup).toContain("The exchange");
    expect(markup).toContain('href="/build/agents/loans"');
    expect(markup).toContain(">Open<");
    expect(markup).toContain("Mark handled");
    expect(markup).not.toContain("Awaiting approval");
    expect(markup).not.toContain("Reject");
  });

  it("says so where the author left the exchange out, in German", () => {
    const markup = renderItem(feedback("loans"), { locale: "de" });
    expect(markup).toContain("Feedback zu loans display");
    expect(markup).toContain("Von Kai, ");
    expect(markup).toContain("Die Person hat ihre Frage und die Antwort nicht mitgeschickt.");
    expect(markup).toContain("Als erledigt markieren");
    expect(markup).toContain(">Offen<");
  });

  it("reads as done once handled", () => {
    const markup = renderItem(
      {
        ...feedback("loans"),
        status: "approved",
        canDecide: false,
        decision: {
          approved: true,
          decidedBy: "user-admin",
          decidedByLabel: "Admin",
          decidedAt: "2026-10-05T09:00:00Z",
          comment: "Added to the checklist."
        }
      },
      { locale: "en" }
    );
    expect(markup).toContain(">Done<");
    expect(markup).toContain("Added to the checklist.");
  });

  // LU-6: a comment from a published App, or on a Workflow's result, names what it is about and
  // leads there; it has no exchange to speak of and no agent to filter by.
  it("names the App a comment is about and leads to it", () => {
    const markup = renderItem(
      {
        ...feedback("offers"),
        preview: {
          feedbackId: "fb_app",
          subjectKind: "app",
          about: {
            kind: "app",
            name: "offers",
            displayName: "Offers",
            revision: 2,
            workspaceId: "cws_team"
          },
          text: "The total leaves out the open offers.",
          gone: false
        }
      },
      { locale: "en" }
    );
    expect(markup).toMatch(/<h3[^>]*>Feedback on the App Offers<\/h3>/u);
    expect(markup).toContain("Version 2");
    expect(markup).toContain("The total leaves out the open offers.");
    expect(markup).toMatch(/href="\/w\/cws_team\/apps\/offers"[^>]*>Open the App<\/a>/u);
    expect(markup).not.toContain("did not include the question");
    expect(markup).not.toContain("Open the agent");
  });

  it("names the Workflow whose result a comment is about and leads to the run, in German", () => {
    const preview = {
      feedbackId: "fb_run",
      subjectKind: "workflow_run",
      about: { kind: "workflow", name: "monthly-check", displayName: "Monatscheck" },
      workflowRunId: "wfr_1",
      workspaceId: "cws_team",
      text: "Der Kontoauszug war doch da.",
      gone: false
    };
    const markup = renderItem({ ...feedback("monthly"), preview }, { locale: "de" });
    expect(markup).toMatch(/<h3[^>]*>Feedback zu einem Ergebnis von Monatscheck<\/h3>/u);
    expect(markup).toMatch(
      /href="\/w\/cws_team\/workflows\/monthly-check\/runs\/wfr_1"[^>]*>Lauf öffnen<\/a>/u
    );
    expect(markup).not.toContain("nicht mitgeschickt");
    const kind = inboxItemKinds.find((entry) => entry.kind === "feedback_review");
    expect(kind?.agentOf?.(item({ ...feedback("monthly"), preview }))).toBeUndefined();
  });

  it("is filtered by agent", () => {
    const kind = inboxItemKinds.find((entry) => entry.kind === "feedback_review");
    const agentOf = (entry: ApprovalRequestView) => kind?.agentOf?.(entry);
    const items = [item(feedback("loans")), item(feedback("leases")), item()];
    const options = inboxFilterOptions(items, {}, () => undefined, agentOf);
    expect(options.agents).toEqual([
      { name: "loans", label: "loans display" },
      { name: "leases", label: "leases display" }
    ]);
    expect(
      filterInboxItems(items, { agentName: "loans" }, () => undefined, agentOf).map(
        (entry) => entry.id
      )
    ).toEqual(["apr_loans"]);
  });
});
