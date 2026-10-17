import { createElement, createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type LocaleCode, type OperationOutcome } from "@work-shape/catalyst-api-client";
import {
  AgentEditor,
  AgentProposalNotice,
  agentConfigToForm,
  answerOfRevision,
  decideProposal,
  listChange,
  proposedAgentFields,
  readProposalRefusal,
  type AgentProposalState,
  type BuildAssetEditorProps
} from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// TRY-1a2: the agent page marks the fields the agent in the dock proposes to change, shows the
// proposed value under each, and offers Apply and Discard to a reader who may change the agent.
// Apply names the proposal revision read; a newer one and a stale base never apply.

const live = {
  name: "assistant",
  displayName: "Assistant",
  instructions: "Help the user.",
  toolNames: [],
  skillNames: ["tax-review"],
  initialPrompts: []
};

const noop = () => undefined;

function frame(canWrite: boolean): BuildAssetEditorProps {
  return {
    page: { ref: createRef<HTMLDivElement>(), above: null, shown: noop },
    asset: {
      id: "asset_agent",
      kind: "agent",
      name: "assistant",
      scope: { kind: "instance" },
      revision: 3,
      config: live,
      updatedAt: "2026-10-17T01:00:00.000Z"
    },
    start: undefined,
    canWrite,
    instanceWrite: false,
    back: null,
    actions: {},
    notice: null,
    onUnsavedChange: noop,
    save: async () => ({ ok: true })
  };
}

function proposalState(
  config: Record<string, unknown>,
  overrides: Partial<AgentProposalState> & { stale?: boolean } = {}
): AgentProposalState {
  const { stale = false, ...rest } = overrides;
  return {
    proposal: { revision: 2, stale, config },
    decide: { apply: async () => undefined, discard: async () => undefined },
    busy: undefined,
    answer: undefined,
    ...rest
  };
}

function agentPage(
  proposal: AgentProposalState | undefined,
  { canWrite = true, locale = "en" }: { canWrite?: boolean; locale?: LocaleCode } = {}
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(AgentEditor, {
        frame: frame(canWrite),
        initialForm: agentConfigToForm(live),
        isDefault: false,
        references: undefined,
        editableAgentFields: ["instructions", "skillNames"],
        canManageAgentModels: false,
        skillChoice: { options: [{ name: "tax-review", title: "Tax review" }], onSearch: noop },
        ...(proposal === undefined ? {} : { proposal })
      })
    )
  );
}

const proposed = {
  ...live,
  instructions: "Help the user and cite the contract.",
  skillNames: ["contract-check"]
};

/** The marks a page shows: the fields with a proposed value and the sections with a mark. */
function marks(markup: string) {
  return {
    fields: [...markup.matchAll(/data-proposed-field="([^"]+)"/gu)].map((match) => match[1]),
    sections: [...markup.matchAll(/data-proposed-section=""/gu)].length
  };
}

describe("the fields a proposal changes", () => {
  it("are the fields that differ from the live agent, in the order of the page", () => {
    const form = agentConfigToForm(live);
    expect(proposedAgentFields(form, form)).toEqual([]);
    expect(
      proposedAgentFields(
        form,
        agentConfigToForm({ ...proposed, modelBindingId: "fast", displayName: "Helper" })
      )
    ).toEqual(["displayName", "instructions", "model", "skillNames"]);
  });

  it("tell what a list gains and loses", () => {
    expect(listChange(["a", "b"], ["b", "c", "d"])).toEqual({ added: ["c", "d"], removed: ["a"] });
  });
});

