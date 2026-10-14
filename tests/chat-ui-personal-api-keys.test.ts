import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { PersonalApiKey, PlatformContext } from "@vivd-catalyst/api-client";
import { administration } from "@vivd-catalyst/chat-ui/admin";
import { PersonalApiKeysTable } from "../packages/chat-ui/src/control-plane/personal-api-keys-list";
import {
  buildPersonalKeyScopes,
  connectCodeOfSearch,
  formatConnectCode,
  heldKeyActions,
  initialPersonalKeyDraft,
  instanceUrl,
  isCompleteConnectCode,
  personalKeyActionOffer,
  personalKeyDraftProblem,
  personalKeyExpiryOf,
  personalKeyRequest,
  personalKeyState
} from "../packages/chat-ui/src/control-plane/personal-api-keys-model";
import { settingsCatalog, visibleSettingsPages } from "../packages/chat-ui/src/settings/catalog";
import { ConnectCodeConfirm } from "../packages/chat-ui/src/settings/pages/api-keys";
import { platformContext, taxNamespace } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { personalWorkspace, settingsUser } from "./chat-ui-settings-fixtures";

const now = new Date("2026-10-13T12:00:00.000Z");

function key(overrides: Partial<PersonalApiKey> = {}): PersonalApiKey {
  return {
    id: "cred_1",
    ownerUserId: "user_1",
    ownerDisplayLabel: "Fabian Kai",
    name: "fabian-mbp",
    keyPrefix: "cat_live_ab12",
    scopes: ["agent.write:kai-", "skill.read"],
    createdAt: "2026-10-01T10:00:00.000Z",
    expiresAt: "2027-01-01T10:00:00.000Z",
    ...overrides
  };
}

function withPublishingKind(context: PlatformContext): PlatformContext {
  return {
    ...context,
    kinds: [
      ...context.kinds,
      {
        kind: "app",
        plural: "apps",
        lifecycle: "draft_published",
        representation: "files",
        actions: {
          read: "app.read",
          write: "app.write",
          delete: "app.delete",
          publish: "app.publish",
          use: "app.use"
        }
      }
    ]
  };
}

describe("personal API key model", () => {
  it("offers the authoring actions of agents, skills and every listed kind, never use", () => {
    expect(personalKeyActionOffer(undefined)).toEqual([
      "agent.read",
      "agent.write",
      "agent.delete",
      "skill.read",
      "skill.write",
      "skill.delete"
    ]);
    const offer = personalKeyActionOffer(withPublishingKind(platformContext()));
    expect(offer).toContain("app.publish");
    expect(offer).not.toContain("app.use");
    expect(new Set(offer).size).toBe(offer.length);
  });

  it("checks at first the actions the person holds on the instance or in a Namespace", () => {
    const context = platformContext([taxNamespace], ["skill.write"]);
    expect(heldKeyActions(personalKeyActionOffer(context), context)).toEqual([
      "agent.read",
      "agent.write",
      "agent.delete",
      "skill.read",
      "skill.write"
    ]);
  });

  it("limits every chosen action to the Namespace where one is given", () => {
    expect(buildPersonalKeyScopes(["agent.write", "skill.read"], "")).toEqual([
      "agent.write",
      "skill.read"
    ]);
    expect(buildPersonalKeyScopes(["agent.write"], " kai- ")).toEqual(["agent.write:kai-"]);
  });

  it("sends a draft once it has a name, a scope and a well-formed Namespace", () => {
    const draft = initialPersonalKeyDraft(["agent.write"], "laptop");
    expect(draft.expiryDays).toBe(90);
    expect(personalKeyDraftProblem({ ...draft, name: " " })).toBe("name");
    expect(personalKeyDraftProblem({ ...draft, actions: [] })).toBe("scopes");
    expect(personalKeyDraftProblem({ ...draft, namespace: "Kai" })).toBe("namespace");
    expect(personalKeyRequest({ ...draft, namespace: "Kai" }, now)).toBeUndefined();
    expect(personalKeyRequest({ ...draft, namespace: "kai-", expiryDays: 30 }, now)).toEqual({
      name: "laptop",
      scopes: ["agent.write:kai-"],
      expiresAt: "2026-11-12T12:00:00.000Z"
    });
  });

  it("offers 30, 90 and 365 days and nothing else", () => {
    expect(personalKeyExpiryOf("365")).toBe(365);
    expect(personalKeyExpiryOf("400")).toBeUndefined();
    const longest = personalKeyRequest(
      { ...initialPersonalKeyDraft(["agent.read"], "x"), expiryDays: 365 },
      now
    );
    expect(longest?.expiresAt).toBe("2027-10-13T12:00:00.000Z");
  });

  it("writes a typed or linked connect code as the CLI shows it", () => {
    expect(formatConnectCode("bcdf ghjk")).toBe("BCDF-GHJK");
    expect(formatConnectCode("bcd")).toBe("BCD");
    expect(formatConnectCode("BCDFG")).toBe("BCDF-G");
    expect(formatConnectCode("bcdf-ghjk-lmnp")).toBe("BCDF-GHJK");
    expect(isCompleteConnectCode("BCDF-GHJ")).toBe(false);
    expect(isCompleteConnectCode("bcdfghjk")).toBe(true);
    expect(connectCodeOfSearch("?code=bcdf-ghjk")).toBe("BCDF-GHJK");
    expect(connectCodeOfSearch("")).toBe("");
  });

  it("tells active, revoked and expired keys apart", () => {
    expect(personalKeyState(key(), now)).toBe("active");
    expect(personalKeyState(key({ revokedAt: "2026-10-02T10:00:00.000Z" }), now)).toBe("revoked");
    expect(personalKeyState(key({ expiresAt: "2026-10-02T10:00:00.000Z" }), now)).toBe("expired");
  });

  it("names the instance's address for a relative or absolute API base", () => {
    expect(instanceUrl("", "https://kai.example.com")).toBe("https://kai.example.com");
    expect(instanceUrl("https://api.example.com/", "https://kai.example.com")).toBe(
      "https://api.example.com"
    );
  });
});

