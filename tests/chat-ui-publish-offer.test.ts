import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  AssetPlacesProvider,
  offerChange,
  publishOffer,
  PublishOfferField,
  TranslationProvider
} from "./support/chat-ui";

// OFFER-ON-PUBLISH: the publish dialog of an agent asks where a chat can choose it. The answer
// starts at what holds today, or at the agent's own place where no chat can choose it; a reader
// without the right reads it as it is with who can change it; "Only me" is offered nowhere wider.

const TEAM = "cws_team";
const OTHER = "cws_other";
const workspaces = [
  { id: "cws_mine", name: "Kai", member: true, personal: true as const },
  { id: TEAM, name: "Controlling", member: true },
  { id: OTHER, name: "Vertrieb", member: true }
];
const NOWHERE = {
  mode: "selected" as const,
  personalWorkspaces: false,
  collaborationWorkspaceIds: []
};
const ALL = { mode: "all" as const, personalWorkspaces: false, collaborationWorkspaceIds: [] };
const inTeam = (...ids: string[]) => ({
  mode: "selected" as const,
  personalWorkspaces: false,
  collaborationWorkspaceIds: ids
});

describe("the place a publish offers an agent in", () => {
  it("starts an agent for everyone that no chat can choose at all workspaces, and lets it stay hidden", () => {
    const offer = publishOffer({ owner: { kind: "instance" }, saved: NOWHERE, maySet: true });
    expect(offer).toMatchObject({
      kind: "choice",
      preselected: "own",
      options: [
        { value: "own", availability: ALL },
        { value: "nowhere", availability: NOWHERE }
      ]
    });
    expect(offerChange(offer, "own")).toEqual(ALL);
    // Staying hidden changes nothing, so the publish sets nothing.
    expect(offerChange(offer, "nowhere")).toBeUndefined();
    // An agent never offered reads as offered nowhere.
    expect(publishOffer({ owner: { kind: "instance" }, saved: undefined, maySet: true })).toEqual(
      offer
    );
  });

  it("starts a team's agent that no chat can choose at its own team", () => {
    const offer = publishOffer({
      owner: { kind: "team", workspaceId: TEAM },
      saved: NOWHERE,
      maySet: true
    });
    expect(offer).toMatchObject({ kind: "choice", preselected: "own" });
    expect(offerChange(offer, "own")).toEqual(inTeam(TEAM));
  });

  it("keeps the place of an agent that is offered already", () => {
    const own = publishOffer({ owner: { kind: "instance" }, saved: ALL, maySet: true });
    expect(own).toMatchObject({ kind: "choice", preselected: "own", options: [{ value: "own" }] });
    expect(offerChange(own, "own")).toBeUndefined();

    const elsewhere = publishOffer({
      owner: { kind: "team", workspaceId: TEAM },
      saved: inTeam(TEAM, OTHER),
      maySet: true
    });
    expect(elsewhere).toMatchObject({
      kind: "choice",
      preselected: "keep",
      options: [
        { value: "keep", availability: inTeam(TEAM, OTHER) },
        { value: "own", availability: inTeam(TEAM) }
      ]
    });
    expect(offerChange(elsewhere, "keep")).toBeUndefined();
    // Withdrawing an offered agent is no answer of the publish dialog.
    expect(offerChange(elsewhere, "nowhere")).toBeUndefined();
  });

  it("shows a reader without the right the place as it is, read-only", () => {
    const offer = publishOffer({
      owner: { kind: "team", workspaceId: TEAM },
      saved: NOWHERE,
      maySet: false
    });
    expect(offer).toEqual({ kind: "fixed", current: NOWHERE });
    expect(offerChange(offer, "own")).toBeUndefined();
  });

  it("offers an agent of Only me nowhere wider, whoever reads it", () => {
    for (const maySet of [true, false]) {
      const offer = publishOffer({ owner: { kind: "mine" }, saved: NOWHERE, maySet });
      expect(offer).toEqual({ kind: "mine" });
      expect(offerChange(offer, "own")).toBeUndefined();
    }
  });
});

describe("the field of the publish dialog", () => {
  const markup = (offer: ReturnType<typeof publishOffer>, value: "own" | "keep" | "nowhere") =>
    renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de", children: null },
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(
            AssetPlacesProvider,
            { value: workspaces },
            createElement(PublishOfferField, {
              offer,
              value,
              disabled: false,
              onValueChange: () => undefined
            })
          )
        )
      )
    );

  it("asks where with the places the reader may set, the agent's own chosen", () => {
    const html = markup(
      publishOffer({ owner: { kind: "instance" }, saved: NOWHERE, maySet: true }),
      "own"
    );
    expect(html).toContain("Wählbar in:");
    expect(html).toContain("Alle Arbeitsbereiche");
    expect(html).toContain("Noch in keinem Chat");
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>.*?Alle Arbeitsbereiche/su);
    expect(html).not.toContain('disabled=""');

    const team = markup(
      publishOffer({ owner: { kind: "team", workspaceId: TEAM }, saved: NOWHERE, maySet: true }),
      "own"
    );
    expect(team).toContain("Controlling");
    expect(team).not.toContain("Alle Arbeitsbereiche");
  });

  it("shows the place read-only, with who can change it, to a reader without the right", () => {
    const html = markup(
      publishOffer({ owner: { kind: "instance" }, saved: NOWHERE, maySet: false }),
      "own"
    );
    expect(html).toContain("Wählbar in:");
    expect(html).toContain("Noch in keinem Chat");
    expect(html).toContain('disabled=""');
    expect(html).toContain(
      "Ändern darf das nur, wer unter „Alle“ das Recht „Agenten bearbeiten“ hat."
    );
  });

  it("offers an agent of Only me in its owner's own chats, with nothing to choose", () => {
    const html = markup(
      publishOffer({ owner: { kind: "mine" }, saved: NOWHERE, maySet: true }),
      "own"
    );
    expect(html).toContain("Wählbar in:");
    expect(html).toContain("In deinen eigenen Chats");
    expect(html).toContain("die sonst niemand liest");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Noch in keinem Chat");
  });
});
