import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { appManifestSummary, PublishDialog } from "@work-shape/catalyst-chat-ui/apps";
import { renderItem } from "./chat-ui-inbox-harness";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// DP-3 in the interface: the App's Publish question names the Workflows its one Publish makes
// live with it, each new or changed, who changed it last and how its last test run ended, and
// holds Publish while they load or one would be refused. A held publish's Inbox item lists
// them, children first, each with the version it makes live.

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const noop = () => undefined;
const at = (markup: string, text: string) => {
  const index = markup.indexOf(text);
  expect(index, `${text} is in the markup`).toBeGreaterThan(-1);
  return index;
};
const publishButton = (markup: string) =>
  markup.match(/<button[^>]*>(?:(?!<\/button>).)*(?:Publish|Veröffentlichen)<\/button>/u)?.[0] ??
  "";
const held = (markup: string) => / disabled=""/u.test(publishButton(markup));

type Together = NonNullable<Parameters<typeof PublishDialog>[0]["together"]>;
type Workflow = Together["workflows"][number];

const child: Workflow = {
  name: "visit-check",
  title: "Visit check",
  draftRevision: 3,
  publishedRevision: 2,
  pending: true,
  lastChangedBy: "Lena Builder",
  lastTestRun: { runId: "wfr_1", status: "done", at: "2026-10-21T08:00:00.000Z" },
  refusals: [],
  actions: []
};
const parent: Workflow = {
  name: "visit-log",
  title: "Visit log",
  draftRevision: 1,
  pending: true,
  lastChangedBy: "Kai Member",
  refusals: [],
  actions: ["log-visit"]
};

const dialog = (together: Together, locale: "en" | "de" = "en") =>
  render(
    createElement(PublishDialog, {
      name: "Visits",
      workspace: { id: "cw_1", name: "Sales", emoji: null },
      ask: {
        revision: 4,
        live: 3,
        summary: appManifestSummary({ manifest: {} }),
        readsStoredData: false
      },
      loading: false,
      error: undefined,
      together,
      onConfirm: noop,
      onClose: noop
    }),
    locale
  );
const ready = (workflows: Workflow[]): Together => ({ status: "ready", workflows, retry: noop });

describe("DP-3: the App's Publish question names what it makes live with the App", () => {
  it("lists each pending Workflow, children first, new or changed, its last author and test run", () => {
    const markup = dialog(ready([child, parent]));
    const line = at(markup, "Published with it");
    expect(at(markup, "Workflow “Visit check”")).toBeGreaterThan(line);
    expect(at(markup, "Workflow “Visit log”")).toBeGreaterThan(
      at(markup, "Workflow “Visit check”")
    );
    expect(markup).toContain("Last changed by Lena Builder");
    expect(markup).toContain("Last test run");
    // The parent was never published and never tested.
    expect(at(markup, ">New<")).toBeGreaterThan(at(markup, "Workflow “Visit log”"));
    expect(markup).toContain("Not tested yet");
    expect(held(markup)).toBe(false);
  });

  it("says it in German", () => {
    const markup = dialog(ready([parent]), "de");
    expect(markup).toContain("Wird zusammen veröffentlicht");
    expect(markup).toContain("Workflow „Visit log“");
    expect(markup).toContain("Zuletzt geändert von Kai Member");
    expect(markup).toContain("Noch nicht getestet");
  });

  it("names nothing where the publish makes no Workflow live with the App", () => {
    const markup = dialog(ready([]));
    expect(markup).not.toContain("Published with it");
    expect(held(markup)).toBe(false);
  });

  it("holds Publish while the Workflows load, after their read failed, and while one would be refused", () => {
    expect(held(dialog({ status: "loading", workflows: [], retry: noop }))).toBe(true);
    const failed = dialog({ status: "failed", workflows: [], retry: noop });
    expect(failed).toContain("What is published with the app could not be read.");
    expect(held(failed)).toBe(true);
    const refused = dialog(
      ready([
        {
          ...parent,
          refusals: [
            {
              reason: "no_grant",
              right: "workflow.publish",
              message: "You may not publish the Workflow 'visit-log'."
            }
          ]
        }
      ])
    );
    expect(refused).toContain("You may not publish the Workflow &#x27;visit-log&#x27;.");
    expect(held(refused)).toBe(true);
  });
});

describe("DP-3: the Inbox item of a held App publish lists what it publishes with the App", () => {
  const review = (name: string, title: string, revision: number, liveRevision?: number) => ({
    kind: name === "visits" ? "app" : "workflow",
    name,
    title,
    revision,
    ...(liveRevision === undefined ? {} : { liveRevision }),
    files: [],
    hostsAdded: [],
    connections: [],
    dataStores: []
  });
  const item = (locale: "en" | "de" = "en") =>
    renderItem(
      {
        kind: "app_publish",
        summary: "assets.publish",
        preview: {
          runId: "opr_1",
          operation: "assets.publish",
          effect: "changing",
          actor: { kind: "user", id: "usr_kai", label: "Kai Member" },
          origin: { kind: "user" },
          inputs: [{ key: "revision", value: "4" }],
          review: {
            ...review("visits", "Visits", 4, 3),
            publishedWith: [
              review("visit-check", "Visit check", 3, 2),
              review("visit-log", "Visit log", 1)
            ]
          }
        },
        canDecide: true
      },
      { locale }
    );

  it("names each Workflow with the version it makes live, children first", () => {
    const markup = item();
    const list = at(markup, 'data-testid="publish-review-published-with"');
    const checkAt = at(markup, "Workflow “Visit check”");
    expect(checkAt).toBeGreaterThan(list);
    expect(at(markup, "Version 3, in place of version 2")).toBeGreaterThan(checkAt);
    expect(at(markup, "Workflow “Visit log”")).toBeGreaterThan(checkAt);
    expect(markup).toContain("Version 1, the first one published");
  });

  it("says it in German", () => {
    expect(item("de")).toContain("Wird zusammen veröffentlicht");
  });
});
