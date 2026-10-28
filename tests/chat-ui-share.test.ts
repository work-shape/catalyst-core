// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { UiRoot, uiLabelsDe } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import {
  AssetShareDialog,
  shareSubmitHeld,
  shareSubmitLabel,
  shareTargets,
  TranslationProvider,
  type AssetShareCheck,
  type AssetShareSource
} from "./support/chat-ui";
import { idleActions, InboxItemView, item, render } from "./chat-ui-inbox-harness";

// SHARE-1 "Teilen mit…": the dialog offers the rungs above an asset, shows what the instance's
// check says the move does, and sends it as a share with the right at the target or as a
// request without it. What breaks waits for a confirmation; a refused move shows the
// instance's sentence and cannot be sent. Whoever decides a request reads the same summary in
// the Inbox, and a request that ended says why in plain words.

const MINE = "cws_mine";
const TEAM = "cws_team";
const workspaces = [
  { id: MINE, name: "Kais Arbeitsbereich", member: true, personal: true as const },
  { id: TEAM, name: "Controlling", member: true },
  { id: "cws_other", name: "Vertrieb", member: false }
];

function check(overrides: Partial<AssetShareCheck> = {}): AssetShareCheck {
  return {
    asset: { kind: "skill", name: "steuer", id: "ast_1" },
    from: { kind: "workspace", workspaceId: MINE },
    to: { kind: "workspace", workspaceId: TEAM },
    path: "direct",
    moves: [
      { kind: "skill", name: "steuer", id: "ast_1", title: "Steuerprüfung" },
      { kind: "data_store", name: "belege", id: "ast_2", title: "Belege" }
    ],
    breaks: [],
    afterwards: {
      owner: { kind: "workspace", workspaceId: TEAM, rung: "team", workspaceName: "Controlling" },
      editors: "workspace_builders",
      users: "workspace_members",
      callerEdits: true,
      grantsDropped: { onAssets: 2, runAccounts: 0 }
    },
    data: [
      {
        kind: "data_store",
        name: "belege",
        title: "Belege",
        sentence: "Die Daten in „Belege“ gehen mit und sind dann für das Team „Controlling“ lesbar."
      }
    ],
    ...overrides
  };
}

describe("the rungs a share offers", () => {
  it("goes up only: from Nur ich to the reader's teams and Alle, from a team to Alle", () => {
    expect(shareTargets({ kind: "workspace", workspaceId: MINE }, workspaces)).toEqual([
      { kind: "workspace", workspaceId: TEAM, name: "Controlling" },
      { kind: "instance" }
    ]);
    expect(shareTargets({ kind: "workspace", workspaceId: TEAM }, workspaces)).toEqual([
      { kind: "instance" }
    ]);
    expect(shareTargets({ kind: "instance" }, workspaces)).toEqual([]);
    // An App cannot belong to everyone: from a team it goes nowhere.
    expect(
      shareTargets({ kind: "workspace", workspaceId: TEAM }, workspaces, { toEveryone: false })
    ).toEqual([]);
  });

  it("says Teilen with the right at the target, Anfrage senden without it, and waits for breaks", () => {
    expect(shareSubmitLabel({ path: "direct" })).toBe("share.submitDirect");
    expect(shareSubmitLabel({ path: "request" })).toBe("share.submitRequest");
    expect(shareSubmitHeld({ status: "checking" }, false)).toBe(true);
    expect(shareSubmitHeld({ status: "refused", message: "Nein." }, true)).toBe(true);
    expect(shareSubmitHeld({ status: "ready", check: check() }, false)).toBe(false);
    const breaking = check({
      breaks: [
        { kind: "agent", name: "helfer", title: "Helfer", uses: { kind: "skill", name: "steuer" } }
      ]
    });
    expect(shareSubmitHeld({ status: "ready", check: breaking }, false)).toBe(true);
    expect(shareSubmitHeld({ status: "ready", check: breaking }, true)).toBe(false);
  });
});

