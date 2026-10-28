// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import {
  AgentSkills,
  agentAudience,
  assetPlace,
  createTranslationContext,
  NewAssetAvailability,
  refusalPlaceOf,
  tellRefusal,
  TranslationProvider
} from "./support/chat-ui";

// SCOPE-WORDS: one ladder of words for where an asset sits ("Nur ich", a workspace by its name,
// "Alle"), the same on every screen of Studio; a picker shows what cannot be used there greyed
// with its reason; and a cross-place refusal says in plain words why, and what to do next.

const en = createTranslationContext("en").t;
const de = createTranslationContext("de").t;

const MINE = "cws_mine";
const TEAM = "cws_team";
const workspaces = [
  { id: MINE, name: "Kai's workspace", member: true, personal: true as const },
  { id: TEAM, name: "Controlling", member: true }
];

describe("the place ladder", () => {
  it("names the instance Everyone, the reader's own Only me, and a team by its name", () => {
    expect(assetPlace({ kind: "instance" }, workspaces, de)).toEqual({
      rung: "all",
      name: "Alle"
    });
    expect(assetPlace({ kind: "workspace", workspaceId: MINE }, workspaces, de)).toEqual({
      rung: "mine",
      name: "Nur ich"
    });
    expect(assetPlace({ kind: "workspace", workspaceId: TEAM }, workspaces, en)).toEqual({
      rung: "workspace",
      name: "Controlling"
    });
    // A workspace the reader is not shown is named by no name, never by its id.
    expect(assetPlace({ kind: "workspace", workspaceId: "cws_x" }, workspaces, en)).toEqual({
      rung: "workspace",
      name: "Another workspace"
    });
  });

  it("says where a chat can choose an agent for everyone, and when no chat can", () => {
    const agent = (availability?: {
      mode: "all" | "selected";
      collaborationWorkspaceIds: string[];
      personalWorkspaces: boolean;
    }) => ({ scope: { kind: "instance" as const }, ...(availability ? { availability } : {}) });
    expect(
      agentAudience(
        agent({ mode: "all", collaborationWorkspaceIds: [], personalWorkspaces: false }),
        workspaces,
        de,
        "de"
      )
    ).toEqual({ text: "Wählbar in: Alle Arbeitsbereiche" });
    expect(
      agentAudience(
        agent({ mode: "selected", collaborationWorkspaceIds: [TEAM], personalWorkspaces: true }),
        workspaces,
        de,
        "de"
      )
    ).toEqual({ text: "Wählbar in: Controlling und Persönliche Arbeitsbereiche" });
    // Offered nowhere: the outcome in plain words, which the page links to "Verfügbar in".
    expect(
      agentAudience(
        agent({ mode: "selected", collaborationWorkspaceIds: [], personalWorkspaces: false }),
        workspaces,
        de,
        "de"
      )
    ).toEqual({ text: "In keinem Chat wählbar", nowhere: true });
    expect(
      agentAudience(
        agent({ mode: "selected", collaborationWorkspaceIds: [], personalWorkspaces: false }),
        workspaces,
        en,
        "en"
      )
    ).toEqual({ text: "Cannot be chosen in any chat", nowhere: true });
    expect(agentAudience({ ...agent(), agentUse: "granted" }, workspaces, en, "en")).toEqual({
      text: "Only people with the right to use it"
    });
    // An agent of a workspace is used there: its place says so already.
    expect(
      agentAudience({ scope: { kind: "workspace", workspaceId: TEAM } }, workspaces, en, "en")
    ).toBeUndefined();
  });
});

