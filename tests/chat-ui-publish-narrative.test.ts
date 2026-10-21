import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { appManifestSummary, PublishDialog } from "@work-shape/catalyst-chat-ui/apps";
import {
  narrativeHolds,
  parsePublishNarrative,
  type PublishNarrativeRead
} from "./support/chat-ui";
import { createInstanceSource, DraftChangeDialog } from "@work-shape/catalyst-chat-ui/workflows";
import { renderItem } from "./chat-ui-inbox-harness";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { recordedApiClient } from "./support/recorded-api-client";

// PUBQ-1 in the interface: each publish question leads with the instance's one plain sentence
// on what the publish makes live, says its warnings before the click, and folds what it listed
// before behind "Details". The App's Publish dialog, the Workflow's publish question and the
// Inbox item of a held publish show the same sentence. Every test here fails without PUBQ-1:
// the questions led with the revision and the lists, and held no sentence.

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const noop = () => undefined;

const english = {
  summary:
    "Nachtimport runs as the account “nachtimport-runner” every day at 2:00 AM, reads from Exampledata, adds rows to Findings, and uses Outlook for “Mail an Mandanten”.",
  warnings: [
    "The step “Mail an Mandanten” will stop: the guardrail “Outgoing mail” asks for approval, and a published run cannot wait for one."
  ]
};
const german = {
  summary:
    "Nachtimport läuft jeden Tag um 02:00 Uhr unter dem Konto „nachtimport-runner“, liest aus Exampledata, fügt Zeilen in Findings hinzu und nutzt Outlook für „Mail an Mandanten“.",
  warnings: [
    "Der Schritt „Mail an Mandanten“ wird angehalten: Die Leitplanke „Ausgehende Mail“ verlangt eine Freigabe, und ein veröffentlichter Lauf kann nicht auf sie warten."
  ]
};
/** Whether a button's tag holds the `disabled` attribute, not a `disabled:` class. */
const disabled = (button: string) => {
  expect(button, "the button is in the markup").not.toBe("");
  return / disabled=""/u.test(button);
};
const ready = (narrative: typeof english): PublishNarrativeRead => ({ status: "ready", narrative });

/** Where in the markup a text first stands, to say what comes before what. */
const at = (markup: string, text: string) => {
  const index = markup.indexOf(text);
  expect(index, `${text} is in the markup`).toBeGreaterThan(-1);
  return index;
};

/** The markup of the folded "Details" region: kept in the page and hidden while folded. */
const details = (markup: string) => {
  const start = markup.indexOf('data-testid="publish-details"');
  expect(start).toBeGreaterThan(-1);
  return markup.slice(start);
};

describe("the narrative an answer carries", () => {
  it("reads a narrative whole by the contract's schema", () => {
    expect(parsePublishNarrative(english)).toEqual({ status: "present", narrative: english });
    expect(parsePublishNarrative({ summary: "X opens for nobody.", warnings: [] })).toEqual({
      status: "present",
      narrative: { summary: "X opens for nobody.", warnings: [] }
    });
  });

  it("tells an answer without one, from a sample or an older instance, from a malformed one", () => {
    expect(parsePublishNarrative(undefined)).toEqual({ status: "absent" });
    // A present narrative that cannot be read whole is never shown in part: a dropped warning
    // would let the question be answered without it.
    for (const hostile of [
      // The contract's field is optional, never nullable: `null` is a present, broken answer.
      null,
      { summary: english.summary },
      { summary: english.summary, warnings: "The step will stop." },
      { summary: english.summary, warnings: [english.warnings[0], 7] },
      { summary: english.summary, warnings: [english.warnings[0], ""] },
      { summary: english.summary, warnings: [null] },
      { summary: "", warnings: [] },
      { summary: "   ", warnings: [] },
      { summary: 3, warnings: [] },
      { warnings: english.warnings },
      [english.summary],
      "Nachtimport runs every day.",
      0
    ]) {
      expect(parsePublishNarrative(hostile), JSON.stringify(hostile)).toEqual({
        status: "malformed"
      });
    }
  });

  it("holds the click while it loads and after a read failed or held a malformed narrative", () => {
    expect(narrativeHolds({ status: "loading" })).toBe(true);
    expect(narrativeHolds({ status: "failed", reason: "read", retry: noop })).toBe(true);
    expect(narrativeHolds({ status: "failed", reason: "malformed" })).toBe(true);
    expect(narrativeHolds(ready(english))).toBe(false);
    expect(narrativeHolds({ status: "none" })).toBe(false);
  });
});

