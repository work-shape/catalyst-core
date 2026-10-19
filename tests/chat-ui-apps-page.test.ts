import { createElement, type ReactNode } from "react";
import type { AssetSummary } from "@work-shape/catalyst-api-client";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import { AppsPageView, NO_APP_RIGHTS, type AppRights } from "@work-shape/catalyst-chat-ui/apps";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Apps page: one card per App of the open workspace, and what a card shows and offers by
// the rights of its reader. Every test here fails without the page.

const { t } = createTranslationContext("en");
const de = createTranslationContext("de").t;

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));

const workspace = { id: "cw_1", name: "Nordlicht Beratung", emoji: null };
const ALL: AppRights = { read: true, write: true, publish: true, delete: true };

const now = new Date("2026-10-11T12:00:00.000Z");

function summary(overrides: Partial<AssetSummary> = {}): AssetSummary {
  return {
    id: "asset_1",
    kind: "app",
    name: "angebotsrechner",
    title: "Angebotsrechner",
    description: "Rechnet ein Angebot aus Tagessatz und Tagen.",
    scope: { kind: "workspace", workspaceId: "cw_1" },
    revision: 3,
    draftRevision: 3,
    publishedRevision: 2,
    updatedAt: "2026-10-10T12:00:00.000Z",
    ...overrides
  };
}

function list(rows: readonly AssetSummary[] | undefined, overrides = {}) {
  return {
    rows,
    failed: false,
    hasMore: false,
    loadingMore: false,
    loadMore() {},
    retry() {},
    ...overrides
  };
}

function appsPage(rows: readonly AssetSummary[] | undefined, rights: AppRights, extra = {}) {
  return createElement(AppsPageView, {
    workspace,
    rights,
    list: list(rows, extra),
    now,
    onOpenRoute() {},
    onAction() {},
    onBuild() {}
  });
}