describe("the share dialog", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function open(source: AssetShareSource) {
    const onMoved = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        createElement(
          TranslationProvider,
          { locale: "de", children: null },
          createElement(
            UiRoot,
            { mode: "light", labels: uiLabelsDe },
            createElement(AssetShareDialog, {
              open: true,
              subject: {
                kind: "skill",
                name: "steuer",
                title: "Steuerprüfung",
                id: "ast_1",
                owner: { kind: "workspace", workspaceId: MINE }
              },
              targets: shareTargets({ kind: "workspace", workspaceId: MINE }, workspaces),
              source,
              onClose,
              onMoved
            })
          )
        )
      );
    });
    return { onMoved, onClose };
  }

  const dialog = () => required(document.querySelector<HTMLElement>("[data-share-dialog]"));
  const submit = () => required(document.querySelector<HTMLButtonElement>("[data-share-submit]"));
  const text = () => document.body.textContent ?? "";

  it("shares at once with the right at the target, and says what goes along and who reads it", async () => {
    const move = vi.fn<AssetShareSource["move"]>().mockResolvedValue({ status: "moved" });
    const { onMoved } = await open({ check: () => Promise.resolve(check()), move });
    await vi.waitFor(() => expect(submit().dataset.shareSubmit).toBe("direct"), {
      timeout: CONDITION_WAIT_MS
    });
    expect(dialog().textContent).toContain("Mit wem?");
    expect(text()).toContain("„Steuerprüfung“ teilen");
    expect(text()).toContain("„Steuerprüfung“ und was es von hier verwendet:");
    expect(text()).toContain("Belege");
    expect(text()).toContain(
      "Die Daten in „Belege“ gehen mit und sind dann für das Team „Controlling“ lesbar."
    );
    expect(text()).toContain("Die Mitglieder von Controlling");
    expect(text()).toContain("Wer in Controlling bauen darf");
    expect(text()).toContain("Du auch.");
    expect(text()).toContain("2 Rechte auf einzelne Teile enden, weil das Ändern dem Ort folgt.");
    expect(submit().textContent).toBe("Teilen");
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    expect(move).toHaveBeenCalledWith(
      expect.objectContaining({ name: "steuer" }),
      { kind: "workspace", workspaceId: TEAM, name: "Controlling" },
      false
    );
    expect(onMoved).toHaveBeenCalledWith(
      { status: "moved" },
      { kind: "workspace", workspaceId: TEAM, name: "Controlling" }
    );
  });

  it("sends a request without the right at the target, and says it was sent", async () => {
    const toAll = check({
      path: "request",
      to: { kind: "instance" },
      afterwards: {
        owner: { kind: "instance", rung: "everyone" },
        editors: "instance_builders",
        users: "everyone_where_offered",
        callerEdits: false,
        grantsDropped: { onAssets: 0, runAccounts: 0 }
      },
      data: []
    });
    const move = vi.fn<AssetShareSource["move"]>().mockResolvedValue({ status: "requested" });
    const { onMoved } = await open({ check: () => Promise.resolve(toAll), move });
    await vi.waitFor(() => expect(submit().dataset.shareSubmit).toBe("request"), {
      timeout: CONDITION_WAIT_MS
    });
    expect(submit().textContent).toBe("Anfrage senden");
    expect(text()).toContain("Dort darfst du nicht selbst teilen.");
    expect(text()).toContain("Admins und wer für alle bauen darf");
    expect(text()).toContain("Du dann nicht mehr.");
    expect(text()).not.toContain("Rechte, die enden");
    await act(async () => submit().click());
    expect(onMoved).not.toHaveBeenCalled();
    expect(document.querySelector("[data-share-requested]")?.textContent).toContain(
      "Anfrage gesendet."
    );
  });

  it("holds the share until the reader confirmed what breaks, then sends that confirmation", async () => {
    const breaking = check({
      breaks: [
        { kind: "agent", name: "helfer", title: "Helfer", uses: { kind: "skill", name: "steuer" } }
      ]
    });
    const move = vi.fn<AssetShareSource["move"]>().mockResolvedValue({ status: "moved" });
    await open({ check: () => Promise.resolve(breaking), move });
    await vi.waitFor(() => expect(document.querySelector("[data-share-breaks]")).not.toBeNull(), {
      timeout: CONDITION_WAIT_MS
    });
    expect(text()).toContain("Das funktioniert danach nicht mehr");
    expect(text()).toContain("„Helfer“ verwendet „Steuerprüfung“");
    expect(submit().disabled).toBe(true);
    const confirm = required(
      document.querySelector<HTMLButtonElement>('[data-share-accept-breaks][role="checkbox"]')
    );
    await act(async () => confirm.click());
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    expect(move).toHaveBeenCalledWith(expect.anything(), expect.anything(), true);
  });

  it("shows the instance's sentence for a refused move and sends nothing", async () => {
    const sentence =
      "„Steuerprüfung“ nutzt das Werkzeug „mail“, das in „Controlling“ nicht erlaubt ist.";
    const move = vi.fn<AssetShareSource["move"]>();
    await open({
      check: () =>
        Promise.reject(
          new ApiError(422, sentence, {
            error: {
              code: "VALIDATION_FAILED",
              message: sentence,
              details: { reason: "move_build_limits" }
            }
          })
        ),
      move
    });
    await vi.waitFor(
      () => expect(document.querySelector("[data-share-refused]")?.textContent).toBe(sentence),
      { timeout: CONDITION_WAIT_MS }
    );
    expect(submit().disabled).toBe(true);
    await act(async () => submit().click());
    expect(move).not.toHaveBeenCalled();
  });
});

