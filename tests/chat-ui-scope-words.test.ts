// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import {
  AgentKnowledge,
  agentAudience,
  assetAudience,
  assetPlace,
  createTranslationContext,
  NewAssetAvailability,
  refusalPlaceOf,
  shareUpTo,
  tellRefusal,
  TranslationProvider,
  unreachablePlaces
} from "./support/chat-ui";

// SCOPE-WORDS: one ladder of words for where an asset sits ("Nur ich", a workspace by its name,
// "Alle"), the same on every screen of Studio; a picker shows what cannot be used there greyed
// with its reason and the share step, as the one owner check decides; a cross-place refusal says
// in plain words why, and what to do next; a Knowledge Base and a Connection of everyone say who
// uses them.

const en = createTranslationContext("en").t;

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

describe("the place ladder", () => {
  it("names the rung of each place, and a workspace the reader is not shown never by its id", () => {
    expect(assetPlace(everyone, workspaces, en).rung).toBe("all");
    expect(assetPlace(mine, workspaces, en).rung).toBe("mine");
    expect(assetPlace(team, workspaces, en)).toEqual({ rung: "workspace", name: "Controlling" });
    expect(assetPlace({ kind: "workspace", workspaceId: "cws_x" }, workspaces, en).name).not.toBe(
      "cws_x"
    );
  });

  it("says when no chat can choose an agent for everyone", () => {
    const agent = (availability?: {
      mode: "all" | "selected" | "all_except";
      collaborationWorkspaceIds: string[];
      personalWorkspaces: boolean;
    }) => ({ scope: everyone, ...(availability ? { availability } : {}) });
    expect(
      agentAudience(
        agent({ mode: "selected", collaborationWorkspaceIds: [], personalWorkspaces: false }),
        workspaces,
        en,
        "en"
      )
    ).toMatchObject({ nowhere: true });
    expect(
      agentAudience(
        agent({ mode: "all", collaborationWorkspaceIds: [], personalWorkspaces: false }),
        workspaces,
        en,
        "en"
      )
    ).not.toHaveProperty("nowhere");
    // An agent of a workspace is used there: its place says so already.
    expect(agentAudience({ scope: team }, workspaces, en, "en")).toBeUndefined();
  });
});

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

  it("offers to share up to the agent's place, never down or sideways", () => {
    expect(shareUpTo(mine, everyone, workspaces, en)?.to).toEqual({ kind: "instance" });
    expect(shareUpTo(mine, team, workspaces, en)?.to).toEqual({
      kind: "workspace",
      workspaceId: TEAM,
      name: "Controlling"
    });
    // A team's asset does not go down to the reader alone.
    expect(shareUpTo(team, mine, workspaces, en)).toBeUndefined();
  });
});

describe("a refusal for something of another place", () => {
  it("says why and what to do, and never sends to the CLI", () => {
    const place = refusalPlaceOf(workspaces);
    const refusal = (owner: unknown, usedOwner: unknown) => ({
      reason: "invalid_scope",
      reference: { kind: "skill", name: "steuer", owner: usedOwner },
      owner
    });
    const messages = [
      tellRefusal(refusal(everyone, mine), en, place)?.message,
      tellRefusal(refusal(team, mine), en, place)?.message,
      tellRefusal(
        refusal(
          { kind: "workspace", workspaceId: "cws_x" },
          { kind: "workspace", workspaceId: "y" }
        ),
        en
      )?.message
    ];
    for (const message of messages) {
      expect(message).toBeDefined();
      expect(message).not.toMatch(/CLI|scope|cws_x/iu);
    }
  });
});

describe("a new agent made under Only me", () => {
  it("offers an admin no availability everywhere", () => {
    const markup = (onlyMine: boolean) =>
      renderToStaticMarkup(
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(
            UiRoot,
            { mode: "light", labels: uiLabelsEn },
            createElement(NewAssetAvailability, {
              startsIn: {
                workspace: { id: MINE, name: "Only me" },
                mayChooseAll: true,
                ...(onlyMine ? { onlyMine } : {})
              },
              everywhere: false,
              onChange: () => undefined
            })
          )
        )
      );
    expect(markup(true)).toMatch(/<option value="all" disabled="">/u);
    expect(markup(false)).toMatch(/<option value="all">/u);
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

  it("says when no agent may use one of everyone, and nothing for one of a workspace", () => {
    expect(assetAudience("connection", { scope: everyone }, workspaces, en, "en")).toMatchObject({
      nowhere: true
    });
    expect(
      assetAudience("knowledge_base", { scope: everyone, availability: all }, workspaces, en, "en")
    ).not.toHaveProperty("nowhere");
    expect(
      assetAudience("knowledge_base", { scope: team, availability: all }, workspaces, en, "en")
    ).toBeUndefined();
    expect(
      assetAudience("skill", { scope: everyone, availability: all }, workspaces, en, "en")
    ).toBeUndefined();
  });
});
