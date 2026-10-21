import { ApiError } from "@work-shape/catalyst-api-client";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import { appPublishRefusal } from "@work-shape/catalyst-chat-ui/apps";

// DP-0: a publish of an App whose Workflow is not live, or whose action does not fit that
// Workflow's inputs, is refused, and the Publish dialog says so in its own words with the
// Workflow, the action and the input named.

const refused = (status: number, details: Record<string, string>) =>
  new ApiError(status, "As the instance says it", {
    error: { code: "REFUSED", details }
  });

describe("the sentence of a publish refused for a Workflow", () => {
  it("names the Workflow that is not live, and the input that does not fit, in German and in English", () => {
    const unavailable = appPublishRefusal(
      refused(404, { reason: "workflow_unavailable", workflow: "brain-briefing" })
    );
    const missing = appPublishRefusal(
      refused(422, {
        reason: "workflow_input_invalid",
        workflow: "brain-briefing",
        action: "brief",
        input: "topic",
        fault: "missing"
      })
    );
    const undeclared = appPublishRefusal(
      refused(422, {
        reason: "workflow_input_invalid",
        workflow: "brain-briefing",
        action: "brief",
        input: "origin",
        fault: "undeclared"
      })
    );
    const en = createTranslationContext("en").t;
    const de = createTranslationContext("de").t;
    const say = (t: typeof en, refusal: typeof unavailable) =>
      refusal ? t(refusal.key, refusal.values) : undefined;

    expect(say(en, unavailable)).toBe(
      "The Workflow “brain-briefing” that this app starts is not published. Publish the Workflow first, then the app."
    );
    expect(say(de, unavailable)).toBe(
      "Der Workflow „brain-briefing“, den diese App startet, ist nicht veröffentlicht. Veröffentliche zuerst den Workflow, dann die App."
    );
    expect(say(en, missing)).toBe(
      "The action “brief” does not pass “topic”, which the Workflow “brain-briefing” needs."
    );
    expect(say(de, undeclared)).toBe(
      "Die Aktion „brief“ übergibt „origin“, das der Workflow „brain-briefing“ nicht annimmt."
    );
    // A refusal the Apps area knows by its reason alone keeps its sentence; others have none.
    expect(appPublishRefusal(refused(422, { reason: "revision_files_removed" }))).toEqual({
      key: "apps.revisionFilesRemoved"
    });
    expect(appPublishRefusal(refused(422, { reason: "other" }))).toBeUndefined();
  });
});
