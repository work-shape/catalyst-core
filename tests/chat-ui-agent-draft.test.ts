import { createElement, createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type AgentDraft,
  type LocaleCode,
  type OperationOutcome
} from "@work-shape/catalyst-api-client";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  AgentEditor,
  agentConfigToForm,
  answerOfRevision,
  decideDraft,
  draftAgentFields,
  draftAuthorLabel,
  readDraftRefusal,
  type AgentDraftSource,
  type ConnectionToolsRead,
  type BuildAssetEditorProps
} from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// AD-4, Navigation check 44 (component half): the agent page edits the agent's one draft. The
// fields show the draft and each changed field the published value under it; the head carries
// the draft badge with its revision, the banner its author and time, and Publish for a holder of
// agent.publish; a writer without that right sees Publish disabled with the right named.

const live = {
  name: "assistant",
  displayName: "Assistant",
  instructions: "Help the user.",
  toolNames: [],
  skillNames: ["tax-review"],
  initialPrompts: []
};

const drafted = {
  ...live,
  instructions: "Help the user and cite the contract.",
  skillNames: ["contract-check"]
};

const noop = () => undefined;

function frame(overrides: Partial<BuildAssetEditorProps> = {}): BuildAssetEditorProps {
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
    canWrite: true,
    draft: { canPublish: true },
    instanceWrite: false,
    back: null,
    actions: {},
    notice: null,
    onUnsavedChange: noop,
    save: async () => ({ ok: true }),
    ...overrides
  };
}

function draftOf(config: Record<string, unknown>, overrides: Partial<AgentDraft> = {}): AgentDraft {
  return {
    agent: "assistant",
    revision: 2,
    baseRevision: 3,
    liveRevision: 3,
    stale: false,
    config,
    author: { userId: "user_ana", name: "Ana Writer", release: false },
    updatedAt: "2026-10-17T09:30:00.000Z",
    ...overrides
  };
}

function source(
  latest: AgentDraft | null,
  overrides: Partial<AgentDraftSource> = {}
): AgentDraftSource {
  return {
    latest,
    reread: async () => undefined,
    saved: ({ revision, config, liveRevision }) =>
      draftOf(config, { revision, baseRevision: liveRevision }),
    decide: async () => undefined,
    busy: undefined,
    answerFor: () => undefined,
    ...overrides
  };
}

function agentPage(
  draft: AgentDraftSource | undefined,
  {
    locale = "en",
    frame: frameOverrides = {},
    connectionTools
  }: {
    locale?: LocaleCode;
    frame?: Partial<BuildAssetEditorProps>;
    connectionTools?: ConnectionToolsRead;
  } = {}
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(AgentEditor, {
        frame: frame(frameOverrides),
        initialForm: agentConfigToForm(draft?.latest?.config ?? live),
        isDefault: false,
        references: undefined,
        editableAgentFields: ["instructions", "skillNames"],
        canManageAgentModels: false,
        skillChoice: { options: [{ name: "tax-review", title: "Tax review" }], onSearch: noop },
        ...(connectionTools === undefined ? {} : { connectionTools: { read: connectionTools } }),
        ...(draft === undefined ? {} : { draft })
      })
    )
  );
}

/** The marks a page shows: the fields with a published value and the sections with a mark. */
function marks(markup: string) {
  return {
    fields: [...markup.matchAll(/data-published-field="([^"]+)"/gu)].map((match) => match[1]),
    sections: [...markup.matchAll(/data-draft-section=""/gu)].length
  };
}

const publishButton = (markup: string) => /<button[^>]*data-agent-publish[^>]*>/u.exec(markup)?.[0];

describe("the fields a draft changes", () => {
  it("are the fields that differ from the live agent, in the order of the page", () => {
    const form = agentConfigToForm(live);
    expect(draftAgentFields(form, form)).toEqual([]);
    expect(
      draftAgentFields(
        form,
        agentConfigToForm({ ...drafted, modelBindingId: "fast", displayName: "Helper" })
      )
    ).toEqual(["displayName", "instructions", "model", "skillNames"]);
  });
});

