import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import {
  ConnectionDraftHostProvider,
  OwnServerProposalCard,
  connectionDraftHost,
  ownServerAddedMessage,
  readConnectionProposal,
  readOwnServerProposal,
  requestOwnServerAdd,
  takeOwnServerAdd,
  useRequestedOwnServerAdd,
  type OwnServerAddRequest
} from "@work-shape/catalyst-chat-ui/build-area";
import { createTranslationContext } from "./support/chat-ui/shared";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// An agent's proposal of a person's own MCP server in a chat (PMCP-CHAT): what the card reads of
// the tool's answer and shows, where its button takes the person, and the message their tab
// sends back once the server is added. The address goes to the add screen in memory, never into
// the address bar.

const ADDRESS = "https://notes.example.com/mcp";
const answer = {
  output: { mode: "own_server", ownServer: { title: "Meine Notizen", url: ADDRESS } }
};

describe("the proposal the card reads", () => {
  it("takes the name and the address of an own-server answer, and nothing else", () => {
    expect(readOwnServerProposal(answer)).toEqual({ title: "Meine Notizen", url: ADDRESS });
    // No New connection card for it.
    expect(readConnectionProposal(answer)).toBeUndefined();
    expect(
      readOwnServerProposal({
        output: {
          connection: { connectorType: "mcp", name: "notes", title: "Notes", url: ADDRESS }
        }
      })
    ).toBeUndefined();
    expect(
      readOwnServerProposal({ status: "failed", error: { code: "not_allowed", message: "x" } })
    ).toBeUndefined();
    expect(readOwnServerProposal(undefined)).toBeUndefined();
  });
});

describe("the card", () => {
  const host = (owns: boolean, shown: unknown[] = []) => {
    const made = connectionDraftHost({
      // The card reads nothing: any call would fail the test.
      client: createApiClient({
        baseUrl: "http://api.test",
        fetchImpl: () => Promise.reject(new Error("The card calls no API"))
      }),
      apiBaseUrl: "http://api.test",
      authScope: "workspace",
      mayWriteConnections: false,
      showRoute: (route) => shown.push(route),
      ownsConversation: owns,
      from: { conversationId: "conv_1", agentName: "helper" }
    });
    return made;
  };
  const render = (locale: "en" | "de", owns: boolean) =>
    renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(
          ConnectionDraftHostProvider,
          { value: host(owns), children: null },
          createElement(OwnServerProposalCard, {
            proposal: { title: "Meine Notizen", url: ADDRESS }
          })
        )
      )
    );

  it("says Add MCP server with the name and the host, and opens the add screen for the chat's person", () => {
    const de = render("de", true);
    expect(de).toContain("data-own-server-proposal");
    expect(de).toContain("MCP-Server hinzufügen");
    expect(de).toContain("Meine Notizen");
    expect(de).toContain("notes.example.com");
    expect(de).toContain("data-own-server-proposal-open");
    expect(de).toContain("Öffnen");
    const en = render("en", true);
    expect(en).toContain("Add MCP server");
    expect(en).toContain("Nothing is saved before.");
  });

  it("has no button for someone else reading the chat", () => {
    const en = render("en", false);
    expect(en).not.toContain("data-own-server-proposal-open");
    expect(en).toContain("Only the person whose chat this is adds their own MCP server.");
  });

  it("goes to Settings > You > Connections with the proposal kept in memory, taken once", () => {
    const shown: unknown[] = [];
    host(true, shown).openOwnServer?.({ title: "Meine Notizen", url: ADDRESS });
    expect(shown).toEqual([{ kind: "settings", group: "you", page: "connections" }]);
    expect(JSON.stringify(shown)).not.toContain("notes.example.com");
    const seen: (OwnServerAddRequest | undefined)[] = [];
    const Reader = () => {
      seen.push(useRequestedOwnServerAdd());
      return null;
    };
    renderToStaticMarkup(createElement(Reader));
    const requested = seen.at(-1);
    expect(requested).toEqual({
      title: "Meine Notizen",
      url: ADDRESS,
      from: { conversationId: "conv_1", agentName: "helper" }
    });
    if (requested) takeOwnServerAdd(requested);
    renderToStaticMarkup(createElement(Reader));
    expect(seen.at(-1)).toBeUndefined();
    // A newer proposal replaces one not yet shown.
    requestOwnServerAdd({ title: "A", url: ADDRESS });
    requestOwnServerAdd({ title: "B", url: ADDRESS });
    renderToStaticMarkup(createElement(Reader));
    expect(seen.at(-1)?.title).toBe("B");
    takeOwnServerAdd(seen.at(-1) ?? { title: "", url: "" });
  });
});

describe("the message the person's tab sends once the server is added", () => {
  it("names the server and the tools accepted, or that none were, in the person's language", () => {
    const { t } = createTranslationContext("en");
    expect(ownServerAddedMessage({ title: "Notes", tools: ["Search", "Save page"] }, t)).toBe(
      "I added my MCP server Notes. 2 tools accepted: Search, Save page."
    );
    expect(ownServerAddedMessage({ title: "Notes", tools: ["Search"] }, t)).toBe(
      "I added my MCP server Notes. 1 tool accepted: Search."
    );
    expect(ownServerAddedMessage({ title: "Notes", tools: [] }, t)).toBe(
      "I added my MCP server Notes, with no tools accepted yet."
    );
    const de = createTranslationContext("de").t;
    expect(ownServerAddedMessage({ title: "Notizen", tools: [] }, de)).toBe(
      "Ich habe meinen MCP-Server Notizen hinzugefügt, noch ohne akzeptierte Tools."
    );
    const many = Array.from({ length: 12 }, (_, index) => `Tool ${index + 1}`);
    expect(ownServerAddedMessage({ title: "Notes", tools: many }, t)).toContain("Tool 10, …");
  });
});