describe("a refusal for something of another place", () => {
  const place = refusalPlaceOf(workspaces);
  const refusal = (owner: unknown, usedOwner: unknown) => ({
    reason: "invalid_scope",
    reference: { kind: "skill", name: "steuer", owner: usedOwner },
    owner
  });

  it("says, for an agent for everyone using the reader's own skill, why and what to do", () => {
    const details = refusal({ kind: "instance" }, { kind: "workspace", workspaceId: MINE });
    expect(tellRefusal(details, de, place)?.message).toBe(
      "Das ist für alle, verwendet aber etwas, das nur dir gehört. Was für alle ist, kann nur verwenden, was auch für alle ist. Lege es unter „Alle“ an oder bitte einen Admin darum."
    );
    expect(tellRefusal(details, en, place)?.message).toBe(
      "This is for everyone, but it uses something only you have. Something for everyone can only use what is for everyone too. Make that item under “Everyone”, or ask an admin to."
    );
  });

  it("names the team and the reader's own place, and never sends to the CLI", () => {
    const team = tellRefusal(
      refusal({ kind: "workspace", workspaceId: TEAM }, { kind: "workspace", workspaceId: MINE }),
      de,
      place
    )?.message;
    expect(team).toBe(
      "Das gehört zu Controlling und verwendet etwas, das nur dir gehört. Es kann nur verwenden, was zu Controlling gehört oder für alle ist. Lege es in Controlling an oder bitte einen Admin darum."
    );
    const mine = tellRefusal(
      refusal({ kind: "workspace", workspaceId: MINE }, { kind: "workspace", workspaceId: TEAM }),
      en,
      place
    )?.message;
    expect(mine).toBe(
      "This is yours alone and uses something of Controlling. It can only use what is yours or for everyone. Make that item under “Only me”."
    );
    // Without names to tell, the sentence still says why and what to do.
    const unnamed = tellRefusal(
      refusal({ kind: "workspace", workspaceId: "cws_x" }, { kind: "workspace", workspaceId: "y" }),
      en
    )?.message;
    expect(unnamed).toBe(
      "This uses something from another workspace. It can only use what belongs to its own workspace or is for everyone. Make that item there, or ask an admin to."
    );
    for (const message of [team, mine, unnamed]) expect(message).not.toMatch(/CLI|scope/iu);
  });
});

describe("a new agent made under Only me", () => {
  it("offers an admin no availability everywhere, greyed with the reason", () => {
    const markup = (onlyMine: boolean) =>
      renderToStaticMarkup(
        createElement(
          TranslationProvider,
          { locale: "de", children: null },
          createElement(
            UiRoot,
            { mode: "light", labels: uiLabelsEn },
            createElement(NewAssetAvailability, {
              startsIn: {
                workspace: { id: MINE, name: "Nur ich" },
                mayChooseAll: true,
                ...(onlyMine ? { onlyMine } : {})
              },
              everywhere: false,
              onChange: () => undefined
            })
          )
        )
      );
    const mine = markup(true);
    expect(mine).toMatch(/<option value="all" disabled="">Alle Arbeitsbereiche<\/option>/u);
    expect(mine).toContain(
      "Das ist „Nur ich“ und kann darum keinem Team und nicht allen angeboten werden."
    );
    expect(markup(false)).toMatch(/<option value="all">/u);
  });
});

describe("the skill chooser of an agent", () => {
  const unmounts: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const unmount of unmounts.splice(0)) await unmount();
  });

  it("shows the reader's own skill greyed, with the reason it cannot be chosen here", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const chosen: string[][] = [];
    await act(async () => {
      root.render(
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(
            UiRoot,
            { mode: "light", labels: uiLabelsEn },
            createElement(AgentSkills, {
              choice: {
                options: [{ name: "offers", title: "Check offers" }],
                onSearch: () => undefined,
                unusable: [
                  {
                    name: "my-tax",
                    title: "My tax steps",
                    reason: "Only yours. An agent for everyone cannot use it."
                  }
                ]
              },
              value: [],
              editable: true,
              onChange: (names) => chosen.push(names)
            })
          )
        )
      );
    });
    unmounts.push(async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    });
    const opener = required(container.querySelector<HTMLElement>('button[aria-label^="Skills"]'));
    await act(async () => opener.click());
    const rows = () => [...document.querySelectorAll<HTMLElement>("[cmdk-item]")];
    await vi.waitFor(() => expect(rows()).toHaveLength(2), { timeout: CONDITION_WAIT_MS });
    const greyed = required(rows().find((row) => row.textContent?.startsWith("My tax steps")));
    expect(greyed.getAttribute("aria-disabled")).toBe("true");
    expect(greyed.textContent).toContain("Only yours. An agent for everyone cannot use it.");
    await act(async () => greyed.click());
    expect(chosen).toEqual([]);
  });
});