describe("the App's Publish dialog", () => {
  const dialog = (narrative?: PublishNarrativeRead, locale: "en" | "de" = "en") =>
    render(
      createElement(PublishDialog, {
        name: "Findings",
        workspace: { id: "cw_1", name: "Kai Spezis", emoji: null },
        ask: {
          revision: 3,
          summary: appManifestSummary({
            manifest: { connections: ["crm"], externalHosts: ["api.example.com"] }
          }),
          readsStoredData: false
        },
        loading: false,
        error: undefined,
        ...(narrative ? { narrative } : {}),
        onConfirm: noop,
        onClose: noop
      }),
      locale
    );
  const publishButton = (markup: string) =>
    markup.match(/<button[^>]*>(?:(?!<\/button>).)*Publish<\/button>/u)?.[0] ??
    markup.match(/<button[^>]*>(?:(?!<\/button>).)*Veröffentlichen<\/button>/u)?.[0] ??
    "";

  it("leads with the sentence and its warnings, and folds the revision and the lists behind Details", () => {
    const markup = dialog(ready(english));
    const summary = at(markup, english.summary);
    expect(at(markup, english.warnings[0] ?? "")).toBeGreaterThan(summary);
    expect(at(markup, "Before you publish")).toBeGreaterThan(summary);
    // The revision sentence is no lead of its own any more: it stands in Details.
    const fold = details(markup);
    expect(fold).toContain(">Details<");
    expect(fold).toContain("Everyone in Kai Spezis gets version 3 when they open the app.");
    expect(fold).toContain("Connections it uses");
    expect(fold).toContain(">crm</code>");
    expect(fold).toContain(">api.example.com</code>");
    expect(at(markup, "Everyone in Kai Spezis gets version 3")).toBeGreaterThan(summary);
    // Folded, the lists stay in the page, hidden, so the reads inside them still run.
    expect(fold).toMatch(/data-state="closed"[^>]*class="[^"]*data-\[state=closed\]:hidden/u);
    expect(disabled(publishButton(markup))).toBe(false);
  });

  it("says it in German for a German reader", () => {
    const markup = dialog(ready(german), "de");
    const summary = at(markup, german.summary);
    expect(at(markup, german.warnings[0] ?? "")).toBeGreaterThan(summary);
    expect(at(markup, "Bevor du veröffentlichst")).toBeGreaterThan(summary);
    expect(details(markup)).toContain(">Details<");
  });

  it("holds Publish while the sentence loads and after its read failed", () => {
    const loading = dialog({ status: "loading" });
    expect(loading).toContain('data-testid="publish-narrative-loading"');
    expect(disabled(publishButton(loading))).toBe(true);
    const failed = dialog({ status: "failed", reason: "read", retry: noop });
    expect(failed).toContain("Could not read what this publish makes live.");
    expect(failed).toContain("Try again");
    expect(disabled(publishButton(failed))).toBe(true);
    const malformed = dialog({ status: "failed", reason: "malformed" });
    expect(malformed).toContain("could not be read whole");
    expect(malformed).not.toContain("Try again");
    expect(disabled(publishButton(malformed))).toBe(true);
  });

  it("asks as before where the instance words no sentence, as a sample or an older instance", () => {
    const markup = dialog();
    expect(markup).not.toContain('data-testid="publish-details"');
    expect(markup).toContain("Everyone in Kai Spezis gets version 3 when they open the app.");
    expect(disabled(publishButton(markup))).toBe(false);
  });
});