describe("the agent page with a proposal", () => {
  it("marks each changed field with its proposed value and offers Apply and Discard", () => {
    const markup = agentPage(proposalState(proposed));
    expect(marks(markup)).toEqual({ fields: ["instructions", "skillNames"], sections: 2 });
    expect(markup).toContain("Help the user and cite the contract.");
    // The field still shows the live text; the proposal stands under it.
    expect(markup).toContain(">Help the user.</textarea>");
    expect(markup).toContain("Adds contract-check");
    expect(markup).toContain("Removes Tax review");
    expect(markup).toContain(
      "The agent proposes changes to 2 fields. They are marked below. If you apply them, they take effect at once for everyone who uses “Assistant”."
    );
    expect(markup).toContain("data-proposal-apply");
    expect(markup).toContain("data-proposal-discard");
    // Discard names what it throws away: the save bar's Discard is for the reader's own edits.
    expect(
      /<button[^>]*data-proposal-discard[^>]*>[\s\S]*?<\/button>/u.exec(markup)?.[0]
    ).toContain("Discard proposal");
  });

  it("shows no marks once the proposal is gone, as after Apply or Discard", () => {
    const markup = agentPage(undefined);
    expect(marks(markup)).toEqual({ fields: [], sections: 0 });
    expect(markup).not.toContain("data-agent-proposal");
  });

  it("offers no Apply or Discard to a reader who may not change the agent", () => {
    const markup = agentPage(proposalState(proposed, { decide: undefined }), { canWrite: false });
    expect(marks(markup).fields).toEqual(["instructions", "skillNames"]);
    expect(markup).not.toContain("data-proposal-apply");
    expect(markup).not.toContain("data-proposal-discard");
    // The reader is told who can apply it, not to apply it.
    expect(markup).toContain("Someone who may change this agent can apply them.");
    expect(markup).not.toContain("If you apply");
  });

  it("names the agent it changes in German, in typographic quotes", () => {
    expect(agentPage(proposalState(proposed), { locale: "de" })).toContain(
      "Der Agent schlägt Änderungen an 2 Feldern vor. Sie sind unten markiert. Übernimmst du sie, gelten sie sofort für alle, die „Assistant“ nutzen."
    );
    expect(
      agentPage(proposalState({ ...live, instructions: "Help." }), { locale: "de" })
    ).toContain("Der Agent schlägt eine Änderung an einem Feld vor. Sie ist unten markiert.");
  });

  it("names a proposed reasoning effort in the reader's language, not by its value", () => {
    const effort = proposalState({ ...live, reasoningEffort: "xhigh" });
    expect(agentPage(effort)).toContain(">Reasoning effort: Extra high</p>");
    expect(agentPage(effort, { locale: "de" })).toContain(">Denkaufwand: Sehr hoch</p>");
  });

  it("keeps a proposed value with its field, in one group", () => {
    const markup = agentPage(proposalState(proposed));
    expect(markup).toMatch(
      /data-proposed-group="instructions"[^>]*>(?:(?!data-proposed-group)[\s\S])*<textarea(?:(?!data-proposed-group)[\s\S])*data-proposed-field="instructions"/u
    );
  });

  it("locks the fields while Apply or Discard is on its way", () => {
    // Every section's controls sit in a fieldset that is disabled while a decision is on its way.
    const locked = (markup: string) => [...markup.matchAll(/<fieldset disabled=""/gu)].length;
    expect(locked(agentPage(proposalState(proposed)))).toBe(0);
    const busy = agentPage(proposalState(proposed, { busy: "apply" }));
    expect(locked(busy)).toBe([...busy.matchAll(/<fieldset/gu)].length);
    expect(locked(busy)).toBeGreaterThan(0);
  });

  it("says a stale proposal cannot be applied and to ask the agent in the chat again", () => {
    const markup = agentPage(proposalState(proposed, { stale: true }), { locale: "de" });
    expect(markup).toContain('data-agent-proposal="stale"');
    expect(markup).toContain(
      "Dieser Vorschlag lässt sich nicht mehr übernehmen. Bitte den Agenten im Chat, die Änderung noch einmal vorzuschlagen."
    );
    expect(marks(markup)).toEqual({ fields: [], sections: 0 });
    expect(markup).not.toContain("data-proposal-apply");
    expect(
      /<button[^>]*data-proposal-discard[^>]*>[\s\S]*?<\/button>/u.exec(markup)?.[0]
    ).toContain("Vorschlag verwerfen");
  });

  it("says the proposal changed when the agent wrote a newer one than was read", () => {
    const markup = agentPage(proposalState(proposed, { answer: { kind: "changed" } }));
    // One banner, which opens with the change and goes on with the proposal as it is now.
    expect(markup.match(/data-proposal-answer=/gu)).toHaveLength(1);
    expect(markup).toMatch(
      /data-agent-proposal="pending" data-proposal-answer="changed"[\s\S]*The agent changed its proposal while you were looking at it\.[\s\S]*The agent proposes changes to 2 fields/u
    );
  });

  it("says in words why Apply waits while the reader's own changes are not saved", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(AgentProposalNotice, {
          state: proposalState(proposed),
          name: "Assistant",
          changes: 2,
          unsaved: true
        })
      )
    );
    const reason = /<p id="([^"]+)">Save or discard your own changes first\.<\/p>/u.exec(markup);
    expect(reason).not.toBeNull();
    const apply = /<button[^>]*data-proposal-apply[^>]*>/u.exec(markup)?.[0] ?? "";
    expect(apply).toContain(`aria-describedby="${reason?.[1] ?? "none"}"`);
    expect(apply).not.toContain("title=");
  });

  it("drops the answer to an earlier revision once the agent wrote a newer one", () => {
    const stale = { sent: 2, answer: { kind: "stale" as const } };
    expect(answerOfRevision(stale, 2)).toEqual({ kind: "stale" });
    expect(answerOfRevision(stale, 3)).toBeUndefined();
  });
});

