import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { buildingAgentNameFor } from "@work-shape/catalyst-chat-ui/agents";
import { refusedRequest } from "@work-shape/catalyst-chat-ui/subject-run";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { createPrivateConversationWith, PrivateBuildOffer } from "./support/chat-ui";

// The New buttons of NAV-2: where an agent here holds the platform's asset tools, "New" opens
// the dock with a conversation with it, and its first save creates the asset.

describe("the agent of a New button", () => {
  it("starts a New button's conversation with an agent that builds assets, the chosen one first", () => {
    const agents = [
      { name: "general" },
      { name: "builder", buildsAssets: true },
      { name: "studio", buildsAssets: true }
    ];

    expect(buildingAgentNameFor(agents, "studio")).toBe("studio");
    expect(buildingAgentNameFor(agents, "general")).toBe("builder");
    expect(buildingAgentNameFor(agents, undefined)).toBe("builder");
    // No agent here builds: the New buttons keep their forms.
    expect(buildingAgentNameFor([{ name: "general" }], "general")).toBeUndefined();
  });
});

// ACCEPT-FIX-11 E3: a workspace whose members read its conversations builds nothing in them.
// "New" there, and the refusal's one press, start a private conversation of the SAME workspace,
// whatever the workspace starts conversations as, with the person's request in its composer.
describe("building from a workspace whose conversations are shared", () => {
  function fakeCreate() {
    const bodies: unknown[] = [];
    const drafts: { target: { conversationId: string | undefined }; text: string }[] = [];
    return {
      bodies,
      drafts,
      client: {
        conversations: {
          create: async (input: { body: unknown }) => {
            bodies.push(input.body);
            return { id: "conv_private", collaborationWorkspaceId: "cw_kanzlei" };
          }
        }
      },
      draftController: {
        setDraft: (target: { conversationId: string | undefined }, text: string) => {
          drafts.push({ target, text });
        }
      }
    };
  }

  it("makes a private conversation in the same workspace and carries the request over", async () => {
    const fake = fakeCreate();
    const request = "Baue einen Workflow, der jeden Montag die Fristen der Mandanten prüft.";
    const made = await createPrivateConversationWith({
      // The workspace starts conversations its members read; this one is private all the same.
      client: fake.client,
      locale: "de",
      collaborationWorkspaceId: "cw_kanzlei",
      prompt: request,
      draftController: fake.draftController
    });
    expect(fake.bodies).toEqual([
      { locale: "de", collaborationWorkspaceId: "cw_kanzlei", visibility: "private" }
    ]);
    expect(made).toEqual({ id: "conv_private", collaborationWorkspaceId: "cw_kanzlei" });
    expect(fake.drafts).toEqual([
      { target: { authScope: "standalone", conversationId: "conv_private" }, text: request }
    ]);
  });

  // A message names no author: the run that answers it does, by its owner and its input.
  const refusal = {
    type: "tool_call",
    toolCallId: "call_1",
    toolName: "platform.assets.put",
    state: "output_error",
    errorReason: "subject_conversation_shared"
  };
  const user = (id: string, text: string) => ({ id, role: "user", text, runId: undefined });
  const reply = (runId: string) => ({ id: `msg_${runId}`, role: "assistant", text: "…", runId });
  const run = (ownerUserId: string | undefined, inputMessageId: string, refused: boolean) => ({
    ownerUserId,
    inputMessageId,
    parts: refused ? [{ type: "text" }, refusal] : [{ type: "text" }]
  });

  it("offers to go on privately only after a build was refused as shared, with the last request", () => {
    const request = "  Baue die App für Fristen.  ";

    // The run that answered the last request was refused: its request goes along, trimmed.
    expect(
      refusedRequest({
        currentUserId: "user_anna",
        messages: [user("m1", "Erst das."), reply("run_1"), user("m2", request), reply("run_2")],
        activeRun: undefined,
        completedRuns: {
          run_1: run("user_anna", "m1", false),
          run_2: run("user_anna", "m2", true)
        }
      })
    ).toBe("Baue die App für Fristen.");
    // So where a later run goes on with the same request, after one that built nothing.
    expect(
      refusedRequest({
        currentUserId: "user_anna",
        messages: [user("m1", request), reply("run_1"), reply("run_2")],
        activeRun: undefined,
        completedRuns: {
          run_1: run("user_anna", "m1", false),
          run_2: run("user_anna", "m1", true)
        }
      })
    ).toBe("Baue die App für Fristen.");
    // And while it still goes.
    expect(
      refusedRequest({
        currentUserId: "user_anna",
        messages: [user("m1", request)],
        activeRun: { runId: "run_1", ...run("user_anna", "m1", true) },
        completedRuns: {}
      })
    ).toBe("Baue die App für Fristen.");
    // Some other refusal is none of this.
    expect(
      refusedRequest({
        currentUserId: "user_anna",
        messages: [user("m1", request), reply("run_1")],
        activeRun: undefined,
        completedRuns: {
          run_1: {
            ...run("user_anna", "m1", false),
            parts: [{ ...refusal, errorReason: undefined }]
          }
        }
      })
    ).toBeUndefined();
  });

  it("offers nothing for a later request once an earlier build was refused", () => {
    const earlier = [user("m1", "Baue die App."), reply("run_1")];
    const refused = run("user_anna", "m1", true);
    const later = user("m2", "Wie spät ist es?");

    // A later run answered: the earlier refusal is stale.
    expect(
      refusedRequest({
        currentUserId: "user_anna",
        messages: [...earlier, later, reply("run_2")],
        activeRun: undefined,
        completedRuns: { run_1: refused, run_2: run("user_anna", "m2", false) }
      })
    ).toBeUndefined();
    // The later request is answered right now, or not yet: never with the earlier refusal.
    expect(
      refusedRequest({
        currentUserId: "user_anna",
        messages: [...earlier, later],
        activeRun: { runId: "run_2", ...run("user_anna", "m2", false) },
        completedRuns: { run_1: refused }
      })
    ).toBeUndefined();
    expect(
      refusedRequest({
        currentUserId: "user_anna",
        messages: [...earlier, later],
        activeRun: undefined,
        completedRuns: { run_1: refused }
      })
    ).toBeUndefined();
    // The refused run still shown as going answered the earlier request, not this one.
    expect(
      refusedRequest({
        currentUserId: "user_anna",
        messages: [...earlier, later],
        activeRun: { runId: "run_1", ...refused },
        completedRuns: {}
      })
    ).toBeUndefined();
  });

  // Members read a shared conversation together. The refusal of Anna's build is Anna's: Ben,
  // who reads along, is offered nothing, and nobody takes along words someone else wrote.
  it("offers going on privately only to the person whose own request was refused", () => {
    const request = "Baue die App für Fristen.";
    const thread = (
      currentUserId: string | undefined,
      refusedRun = run("user_anna", "m1", true)
    ) => ({
      completed: refusedRequest({
        currentUserId,
        messages: [user("m1", request), reply("run_1")],
        activeRun: undefined,
        completedRuns: { run_1: refusedRun }
      }),
      active: refusedRequest({
        currentUserId,
        messages: [user("m1", request)],
        activeRun: { runId: "run_1", ...refusedRun },
        completedRuns: {}
      })
    });

    // Anna, who started the refused run, is offered her request, while it goes and after.
    expect(thread("user_anna")).toEqual({ completed: request, active: request });
    // Ben reads the same thread and is offered nothing.
    expect(thread("user_ben")).toEqual({ completed: undefined, active: undefined });
    // Who reads is not known yet: nothing, even though the run names its owner.
    expect(thread(undefined)).toEqual({ completed: undefined, active: undefined });
    // The run names no owner: nobody's request is anybody's own, not even an unknown reader's.
    expect(thread("user_anna", run(undefined, "m1", true))).toEqual({
      completed: undefined,
      active: undefined
    });
    expect(thread(undefined, run(undefined, "m1", true))).toEqual({
      completed: undefined,
      active: undefined
    });
  });

  it("never carries a later message of another member as the person's own request", () => {
    // Anna's build was refused, then Ben wrote in the same conversation.
    const messages = [
      user("m1", "Baue die App für Fristen."),
      reply("run_1"),
      user("m2", "Und dasselbe für die Kanzlei Süd.")
    ];
    const annasRefusal = run("user_anna", "m1", true);
    // Anna's refused run is still shown as going: it answered her request, not Ben's message.
    expect(
      refusedRequest({
        currentUserId: "user_anna",
        messages,
        activeRun: { runId: "run_1", ...annasRefusal },
        completedRuns: {}
      })
    ).toBeUndefined();
    // A run of Anna's that the snapshot ties to the last message, but whose input is another
    // message, does not vouch for it: what Ben wrote stays his.
    expect(
      refusedRequest({
        currentUserId: "user_anna",
        messages: [...messages, reply("run_2")],
        activeRun: undefined,
        completedRuns: { run_1: annasRefusal, run_2: run("user_anna", "m1", true) }
      })
    ).toBeUndefined();
    // Ben's own run on his message was refused: Ben is offered his words, Anna nothing.
    const bensRefusal = { run_1: annasRefusal, run_2: run("user_ben", "m2", true) };
    for (const [currentUserId, offered] of [
      ["user_ben", "Und dasselbe für die Kanzlei Süd."],
      ["user_anna", undefined]
    ] as const) {
      expect(
        refusedRequest({
          currentUserId,
          messages: [...messages, reply("run_2")],
          activeRun: undefined,
          completedRuns: bensRefusal
        })
      ).toBe(offered);
      expect(
        refusedRequest({
          currentUserId,
          messages,
          activeRun: { runId: "run_2", ...bensRefusal.run_2 },
          completedRuns: { run_1: annasRefusal }
        })
      ).toBe(offered);
    }
  });

  it("names the offer in each language", () => {
    for (const [locale, words] of [
      ["en", "Continue privately"],
      ["de", "Privat weitermachen"]
    ] as const) {
      const markup = renderToStaticMarkup(
        createElement(TranslationProvider, {
          locale,
          children: createElement(PrivateBuildOffer, {
            pending: false,
            onContinue: () => undefined
          })
        })
      );
      expect(markup).toContain(words);
      expect(markup).toContain('data-testid="private-build-offer"');
    }
  });
});