describe("You > API keys", () => {
  const catalog = settingsCatalog(administration);
  const ids = (modules?: Record<string, { enabled: boolean }>) =>
    visibleSettingsPages(catalog, {
      user: settingsUser(),
      workspaces: [personalWorkspace()],
      modules
    }).map((page) => `${page.group}/${page.id}`);

  it("is shown to every user while the module is on", () => {
    expect(ids()).not.toContain("you/api-keys");
    expect(ids({ personalApiKeys: { enabled: false } })).not.toContain("you/api-keys");
    expect(ids({ personalApiKeys: { enabled: true } })).toContain("you/api-keys");
  });

  it("shows what a connect code asks for with the warning, in English and German", () => {
    const render = (locale: "en" | "de") =>
      renderToStaticMarkup(
        createElement(
          TranslationProvider,
          { children: null, locale },
          createElement(ConnectCodeConfirm, {
            code: "BCDF-GHJK",
            request: {
              clientLabel: "catalyst CLI on fabian-mbp",
              createdAt: "2026-10-13T11:58:00.000Z",
              expiresAt: "2026-10-13T12:13:00.000Z"
            },
            offer: { actions: ["agent.read", "agent.write"], held: ["agent.read"], namespaces: [] },
            pending: false,
            onConfirm: async () => undefined
          })
        )
      );
    const english = render("en");
    expect(english).toContain("catalyst CLI on fabian-mbp");
    expect(english).toContain("Only confirm a code your own terminal shows you");
    expect(english).toContain("BCDF-GHJK");
    expect(english).toContain("agent.write");
    expect(english).toContain("90 days");
    expect(render("de")).toContain("Bestätige nur einen Code, den dir dein eigenes Terminal zeigt");
  });

  it("lists every person's keys with their owner and no secret", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(PersonalApiKeysTable, {
          keys: [key(), key({ id: "cred_2", name: "old", revokedAt: "2026-10-02T10:00:00.000Z" })],
          loading: false,
          showOwner: true,
          revoking: false,
          onRevoke: async () => undefined
        })
      )
    );
    expect(markup).toContain("Owner");
    expect(markup).toContain("Fabian Kai");
    expect(markup).toContain("cat_live_ab12");
    expect(markup).toContain("agent.write:kai-");
    expect(markup).toContain("Revoked");
    // Only the active key offers Revoke.
    expect(markup.match(/>Revoke</gu)?.length).toBe(1);
  });
});
