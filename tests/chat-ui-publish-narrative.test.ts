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

const render = (node: ReactNode) =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale: "en", children: node }));
const noop = () => undefined;

const english = {
  summary:
    "Nachtimport runs as the account “nachtimport-runner” every day at 2:00 AM, reads from Exampledata, adds rows to Findings, and uses Outlook for “Mail an Mandanten”.",
  warnings: [
    "The step “Mail an Mandanten” will stop: the guardrail “Outgoing mail” asks for approval, and a published run cannot wait for one."
  ]
};
/** Whether a button's tag holds the `disabled` attribute, not a `disabled:` class. */
const disabled = (button: string) => {
  expect(button, "the button is in the markup").not.toBe("");
  return / disabled=""/u.test(button);
};
const ready = (narrative: typeof english): PublishNarrativeRead => ({ status: "ready", narrative });

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
      { summary: "   ", warnings: [] },
      "Nachtimport runs every day."
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
  const dialog = (narrative?: PublishNarrativeRead) =>
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
      })
    );
  const publishButton = (markup: string) =>
    markup.match(/<button[^>]*>(?:(?!<\/button>).)*Publish<\/button>/u)?.[0] ?? "";

  it("holds Publish while the sentence loads and after its read failed", () => {
    const loading = dialog({ status: "loading" });
    expect(loading).toContain('data-testid="publish-narrative-loading"');
    expect(disabled(publishButton(loading))).toBe(true);
    const failed = dialog({ status: "failed", reason: "read", retry: noop });
    expect(disabled(publishButton(failed))).toBe(true);
    const malformed = dialog({ status: "failed", reason: "malformed" });
    expect(disabled(publishButton(malformed))).toBe(true);
    expect(disabled(publishButton(dialog(ready(english))))).toBe(false);
    expect(disabled(publishButton(dialog()))).toBe(false);
  });
});

describe("the Workflow's publish question", () => {
  const raise = "Raises the run time of each run from 12h to 30h.";
  const question = (
    narrative: PublishNarrativeRead | undefined,
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
      })
    );
  const confirm = (markup: string, label: string) =>
    markup.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}</button>`, "u"))?.[0] ?? "";

  it("holds Publish while the sentence loads or failed, and never holds the discard", () => {
    expect(disabled(confirm(question({ status: "loading" }), "Publish"))).toBe(true);
    const failed = question({ status: "failed", reason: "read", retry: noop });
    expect(disabled(confirm(failed, "Publish"))).toBe(true);
    const discard = question({ status: "loading" }, "discard");
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
  const item = (review: Record<string, unknown>) =>
    renderItem(
      {
        kind: "workflow_publish",
        summary: "assets.publish",
        preview: preview(review),
        canDecide: true
      },
      { locale: "en" }
    );
  const approveHeld = (markup: string) =>
    (markup.match(/<button[^>]*data-decision="approve"[^>]*>/u)?.[0] ?? "").includes(
      ' disabled=""'
    );

  it("holds Approve where the request holds a narrative this client cannot read whole", () => {
    const markup = item({ publishNarrative: { summary: english.summary, warnings: [7] } });
    expect(markup).toContain('data-testid="publish-narrative-failed"');
    expect(markup).not.toContain(english.summary);
    expect(approveHeld(markup)).toBe(true);
    const whole = item({ publishNarrative: english });
    expect(whole).toContain(english.warnings[0]);
    expect(approveHeld(whole)).toBe(false);
  });
});