const refused = (status: number, code: string, reason: string) =>
  new ApiError(status, "refused", { error: { code, message: "refused", details: { reason } } });

describe("Apply and Discard", () => {
  const done: OperationOutcome<unknown> = {
    status: "done",
    output: {},
    operationRunId: "run_1",
    replayed: false
  };

  function decide(call: () => Promise<OperationOutcome<unknown>>) {
    const reloaded = vi.fn(async () => undefined);
    const reread = vi.fn(async () => undefined);
    return {
      answer: decideProposal({ call, done: reloaded, reread, failedMessage: "Try again." }),
      reloaded,
      reread
    };
  }

  it("reads the agent again once the proposal is applied", async () => {
    const run = decide(async () => done);
    await expect(run.answer).resolves.toBeUndefined();
    expect(run.reloaded).toHaveBeenCalledOnce();
  });

  it("never applies a proposal newer than the one read: it reads the proposal again", async () => {
    const run = decide(async () => {
      throw refused(412, "REVISION_CONFLICT", "draft_changed");
    });
    await expect(run.answer).resolves.toEqual({ kind: "changed" });
    expect(run.reloaded).not.toHaveBeenCalled();
    expect(run.reread).toHaveBeenCalledOnce();
  });

  it("tells a stale base apart from other refusals", async () => {
    const run = decide(async () => {
      throw refused(409, "CONFLICT", "stale_base");
    });
    await expect(run.answer).resolves.toEqual({ kind: "stale" });
    expect(run.reloaded).not.toHaveBeenCalled();
    expect(readProposalRefusal(refused(409, "CONFLICT", "revision_conflict"))).toBeUndefined();
  });

  it("says a decision that waits for an approval changed nothing yet", async () => {
    const run = decide(async () => ({
      status: "pending_approval",
      run: {},
      location: undefined,
      operationRunId: "run_2",
      replayed: false
    }));
    await expect(run.answer).resolves.toEqual({ kind: "waits" });
    expect(run.reloaded).not.toHaveBeenCalled();
  });

  it("tells any other refusal in the instance's words", async () => {
    const run = decide(async () => {
      throw refused(403, "FORBIDDEN", "missing_right");
    });
    await expect(run.answer).resolves.toEqual({ kind: "failed", message: "refused" });
  });
});