describe("the Apps page", () => {
  it("offers New app in the head to a reader who may build one, and only there", () => {
    const READER: AppRights = { ...NO_APP_RIGHTS, read: true };
    const withNew = (rights: AppRights, rows: readonly AssetSummary[] | undefined = [summary()]) =>
      createElement(AppsPageView, {
        ...appsPage(rows, rights).props,
        onNew() {}
      });
    const newButton = /<button[^>]*>(?:(?!<\/button>).)*New app<\/button>/u;

    expect(render(withNew(ALL))).toMatch(newButton);
    expect(render(withNew(ALL), "de")).toContain(`${de("apps.new")}</button>`);
    // While the list loads New stands; an empty list offers the agent itself instead.
    expect(render(withNew(ALL, undefined))).toMatch(newButton);
    expect(render(withNew(ALL, []))).not.toMatch(newButton);
    // A reader who may not write Apps, or a host that builds none with an agent, gets no New.
    expect(render(withNew(READER))).not.toContain("New app");
    expect(render(appsPage([summary()], ALL))).not.toContain("New app");
  });

  it("shows name, description, workspace, state and the menu of each App", () => {
    const markup = render(
      appsPage(
        [
          summary(),
          summary({
            name: "urlaubsplaner",
            title: "Urlaubsplaner",
            description: undefined,
            publishedRevision: undefined,
            revision: 1,
            draftRevision: 1
          })
        ],
        ALL
      )
    );

    expect(markup).toContain(">Apps</h1>");
    expect(markup).toContain("Angebotsrechner");
    expect(markup).toContain("Rechnet ein Angebot aus Tagessatz und Tagen.");
    // The list is the one of the open workspace: no row names it.
    expect(markup).not.toContain("Nordlicht Beratung");
    expect(markup).toContain("Published · revision 2");
    expect(markup).toContain("Unpublished changes");
    expect(markup).toContain('href="/w/cw_1/apps/angebotsrechner"');
    expect(markup).toContain('aria-label="Actions for Angebotsrechner"');
    // No card shows an App's id: an App without a name goes by it as its title alone. One
    // without a publish opens its draft.
    expect(markup).not.toContain("font-mono");
    expect(markup).toContain("Draft only");
    expect(markup).toContain('href="/w/cw_1/app-drafts/urlaubsplaner"');
  });

  it("shows each App as a card with one main action, and says when it last changed", () => {
    const draftOnly = summary({
      name: "urlaubsplaner",
      title: "Urlaubsplaner",
      publishedRevision: undefined,
      revision: 1,
      draftRevision: 1
    });
    const builder = render(appsPage([summary(), draftOnly], ALL));
    const cards = builder.split("<li").slice(1);

    expect(cards).toHaveLength(2);
    // A published App opens, and its draft is edited beside it.
    expect(cards[0]).toMatch(/<a[^>]*href="\/w\/cw_1\/apps\/angebotsrechner"[^>]*>Open<\/a>/u);
    expect(cards[0]).toMatch(
      /<a[^>]*href="\/w\/cw_1\/app-drafts\/angebotsrechner"[^>]*>Edit<\/a>/u
    );
    expect(cards[0]).toContain("Changed yesterday");
    // The whole card opens the App: Open is its one target, and Edit keeps its own way.
    expect(cards[0]?.match(/data-card-target=""/gu)).toHaveLength(1);
    expect(cards[0]).toMatch(/<a[^>]*data-card-target=""[^>]*href="[^"]*\/apps\/angebotsrechner"/u);
    // An App with a draft alone has the draft as its one action, and the card opens it.
    expect(cards[1]?.match(/<a /gu)).toHaveLength(1);
    expect(cards[1]).toMatch(/<a[^>]*href="\/w\/cw_1\/app-drafts\/urlaubsplaner"[^>]*>Edit<\/a>/u);
    expect(cards[1]).toMatch(/<a[^>]*data-card-target=""[^>]*href="[^"]*\/app-drafts\//u);

    // Whoever uses Apps gets Open and nothing a builder works with.
    const member = render(appsPage([summary(), draftOnly], NO_APP_RIGHTS));
    const memberCards = member.split("<li").slice(1);
    expect(memberCards[0]).toMatch(/>Open<\/a>/u);
    expect(memberCards[0]).toContain("Changed yesterday");
    expect(member).not.toContain(">Edit</a>");
    expect(member).not.toContain("angebotsrechner</code>");
    // The menu keeps what a member may do beside opening: copying the link.
    expect(memberCards[0]).toContain('aria-label="Actions for Angebotsrechner"');
    // Nothing is published of the second one: its card says so and opens nothing.
    expect(memberCards[1]).toContain("Draft only");
    expect(memberCards[1]).not.toContain("<a ");
    expect(memberCards[1]).not.toContain("<button");
    expect(memberCards[1]).not.toContain('data-card-target=""');

    expect(render(appsPage([summary()], NO_APP_RIGHTS), "de")).toContain("Geändert gestern");
    // The card's target is named as one sentence with the App's name, in either language.
    expect(cards[0]).toContain('aria-label="Open Angebotsrechner"');
    expect(cards[1]).toContain('aria-label="Edit Urlaubsplaner"');
    expect(render(appsPage([summary()], NO_APP_RIGHTS), "de")).toContain(
      'aria-label="Angebotsrechner öffnen"'
    );
  });

  it("keeps the draft's news from a reader who does not write", () => {
    const markup = render(appsPage([summary()], { ...NO_APP_RIGHTS, publish: true }));

    expect(markup).toContain("Published · revision 2");
    expect(markup).not.toContain("Unpublished changes");
  });

  it("shows whoever only uses Apps the App, without its revision, its id or its workspace", () => {
    const markup = render(
      appsPage(
        [summary(), summary({ name: "urlaubsplaner", title: "Urlaubsplaner", description: "" })],
        NO_APP_RIGHTS
      )
    );

    expect(markup).toContain("Angebotsrechner");
    expect(markup).toContain("Rechnet ein Angebot aus Tagessatz und Tagen.");
    expect(markup).toContain("Urlaubsplaner");
    expect(markup).toContain('href="/w/cw_1/apps/urlaubsplaner"');
    expect(markup).not.toContain("Published");
    expect(markup).not.toContain("<code");
    expect(markup).not.toContain("Nordlicht Beratung");
    // The right to read the record alone makes nobody a builder.
    expect(render(appsPage([summary()], { ...NO_APP_RIGHTS, read: true }))).not.toContain(
      "Published"
    );
  });

  it("says to everybody that an App has nothing published", () => {
    const markup = render(
      appsPage([summary({ publishedRevision: undefined, draftRevision: undefined })], NO_APP_RIGHTS)
    );

    expect(markup).toContain("Draft only");
  });

  it("tells a builder how an App comes to be, with the agent and two examples", () => {
    const markup = render(appsPage([], ALL));

    expect(markup).toContain(
      "No apps in this workspace yet. Describe a tool to the agent and it builds it. Saved as an app, it is yours to use; publishing it decides who else sees it."
    );
    expect(markup).toContain(">Build one with the agent</button>");
    expect(markup).toContain('aria-label="Examples to start with"');
    expect(markup).toContain(">Fee calculator<");
    expect(markup).toContain("Leave request for the team");
  });

  it("tells everybody else what an App is, without an action and without who could add one", () => {
    const markup = render(appsPage([], NO_APP_RIGHTS));

    expect(markup).toContain(
      "No apps yet. An app is a small tool for this workspace, such as a fee calculator or a leave request."
    );
    expect(markup).not.toContain("builder");
    expect(markup).not.toContain("Build one with the agent");
    expect(markup).not.toContain(">Fee calculator<");
  });

  it("offers the next page while the instance holds more, and the way to ask again", () => {
    expect(render(appsPage([summary()], ALL, { hasMore: true }))).toContain(">Show more</button>");
    const failed = render(appsPage(undefined, ALL, { failed: true }));

    expect(failed).toContain("The apps could not be loaded.");
    expect(failed).toContain(">Try again</button>");
  });

  it("is written in German as well", () => {
    const markup = render(appsPage([], ALL), "de");

    expect(markup).toContain(de("apps.empty"));
    expect(markup).toContain(">Eine mit dem Agenten bauen</button>");
    expect(de("apps.empty")).not.toBe(t("apps.empty"));
    expect(render(appsPage([summary()], ALL), "de")).toContain("Veröffentlicht · Revision 2");
  });
});
