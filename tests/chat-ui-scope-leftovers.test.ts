// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import {
  AgentKnowledge,
  assetAudience,
  assetPlace,
  createTranslationContext,
  shareUpTo,
  TranslationProvider,
  unreachablePlaces,
  unreachableReason
} from "./support/chat-ui";

// SCOPE-WORDS leftovers: an agent's Knowledge Base and skill choosers show what the reader sees
// in their other places greyed with the reason and the share step, as the one owner check
// decides; a Knowledge Base and a Connection of everyone say who uses them.

const en = createTranslationContext("en").t;
const de = createTranslationContext("de").t;

const MINE = "cws_mine";
const TEAM = "cws_team";
const OTHER = "cws_other";
const workspaces = [
  { id: MINE, name: "Kai's workspace", member: true, personal: true as const },
  { id: TEAM, name: "Controlling", member: true },
  // A team the reader is shown but not a member of: its assets are offered nowhere here.
  { id: OTHER, name: "Vertrieb", member: false }
];
const everyone = { kind: "instance" } as const;
const mine = { kind: "workspace", workspaceId: MINE } as const;
const team = { kind: "workspace", workspaceId: TEAM } as const;
const SKILL = {
  cannotAll: "build.skillCannotAll",
  cannotMine: "build.skillCannotMine",
  cannotIn: "build.skillCannotIn"
} as const;
const KNOWLEDGE = {
  cannotAll: "knowledge.agentCannotAll",
  cannotMine: "knowledge.agentCannotMine",
  cannotIn: "knowledge.agentCannotIn"
} as const;

describe("what an agent's chooser greys", () => {
  const ids = (owner: Parameters<typeof unreachablePlaces>[0]) =>
    unreachablePlaces(owner, workspaces).map((workspace) => workspace.id);

  it("is every other place of the reader's that the owner check refuses", () => {
    // An agent of everyone names nothing of a workspace: the reader's own and their team grey.
    expect(ids(everyone)).toEqual([MINE, TEAM]);
    // An agent of a team names its own and everyone's: the reader's own greys.
    expect(ids(team)).toEqual([MINE]);
    // An agent of the reader's own: their team greys.
    expect(ids(mine)).toEqual([TEAM]);
  });

  it("says where the asset sits and that an agent of this place cannot use it", () => {
    const place = (owner: typeof everyone | typeof mine | typeof team) =>
      assetPlace(owner, workspaces, de);
    expect(unreachableReason(place(mine), place(everyone), de, SKILL)).toBe(
      "Gehört nur dir. Ein Agent für alle kann ihn nicht verwenden."
    );
    expect(unreachableReason(place(team), place(everyone), de, SKILL)).toBe(
      "Liegt in Controlling. Ein Agent für alle kann ihn nicht verwenden."
    );
    expect(unreachableReason(place(mine), place(team), de, KNOWLEDGE)).toBe(
      "Gehört nur dir. Ein Agent von Controlling kann sie nicht verwenden."
    );
    expect(unreachableReason(place(team), place(mine), de, KNOWLEDGE)).toBe(
      "Liegt in Controlling. Ein Agent nur für dich kann sie nicht verwenden."
    );
    expect(
      unreachableReason(
        assetPlace(team, workspaces, en),
        assetPlace(everyone, workspaces, en),
        en,
        KNOWLEDGE
      )
    ).toBe("In Controlling. An agent for everyone cannot use it.");
  });

  it("offers to share up to the agent's place, never down or sideways", () => {
    expect(shareUpTo(mine, everyone, workspaces, de)).toEqual({
      to: { kind: "instance" },
      label: "Für alle teilen…"
    });
    expect(shareUpTo(team, everyone, workspaces, de)?.label).toBe("Für alle teilen…");
    expect(shareUpTo(mine, team, workspaces, de)).toEqual({
      to: { kind: "workspace", workspaceId: TEAM, name: "Controlling" },
      label: "Mit Controlling teilen…"
    });
    // A team's asset does not go down to the reader alone.
    expect(shareUpTo(team, mine, workspaces, de)).toBeUndefined();
  });
});

describe("the Knowledge Base chooser of an agent", () => {
  const unmounts: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const unmount of unmounts.splice(0)) await unmount();
  });

  it("shows one of another place greyed with the reason and the share step", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const chosen: string[][] = [];
    const shared: string[] = [];
    await act(async () => {
      root.render(
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(
            UiRoot,
            { mode: "light", labels: uiLabelsEn },
            createElement(AgentKnowledge, {
              choice: {
                options: [{ name: "policies", title: "Policies" }],
                onSearch: () => undefined,
                workspaceOwned: false,
                unusable: [
                  {
                    name: "my-notes",
                    title: "My notes",
                    reason: "Only yours. An agent for everyone cannot use it.",
                    share: {
                      label: "Share with everyone…",
                      onSelect: () => shared.push("my-notes")
                    }
                  },
                  {
                    name: "monthly",
                    title: "Monthly figures",
                    reason: "In Controlling. An agent for everyone cannot use it."
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
    const opener = required(
      container.querySelector<HTMLElement>(`button[aria-label^="${en("knowledge.agentSection")}"]`)
    );
    await act(async () => opener.click());
    const rows = () => [...document.querySelectorAll<HTMLElement>("[cmdk-item]")];
    await vi.waitFor(() => expect(rows()).toHaveLength(3), { timeout: CONDITION_WAIT_MS });
    const row = (title: string) =>
      required(rows().find((candidate) => candidate.textContent?.startsWith(title)));
    // Without a step of its own, a greyed row cannot be chosen.
    const team = row("Monthly figures");
    expect(team.getAttribute("aria-disabled")).toBe("true");
    expect(team.textContent).toContain("In Controlling. An agent for everyone cannot use it.");
    await act(async () => team.click());
    // With one, choosing it starts the share and never chooses the Knowledge Base.
    const own = row("My notes");
    expect(own.hasAttribute("data-picker-action")).toBe(true);
    expect(own.textContent).toContain("Share with everyone…");
    await act(async () => own.click());
    expect(shared).toEqual(["my-notes"]);
    expect(chosen).toEqual([]);
  });
});

describe("who uses a Knowledge Base or a Connection", () => {
  const all = { mode: "all" as const, collaborationWorkspaceIds: [], personalWorkspaces: false };

  it("names where agents may use one of everyone, and when none may", () => {
    expect(
      assetAudience("knowledge_base", { scope: everyone, availability: all }, workspaces, de, "de")
    ).toEqual({ text: "Agenten nutzen sie in: Alle Arbeitsbereiche" });
    expect(
      assetAudience(
        "connection",
        {
          scope: everyone,
          availability: {
            mode: "selected",
            collaborationWorkspaceIds: [TEAM],
            personalWorkspaces: true
          }
        },
        workspaces,
        en,
        "en"
      )
    ).toEqual({ text: "Agents use it in: Controlling and Personal workspaces" });
    // None stored is offered nowhere: the chip leads to "Available in".
    expect(assetAudience("connection", { scope: everyone }, workspaces, de, "de")).toEqual({
      text: "Noch kein Agent kann sie nutzen",
      nowhere: true
    });
  });

  it("says nothing more for one of a workspace, nor for a kind without availability", () => {
    expect(
      assetAudience("knowledge_base", { scope: team, availability: all }, workspaces, en, "en")
    ).toBeUndefined();
    expect(
      assetAudience("skill", { scope: everyone, availability: all }, workspaces, en, "en")
    ).toBeUndefined();
  });
});