describe("the Workflow's publish question", () => {
  const raise = "Raises the run time of each run from 12h to 30h.";
  const question = (
    narrative: PublishNarrativeRead | undefined,
    locale: "en" | "de" = "en",
    change: "publish" | "discard" = "publish"
  ) =>
    render(
      createElement(DraftChangeDialog, {
        change,
        name: "Nachtimport",
        revision: 6,
        publishedRevision: 4,
        question: [raise],
        rights: createElement("p", { "data-testid": "rights-sample" }, "Rights of the accounts"),
        ...(narrative ? { narrative } : {}),
        loading: false,
        error: undefined,
        onConfirm: noop,
        onClose: noop
      }),
      locale
    );
  const confirm = (markup: string, label: string) =>
    markup.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}</button>`, "u"))?.[0] ?? "";

  it("leads with the sentence and its warnings, and folds the revision, the limits and the rights", () => {
    const markup = question(ready(english));
    const summary = at(markup, english.summary);
    expect(at(markup, english.warnings[0] ?? "")).toBeGreaterThan(summary);
    const fold = details(markup);
    expect(fold).toContain(raise);
    expect(fold).toContain('data-testid="rights-sample"');
    expect(fold).toContain('data-testid="workflow-publish-body"');
    expect(at(markup, 'data-testid="workflow-publish-body"')).toBeGreaterThan(summary);
    expect(disabled(confirm(markup, "Publish"))).toBe(false);
  });

  it("says it in German for a German reader", () => {
    const markup = question(ready(german), "de");
    expect(at(markup, german.warnings[0] ?? "")).toBeGreaterThan(at(markup, german.summary));
    expect(details(markup)).toContain(">Details<");
  });

  it("holds Publish while the sentence loads or failed, and never holds the discard", () => {
    expect(disabled(confirm(question({ status: "loading" }), "Publish"))).toBe(true);
    const failed = question({ status: "failed", reason: "read", retry: noop });
    expect(disabled(confirm(failed, "Publish"))).toBe(true);
    const discard = question({ status: "loading" }, "en", "discard");
    expect(discard).not.toContain('data-testid="publish-narrative-loading"');
    expect(disabled(confirm(discard, "Discard"))).toBe(false);
  });

  it("reads the sentence of the revision it asks about from the asset read of that revision", async () => {
    const { client, calls } = recordedApiClient(() => ({
      id: "asset_1",
      kind: "workflow",
      name: "nachtimport",
      scope: { kind: "instance" },
      revision: 6,
      draftRevision: 6,
      publishedRevision: 4,
      updatedAt: "2026-10-18T09:00:00.000Z",
      config: { manifest: { steps: [] } },
      publishNarrative: english
    }));
    const source = createInstanceSource(client, "k");
    const answer = await source.publishNarrative?.read(
      "nachtimport",
      6,
      new AbortController().signal
    );
    expect(parsePublishNarrative(answer)).toEqual({ status: "present", narrative: english });
    expect(calls[0]).toMatchObject({
      operation: "assets.get",
      params: { kind: "workflow", name: "nachtimport" },
      query: { revision: "6" }
    });
  });
});

describe("the Inbox item of a held publish", () => {
  const preview = (review: Record<string, unknown>) => ({
    runId: "opr_1",
    operation: "assets.publish",
    effect: "changing",
    actor: { kind: "user", id: "usr_kai", label: "Kai Member" },
    origin: { kind: "user" },
    inputs: [{ key: "revision", value: "6" }],
    review: {
      kind: "workflow",
      name: "nachtimport",
      title: "Nachtimport",
      revision: 6,
      liveRevision: 4,
      files: [{ path: "workflow.yaml", change: "changed" }],
      hostsAdded: [],
      connections: ["exampledata"],
      dataStores: [],
      runAs: "nachtimport-runner",
      ...review
    }
  });
  const item = (review: Record<string, unknown>, locale: "en" | "de" = "en") =>
    renderItem(
      {
        kind: "workflow_publish",
        summary: "assets.publish",
        preview: preview(review),
        canDecide: true
      },
      { locale }
    );
  const approveHeld = (markup: string) =>
    (markup.match(/<button[^>]*data-decision="approve"[^>]*>/u)?.[0] ?? "").includes(
      ' disabled=""'
    );

  it("check 75 in the Inbox: the approver reads the sentence and the warning before Approve, the lists behind Details", () => {
    const markup = item({ publishNarrative: english });
    const headline = at(markup, "Kai Member wants to publish");
    const summary = at(markup, english.summary);
    expect(summary).toBeGreaterThan(headline);
    expect(at(markup, english.warnings[0] ?? "")).toBeGreaterThan(summary);
    const fold = details(markup);
    // Only the actor's headline stands above the sentence; what approving does in general is
    // folded with the lists.
    expect(at(markup, 'data-testid="publish-review-effect"')).toBeGreaterThan(summary);
    expect(fold).toContain("Approving makes this version what its users are served.");
    expect(fold).toContain("Version 6, in place of version 4");
    expect(fold).toMatch(/data-field="connections".*exampledata/u);
    expect(fold).toMatch(/data-field="runs-as".*nachtimport-runner/u);
    // One fold: the call's technical details stand last inside Details, not in a fold beside.
    expect(markup).not.toContain('data-testid="operation-call-details"');
    expect(fold).toMatch(/data-testid="publish-details-technical".*Technical details/u);
    expect(at(markup, 'data-testid="publish-details-technical"')).toBeGreaterThan(
      at(markup, 'data-field="runs-as"')
    );
    expect(fold).toMatch(/data-field="operation".*assets\.publish/u);
    expect(at(markup, "Approve and publish")).toBeGreaterThan(summary);
    expect(approveHeld(markup)).toBe(false);
  });

  it("says it in the German approver's language", () => {
    const markup = item({ publishNarrative: german }, "de");
    expect(at(markup, german.warnings[0] ?? "")).toBeGreaterThan(at(markup, german.summary));
    expect(details(markup)).toContain(">Details<");
    expect(details(markup)).toContain("Technische Details");
    expect(markup).not.toContain('data-testid="operation-call-details"');
    expect(markup).toContain("Freigeben und veröffentlichen");
  });

  it("holds Approve where the request holds a narrative this client cannot read whole", () => {
    const markup = item({ publishNarrative: { summary: english.summary, warnings: [7] } });
    expect(markup).toContain('data-testid="publish-narrative-failed"');
    expect(markup).not.toContain(english.summary);
    expect(approveHeld(markup)).toBe(true);
  });

  it("shows a request from before PUBQ-1 as it did, with its lists open", () => {
    const markup = item({});
    expect(markup).not.toContain('data-testid="publish-details"');
    // Its call keeps the fold it had.
    expect(markup).toContain('data-testid="operation-call-details"');
    expect(at(markup, 'data-testid="publish-review-effect"')).toBeLessThan(
      at(markup, "Version 6, in place of version 4")
    );
    expect(markup).toContain("Version 6, in place of version 4");
    expect(approveHeld(markup)).toBe(false);
  });
});
