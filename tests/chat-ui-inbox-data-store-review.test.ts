import { describe, expect, it } from "vitest";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { renderItem } from "./chat-ui-inbox-harness";

// REC-2: the one notice of a Data Store whose records wait in "Prüfen": how many fields wait
// now, the way to the store, and "mark handled" as its one answer. It names no field or value.

const review = (preview: ApprovalRequestView["preview"]) => ({
  kind: "data_store_review",
  summary: "Fields of the Data Store 'findings' wait for review",
  origin: undefined,
  requestedBy: { id: "system", displayLabel: "System" },
  canDecide: true,
  preview
});

describe("inbox item of a Data Store review", () => {
  it("says how many fields wait in the store, leads to it, and is marked handled", () => {
    const markup = renderItem(review({ store: "findings", title: "Objektdaten", flagged: 3 }));
    expect(markup).toMatch(/<h3[^>]*>Felder in Objektdaten prüfen<\/h3>/u);
    expect(markup).toContain("3 Felder der Datensätze in Objektdaten warten auf eine Person");
    expect(markup).toMatch(/href="\/build\/data-stores\/findings"[^>]*>Prüfen öffnen<\/a>/u);
    expect(markup).toMatch(/data-decision="approve"[^>]*>Als erledigt markieren<\/button>/u);
    expect(markup.match(/data-decision=/gu)).toHaveLength(1);
    expect(markup).not.toContain("<textarea");

    const english = renderItem(review({ store: "findings", flagged: 1 }), { locale: "en" });
    expect(english).toMatch(/<h3[^>]*>Review fields in findings<\/h3>/u);
    expect(english).toContain("1 field of the records in findings waits for a person");
    expect(english).toMatch(/>Open review<\/a>/u);
  });

  it("says fields wait where their number could not be read", () => {
    const markup = renderItem(review({ store: "findings" }), { locale: "en" });
    expect(markup).toContain("Their number could not be read.");
  });
});