describe("the agent page with a draft", () => {
  it("shows the draft in the fields and the published value under each changed one", () => {
    const markup = agentPage(source(draftOf(drafted)));
    expect(marks(markup)).toEqual({ fields: ["instructions", "skillNames"], sections: 2 });
    // The field shows the draft; the published text stands under it.
    expect(markup).toContain(">Help the user and cite the contract.</textarea>");
    expect(markup).toMatch(/data-published-field="instructions"[\s\S]*Help the user\./u);
    expect(markup).toMatch(/data-published-field="skillNames"[\s\S]*?Tax review/u);
    expect(markup).toMatch(
      /Draft version 2, saved by Ana Writer on .+? 2026, .+?, is not live\. Everyone who uses “Assistant” gets the published version until the draft is published\./u
    );
  });

  it("names a published tool of a Connection by the Connection's title and the operation in words", () => {
    const tool = "connection.ledger.listClients";
    const markup = agentPage(source(draftOf(drafted)), {
      frame: {
        asset: {
          id: "asset_agent",
          kind: "agent",
          name: "assistant",
          scope: { kind: "instance" },
          revision: 3,
          config: { ...live, toolNames: [tool] },
          updatedAt: "2026-10-17T01:00:00.000Z"
        }
      },
      connectionTools: {
        status: "ready",
        connections: [
          {
            name: "ledger",
            title: "Ledger",
            tools: [{ toolName: tool, operation: "listClients", effect: "reading" }]
          }
        ]
      }
    });
    const published = /data-published-field="toolNames"[\s\S]*?<\/p>/u.exec(markup)?.[0] ?? "";
    expect(published).toContain("Ledger: List clients");
    expect(published).not.toContain(tool);
  });

  it("carries a short draft badge, and the banner names the author and the time", () => {
    const markup = agentPage(source(draftOf(drafted)));
    expect(markup).toMatch(/data-agent-draft-badge="2"[^>]*>(?:<span[^>]*>)?Draft version 2</u);
    expect(markup).toMatch(/data-agent-draft="pending"[\s\S]*saved by Ana Writer on .+? 2026/u);
    const german = agentPage(source(draftOf(drafted)), { locale: "de" });
    expect(german).toMatch(/data-agent-draft-badge="2"[^>]*>(?:<span[^>]*>)?Entwurfsversion 2</u);
    expect(german).toMatch(/Entwurfsversion 2, gespeichert von Ana Writer am /u);
  });

  it("offers Publish to a holder of agent.publish, and Discard in the menu", () => {
    const markup = agentPage(source(draftOf(drafted)));
    const publish = publishButton(markup) ?? "";
    expect(publish).not.toContain('disabled=""');
    expect(publish).not.toContain("aria-describedby");
    expect(markup).not.toContain("Publishing needs the right");
  });

  it("shows Publish disabled to a writer without agent.publish, with the right named", () => {
    const markup = agentPage(source(draftOf(drafted)), { frame: { draft: { canPublish: false } } });
    const publish = publishButton(markup) ?? "";
    expect(publish).toContain('disabled=""');
    const reason = /<p id="([^"]+)">Publishing needs the right “Publish agents”\.<\/p>/u.exec(
      markup
    );
    expect(reason).not.toBeNull();
    expect(publish).toContain(`aria-describedby="${reason?.[1] ?? "none"}"`);
    expect(
      agentPage(source(draftOf(drafted)), { locale: "de", frame: { draft: { canPublish: false } } })
    ).toContain("Veröffentlichen braucht das Recht „Agenten veröffentlichen“.");
  });

  it("offers no Publish for a stale draft and says why", () => {
    const markup = agentPage(source(draftOf(drafted, { stale: true, liveRevision: 4 })), {
      locale: "de"
    });
    expect(markup).toContain('data-agent-draft="stale"');
    expect(markup).toContain(
      "Die veröffentlichte Version von „Assistant“ hat sich geändert, nachdem dieser Entwurf geschrieben wurde."
    );
    expect(publishButton(markup)).toBeUndefined();
  });

  it("says a newer draft was read in place of the one Publish named", () => {
    const markup = agentPage(source(draftOf(drafted), { answerFor: () => ({ kind: "changed" }) }));
    expect(markup).toMatch(
      /data-agent-draft="pending"[\s\S]*Someone saved a newer draft while you were looking at it\.[\s\S]*Draft version 2, saved by Ana Writer on /u
    );
  });

  it("says what a decision that failed or waits for an approval answered", () => {
    const failed = agentPage(
      source(draftOf(drafted), { answerFor: () => ({ kind: "failed", message: "Not now." }) })
    );
    expect(failed).toMatch(/data-agent-draft-answer="failed"[^>]*>[\s\S]*Not now\./u);
    expect(agentPage(source(draftOf(drafted), { answerFor: () => ({ kind: "waits" }) }))).toContain(
      'data-agent-draft-answer="waits"'
    );
  });

  it("locks the fields while Publish or Discard is on its way", () => {
    const locked = (markup: string) => [...markup.matchAll(/<fieldset disabled=""/gu)].length;
    expect(locked(agentPage(source(draftOf(drafted))))).toBe(0);
    const busy = agentPage(source(draftOf(drafted), { busy: "publish" }));
    expect(locked(busy)).toBe([...busy.matchAll(/<fieldset/gu)].length);
    expect(locked(busy)).toBeGreaterThan(0);
  });
});

