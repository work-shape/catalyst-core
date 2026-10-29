import { describe, expect, it } from "vitest";
import { createElement } from "react";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { InboxList, item, now, render, renderItem } from "./chat-ui-inbox-harness";

// NL-10: a Workflow step that waits for a person reads as its Workflow, its run, the step,
// what the step asks and the inputs it received, and is approved or rejected with one click.

const step = (preview: ApprovalRequestView["preview"]) => ({
  kind: "workflow_step",
  summary: "Freigabe Mandantenmail",
  origin: undefined,
  requestedBy: { id: "sp_onboarding", displayLabel: "Mandantenaufnahme" },
  canDecide: true,
  preview
});

const preview = {
  workspaceId: "cws_team",
  workflow: { id: "onboarding", title: "Mandantenaufnahme" },
  runId: "wfr_1",
  step: { key: "check", title: "Vorcheck freigeben" },
  instruction: "Prüfe den Vorcheck und gib die Mail an den Mandanten frei.",
  inputs: [
    { key: "rechtsform", value: "GmbH" },
    { key: "fehlend", value: "Steuernummer" }
  ]
};

describe("inbox item of a workflow step", () => {
  it("shows the workflow, the step, its instruction, its inputs and the run, with two answers", () => {
    const markup = renderItem(step(preview), { locale: "en" });

    expect(markup).toMatch(/<h3[^>]*>Vorcheck freigeben in Mandantenaufnahme<\/h3>/u);
    expect(markup).toContain("Prüfe den Vorcheck und gib die Mail an den Mandanten frei.");
    expect(markup).toContain("What the step received");
    expect(markup).toContain("rechtsform");
    expect(markup).toContain("GmbH");
    expect(markup).toMatch(
      /href="\/w\/cws_team\/workflows\/onboarding\/runs\/wfr_1"[^>]*>Open the run<\/a>/u
    );
    expect(markup).toContain("The run waits until you decide.");
    expect(markup).toMatch(/data-decision="reject"[^>]*>Decline<\/button>/u);
    expect(markup).toMatch(/data-decision="approve"[^>]*>Approve<\/button>/u);
    // Nobody edits a run from the Inbox: no request for changes.
    expect(markup).not.toContain('data-decision="request_changes"');
  });

  it("reads in German and leaves out an empty list of inputs", () => {
    const markup = renderItem(step({ ...preview, inputs: [] }));
    expect(markup).toContain("Der Lauf wartet, bis du entscheidest.");
    expect(markup).not.toContain("Was der Schritt bekommen hat");
    expect(markup).toMatch(/data-decision="approve"[^>]*>Freigeben<\/button>/u);
  });

  it("offers no answer and no waiting line once decided", () => {
    const markup = renderItem(
      { ...step(preview), status: "approved", canDecide: false },
      { locale: "en" }
    );
    expect(markup).not.toContain("data-decision=");
    expect(markup).not.toContain("The run waits until you decide.");
  });

  it("names the row by its step and its workflow", () => {
    const markup = render(
      createElement(InboxList, {
        tab: "to_decide",
        state: { status: "ready", items: [item(step(preview))] },
        now,
        onOpenItem: () => undefined
      }),
      "en"
    );
    expect(markup).toContain("Vorcheck freigeben in Mandantenaufnahme");
    expect(markup).toContain("lucide-list-checks");
  });
});