describe("a request to share in the Inbox", () => {
  const toAll = check({
    path: "direct",
    to: { kind: "instance" },
    moves: [{ kind: "skill", name: "steuer", id: "ast_1", title: "Steuerprüfung" }],
    afterwards: {
      owner: { kind: "instance", rung: "everyone" },
      editors: "instance_builders",
      users: "everyone_where_offered",
      callerEdits: true,
      grantsDropped: { onAssets: 1, runAccounts: 0 }
    },
    data: []
  });
  const request = (overrides: Parameters<typeof item>[0] = {}) =>
    render(
      createElement(InboxItemView, {
        state: {
          status: "ready",
          request: item({
            kind: "skill_move",
            summary: "assets.move",
            requestedBy: { id: "user-tim", displayLabel: "Tim Becker" },
            payload: { to: { kind: "instance" } },
            preview: toAll,
            canDecide: true,
            ...overrides
          })
        },
        actions: idleActions
      })
    );

  it("says who asks to share what with whom, the same summary, and Annehmen or Ablehnen", () => {
    const markup = request();
    expect(markup).toMatch(/>Tim Becker möchte „Steuerprüfung“ für alle teilen<\/h3>/u);
    expect(markup).toContain("Alle, denen es angeboten wird");
    expect(markup).toContain("Admins und wer für alle bauen darf");
    // The approver reads who edits it afterwards, not whether they themselves do.
    expect(markup).not.toContain("Du auch.");
    expect(markup).toContain("1 Recht auf ein einzelnes Teil endet");
    expect(markup).toMatch(/data-decision="reject"[^>]*>Ablehnen</u);
    expect(markup).toMatch(/data-decision="approve"[^>]*>Annehmen</u);
    expect(markup).not.toContain('data-decision="request_changes"');
  });

  it("names the team for a request into a team", () => {
    const toTeam = render(
      createElement(InboxItemView, {
        state: {
          status: "ready",
          request: item({
            kind: "agent_move",
            summary: "assets.move",
            requestedBy: { id: "user-tim", displayLabel: "Tim Becker" },
            preview: check({ path: "request" }),
            canDecide: true
          })
        },
        actions: idleActions
      })
    );
    expect(toTeam).toMatch(/>Tim Becker möchte „Steuerprüfung“ mit Controlling teilen<\/h3>/u);
  });

  it("says in plain words why a request ended without a move", () => {
    const reason = "Tim Becker ist nicht mehr Mitglied von „Controlling“. Es wurde nichts geteilt.";
    const markup = request({
      status: "superseded",
      canDecide: false,
      applyResult: { reason: "move_requester_not_member", message: reason }
    });
    expect(markup).toMatch(new RegExp(`data-asset-move-ended=""[^>]*>[\\s\\S]*${reason}`, "u"));
    expect(markup).not.toContain('data-decision="approve"');
  });

  it("offers only Ablehnen while the move no longer is what was asked", () => {
    const stale = "Was mitgehen würde, hat sich seit der Anfrage geändert.";
    const markup = request({
      preview: { asset: { kind: "skill", name: "steuer", id: "ast_1" }, stale }
    });
    expect(markup).toContain(stale);
    expect(markup).toMatch(/data-decision="reject"[^>]*>Ablehnen</u);
    expect(markup).not.toContain('data-decision="approve"');
  });
});