describe("the agent page without a draft", () => {
  it("shows the live agent with no badge, marks or Publish", () => {
    const markup = agentPage(source(null));
    expect(marks(markup)).toEqual({ fields: [], sections: 0 });
    expect(markup).not.toContain("data-agent-draft");
    expect(publishButton(markup)).toBeUndefined();
    expect(markup).toContain(">Help the user.</textarea>");
  });

  it("shows a reader nothing of a draft", () => {
    const markup = agentPage(undefined, {
      frame: { canWrite: false, draft: { canPublish: false } }
    });
    expect(markup).not.toContain("data-agent-draft");
    expect(publishButton(markup)).toBeUndefined();
  });
});

describe("the author of a draft", () => {
  const { t } = createTranslationContext("en");
  it("is the person by name, with the agent, a release push, or someone gone", () => {
    expect(draftAuthorLabel({ userId: "u", name: "Ana Writer", release: false }, t)).toBe(
      "Ana Writer"
    );
    expect(
      draftAuthorLabel({ userId: "u", name: "Ana Writer", conversationId: "c", release: false }, t)
    ).toBe("Ana Writer with the agent");
    expect(draftAuthorLabel({ release: true }, t)).toBe("a release push");
    expect(draftAuthorLabel({ userId: "u", release: false }, t)).toBe("someone no longer here");
  });
});

const refused = (status: number, code: string, reason: string) =>
  new ApiError(status, "refused", { error: { code, message: "refused", details: { reason } } });

describe("Publish and Discard", () => {
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
      answer: decideDraft({ call, done: reloaded, reread, failedMessage: "Try again." }),
      reloaded,
      reread
    };
  }

  it("reads the agent again once the decision is made", async () => {
    const run = decide(async () => done);
    await expect(run.answer).resolves.toBeUndefined();
    expect(run.reloaded).toHaveBeenCalledOnce();
  });

  it("never publishes a draft newer than the one read: it reads the draft again", async () => {
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
    expect(readDraftRefusal(refused(409, "CONFLICT", "revision_conflict"))).toBeUndefined();
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

  it("drops the answer to an earlier revision once a newer one is read", () => {
    const stale = { sent: 2, answer: { kind: "stale" as const } };
    expect(answerOfRevision(stale, 2)).toEqual({ kind: "stale" });
    expect(answerOfRevision(stale, 3)).toBeUndefined();
    const changed = { sent: 2, answer: { kind: "changed" as const } };
    expect(answerOfRevision(changed, 2)).toBeUndefined();
    expect(answerOfRevision(changed, 3)).toEqual({ kind: "changed" });
  });
});
