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

  it("offers to go on privately only after a build was refused as shared, with the last request", () => {
    const refusal = {
      type: "tool_call",
      toolCallId: "call_1",
      toolName: "platform.assets.put",
      state: "output_error",
      errorReason: "subject_conversation_shared"
    };
    const refused = { parts: [{ type: "text" }, refusal] };
    const answered = { parts: [{ type: "text" }] };
    const user = (text: string) => ({ role: "user", text, runId: undefined });
    const reply = (runId: string) => ({ role: "assistant", text: "…", runId });
    const request = "  Baue die App für Fristen.  ";

    // The run that answered the last request was refused: its request goes along, trimmed.
    expect(
      refusedRequest({
        messages: [user("Erst das."), reply("run_1"), user(request), reply("run_2")],
        activeRun: undefined,
        completedRuns: { run_1: answered, run_2: refused }
      })
    ).toBe("Baue die App für Fristen.");
    // So where a later run goes on with the same request, after one that built nothing.
    expect(
      refusedRequest({
        messages: [user(request), reply("run_1"), reply("run_2")],
        activeRun: undefined,
        completedRuns: { run_1: answered, run_2: refused }
      })
    ).toBe("Baue die App für Fristen.");
    // And while it still goes.
    expect(
      refusedRequest({
        messages: [user(request)],
        activeRun: { runId: "run_1", ...refused },
        completedRuns: {}
      })
    ).toBe("Baue die App für Fristen.");
    // Some other refusal is none of this.
    expect(
      refusedRequest({
        messages: [user(request), reply("run_1")],
        activeRun: undefined,
        completedRuns: { run_1: { parts: [{ ...refusal, errorReason: undefined }] } }
      })
    ).toBeUndefined();
  });

  it("offers nothing for a later request once an earlier build was refused", () => {
    const refused = {
      parts: [
        {
          type: "tool_call",
          toolCallId: "call_1",
          toolName: "platform.assets.put",
          state: "output_error",
          errorReason: "subject_conversation_shared"
        }
      ]
    };
    const answered = { parts: [{ type: "text" }] };
    const user = (text: string) => ({ role: "user", text, runId: undefined });
    const reply = (runId: string) => ({ role: "assistant", text: "…", runId });
    const earlier = [user("Baue die App."), reply("run_1")];

    // A later run answered: the earlier refusal is stale.
    expect(
      refusedRequest({
        messages: [...earlier, user("Wie spät ist es?"), reply("run_2")],
        activeRun: undefined,
        completedRuns: { run_1: refused, run_2: answered }
      })
    ).toBeUndefined();
    // The later request is answered right now, or not yet: never with the earlier refusal.
    expect(
      refusedRequest({
        messages: [...earlier, user("Wie spät ist es?")],
        activeRun: { runId: "run_2", ...answered },
        completedRuns: { run_1: refused }
      })
    ).toBeUndefined();
    expect(
      refusedRequest({
        messages: [...earlier, user("Wie spät ist es?")],
        activeRun: undefined,
        completedRuns: { run_1: refused }
      })
    ).toBeUndefined();
    // The refused run still shown as going answered the earlier request, not this one.
    expect(
      refusedRequest({
        messages: [...earlier, user("Wie spät ist es?")],
        activeRun: { runId: "run_1", ...refused },
        completedRuns: {}
      })
    ).toBeUndefined();
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
