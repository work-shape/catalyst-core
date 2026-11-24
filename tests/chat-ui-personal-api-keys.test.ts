// @vitest-environment happy-dom

import { act, createElement } from "react";
import { ApiError, createApiClient } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { required } from "./support/assertions";
import { describe, expect, it, vi } from "vitest";
import type {
  ConfirmConnectCodeRequest,
  PersonalApiKey,
  PlatformContext
} from "@work-shape/catalyst-api-client";
import { administration } from "@work-shape/catalyst-chat-ui/admin";
import {
  PersonalApiKeysTable,
  buildPersonalKeyScopes,
  connectCodeOfSearch,
  connectKeyActions,
  formatConnectCode,
  initialPersonalKeyDraft,
  instanceUrl,
  isCompleteConnectCode,
  keysSharingAName,
  personalKeyAccountOffer,
  personalKeyActionOffer,
  personalKeyActionsKeptIn,
  personalKeyDraftProblem,
  personalKeyExpiryOf,
  personalKeyHeldActionOffer,
  personalKeyInstanceOffer,
  personalKeyOfferIn,
  personalKeyRequest,
  personalKeyUseOffer,
  personalKeyScopeParts,
  personalKeyState,
  personalKeyWorkspaceOffer,
  settingsCatalog,
  visibleSettingsPages,
  ApiKeysPage,
  ConnectCodeConfirm,
  ConnectLocalAgentPage,
  LOCAL_AGENT_TOOLS,
  localAgentCommand
} from "./support/chat-ui";
import { platformContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import {
  mountPage,
  personalWorkspace,
  SETTINGS_INSTANCE_URL,
  settingsPageContext,
  settingsUser,
  waitForText
} from "./chat-ui-settings-fixtures";

const now = new Date("2026-10-13T12:00:00.000Z");
/** What the key fields of a connect code offer in these tests. */
const cliOffer = {
  everywhere: { actions: ["agent.read", "agent.write"], useActions: [] as string[] },
  instanceActions: [] as string[],
  accountActions: [] as string[],
  workspaces: [] as {
    id: string;
    name?: string;
    actions: string[];
    useActions: string[];
  }[],
  settled: true
};

/** What the instance answers a person who reads and edits agents and skills somewhere. */
function editorContext(): PlatformContext {
  return {
    ...platformContext(),
    authoringActions: ["agent.read", "agent.write", "skill.read", "skill.write"]
  };
}

/** A held right of a Shared Workspace, as the key offer lists it. */
function sharedWorkspace(id: string, name: string, actions: string[], useActions: string[] = []) {
  return { id, name, actions, useActions };
}

function key(overrides: Partial<PersonalApiKey> = {}): PersonalApiKey {
  return {
    id: "cred_1",
    ownerUserId: "user_1",
    ownerDisplayLabel: "Fabian Kai",
    name: "fabian-mbp",
    keyPrefix: "cat.apic_1f0c2a9e-7b6d-4c3a-9e8f-0a1b2c3d4e5f.",
    scopes: ["agent.write:ws-tax", "skill.read"],
    createdAt: "2026-10-01T10:00:00.000Z",
    expiresAt: "2027-01-01T10:00:00.000Z",
    ...overrides
  };
}

/** A key issued without an expiry: it acts until it is revoked. */
function lastingKey(overrides: Partial<PersonalApiKey> = {}): PersonalApiKey {
  const lasting = key(overrides);
  delete lasting.expiresAt;
  return lasting;
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
        owners: ["workspace"],
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

  it("offers as the use level the use rights the instance says the person holds", () => {
    expect(personalKeyUseOffer(undefined)).toEqual([]);
    expect(
      personalKeyUseOffer({ ...platformContext(), useActions: ["connection.use", "workflow.use"] })
    ).toEqual(["connection.use", "workflow.use"]);
  });

  it("offers only the authoring rights the person holds, everywhere and in each workspace", () => {
    expect(personalKeyHeldActionOffer(undefined)).toEqual([]);
    expect(personalKeyHeldActionOffer(platformContext())).toEqual([]);
    // A Builder and Publisher of one Shared Workspace holds no delete, so none is offered.
    const builder: PlatformContext = {
      ...platformContext(),
      authoringActions: ["agent.read", "agent.write", "agent.publish", "skill.read", "skill.write"],
      useActions: ["connection.use", "workflow.use"],
      workspaces: [
        {
          id: "ws-tax",
          name: "Tax",
          kind: "shared",
          member: true,
          actions: ["agent.read", "agent.write", "agent.publish", "skill.read", "skill.write"],
          useActions: ["workflow.use"]
        },
        {
          id: "ws-own",
          name: "Personal",
          kind: "personal",
          member: true,
          actions: ["skill.read", "skill.delete"]
        }
      ]
    };
    const everywhere = {
      actions: personalKeyHeldActionOffer(builder),
      useActions: personalKeyUseOffer(builder)
    };
    expect(everywhere.actions).toEqual([
      "agent.read",
      "agent.write",
      "skill.read",
      "skill.write",
      "agent.publish"
    ]);
    const workspaces = personalKeyWorkspaceOffer(builder);
    expect(workspaces).toEqual([
      sharedWorkspace(
        "ws-tax",
        "Tax",
        ["agent.read", "agent.write", "skill.read", "skill.write", "agent.publish"],
        ["workflow.use"]
      ),
      // An instance before the workspace's use level offers none there.
      { id: "ws-own", actions: ["skill.read", "skill.delete"], useActions: [] }
    ]);
    expect(personalKeyOfferIn(everywhere, workspaces, "")).toBe(everywhere);
    expect(personalKeyOfferIn(everywhere, workspaces, "ws-own")).toEqual({
      actions: ["skill.read", "skill.delete"],
      useActions: []
    });
    expect(personalKeyOfferIn(everywhere, workspaces, "ws-gone")).toEqual({
      actions: [],
      useActions: []
    });
  });

  it("starts a connect code's key with every right offered but deleting and connection.use", () => {
    expect(connectKeyActions({ actions: [], useActions: [] })).toEqual([]);
    expect(
      connectKeyActions({
        actions: ["agent.read", "agent.write", "agent.delete", "workflow.publish"],
        useActions: ["connection.use", "workflow.use"]
      })
    ).toEqual(["agent.read", "agent.write", "workflow.publish", "workflow.use"]);
  });

  it("keeps ticked only what the person holds where the key is limited", () => {
    const offer = {
      everywhere: {
        actions: ["agent.read", "agent.write", "agent.delete"],
        useActions: ["connection.use", "workflow.use"]
      },
      workspaces: [sharedWorkspace("ws-tax", "Tax", ["agent.read", "agent.write"])],
      instanceActions: ["system.view"],
      accountActions: ["account.manage", "collaboration_workspace.manage"]
    };
    const ticked = [
      "agent.read",
      "agent.delete",
      "workflow.use",
      "system.view",
      "account.manage",
      "collaboration_workspace.manage"
    ];
    expect(personalKeyActionsKeptIn(ticked, offer, "")).toEqual(ticked);
    expect(personalKeyActionsKeptIn(ticked, offer, "ws-tax")).toEqual([
      "agent.read",
      "collaboration_workspace.manage"
    ]);
  });

  it("offers system.view as the instance level only to a person who holds it, and never ticks it for `catalyst setup`", () => {
    expect(personalKeyInstanceOffer(undefined)).toEqual([]);
    expect(personalKeyInstanceOffer(platformContext())).toEqual([]);
    const holder: PlatformContext = {
      ...platformContext(),
      instanceActions: ["agent.read", "system.view"],
      authoringActions: ["agent.read", "system.view"]
    };
    expect(personalKeyInstanceOffer(holder)).toEqual(["system.view"]);
    // It is a level of its own, not an authoring action.
    expect(personalKeyActionOffer(holder)).not.toContain("system.view");
    expect(personalKeyHeldActionOffer(holder)).toEqual(["agent.read"]);
  });

  it("offers usage.view, audit.view and system.view as the instance level, each only to a person who holds it, and never in the key `catalyst setup` asks for", () => {
    const all: PlatformContext = {
      ...platformContext(),
      instanceActions: ["service_principals.manage", "usage.view", "audit.view", "system.view"],
      authoringActions: ["agent.read", "agent.write"],
      useActions: ["workflow.use"]
    };
    // Never the administration rights beside them.
    expect(personalKeyInstanceOffer(all)).toEqual(["usage.view", "audit.view", "system.view"]);
    expect(
      personalKeyInstanceOffer({ ...all, instanceActions: ["audit.view", "jobs.retry"] })
    ).toEqual(["audit.view"]);
    expect(personalKeyInstanceOffer({ ...all, instanceActions: ["usage.view_users"] })).toEqual([]);
    for (const action of ["usage.view", "audit.view", "system.view"]) {
      // An instance right is no scope of a key limited to a workspace.
      expect(buildPersonalKeyScopes([action], { workspaceId: "ws-tax", assetName: "" })).toEqual(
        []
      );
    }
  });

  it("sends system.view only on a key over the whole instance, never narrowed to a workspace or asset", () => {
    const everywhere = { workspaceId: "", assetName: "" };
    expect(buildPersonalKeyScopes(["agent.read", "system.view"], everywhere)).toEqual([
      "agent.read",
      "system.view"
    ]);
    expect(
      buildPersonalKeyScopes(["agent.read", "system.view"], {
        ...everywhere,
        workspaceId: "ws-tax"
      })
    ).toEqual(["agent.read:ws-tax"]);
    expect(
      buildPersonalKeyScopes(["system.view"], { workspaceId: "ws-tax", assetName: "vat-helper" })
    ).toEqual([]);
    const draft = { ...initialPersonalKeyDraft("laptop"), actions: ["system.view"] };
    expect(personalKeyRequest(draft, now)?.scopes).toEqual(["system.view"]);
    // Narrowed, a key of system.view alone has no scope left to send.
    expect(personalKeyDraftProblem({ ...draft, workspaceId: "ws-tax" })).toBe("scopes");
    expect(personalKeyRequest({ ...draft, workspaceId: "ws-tax" }, now)).toBeUndefined();
  });

  it("offers the account and workspaces level to every person, and never in the key `catalyst setup` asks for", () => {
    expect(personalKeyAccountOffer(undefined)).toEqual([]);
    const context: PlatformContext = {
      ...platformContext(),
      authoringActions: ["agent.read"],
      useActions: ["workflow.use"]
    };
    expect(personalKeyAccountOffer(context)).toEqual([
      "account.manage",
      "collaboration_workspace.manage"
    ]);
    expect(personalKeyActionOffer(context)).not.toContain("account.manage");
  });

  it("sends account.manage only over the whole account and collaboration_workspace.manage at most narrowed to a workspace", () => {
    const actions = ["agent.read", "account.manage", "collaboration_workspace.manage"];
    expect(buildPersonalKeyScopes(actions, { workspaceId: "", assetName: "" })).toEqual(actions);
    expect(buildPersonalKeyScopes(actions, { workspaceId: "ws-tax", assetName: "" })).toEqual([
      "agent.read:ws-tax",
      "collaboration_workspace.manage:ws-tax"
    ]);
    expect(
      buildPersonalKeyScopes(actions, { workspaceId: "ws-tax", assetName: "vat-helper" })
    ).toEqual(["agent.read:ws-tax/vat-helper"]);
    const draft = { ...initialPersonalKeyDraft("laptop"), actions: ["account.manage"] };
    expect(personalKeyRequest(draft, now)?.scopes).toEqual(["account.manage"]);
    // Narrowed, a key of account.manage alone has no scope left to send.
    expect(personalKeyRequest({ ...draft, workspaceId: "ws-tax" }, now)).toBeUndefined();
  });

  it("starts a new key with no scope ticked, so it gets only what the person ticks", () => {
    expect(initialPersonalKeyDraft().actions).toEqual([]);
    expect(initialPersonalKeyDraft("catalyst CLI")).toMatchObject({
      name: "catalyst CLI",
      actions: []
    });
    // Nothing is sent until a scope is ticked.
    expect(personalKeyDraftProblem(initialPersonalKeyDraft("laptop"))).toBe("scopes");
  });

  it("limits every chosen action to the workspace, and to one asset in it, where one is chosen", () => {
    const everywhere = { workspaceId: "", assetName: "" };
    expect(buildPersonalKeyScopes(["agent.write", "skill.read"], everywhere)).toEqual([
      "agent.write",
      "skill.read"
    ]);
    expect(
      buildPersonalKeyScopes(["agent.write"], { ...everywhere, workspaceId: "ws-tax" })
    ).toEqual(["agent.write:ws-tax"]);
    expect(
      buildPersonalKeyScopes(["agent.write", "skill.read"], {
        workspaceId: "ws-tax",
        assetName: " vat-helper "
      })
    ).toEqual(["agent.write:ws-tax/vat-helper", "skill.read:ws-tax/vat-helper"]);
    // An asset is one of a workspace: without a workspace its id limits nothing.
    expect(
      buildPersonalKeyScopes(["agent.write"], { ...everywhere, assetName: "vat-helper" })
    ).toEqual(["agent.write"]);
  });

  it("sends a draft once it has a name, a scope and a well-formed asset id", () => {
    const draft = { ...initialPersonalKeyDraft("laptop"), actions: ["agent.write"] };
    expect(draft).toMatchObject({ expiry: 90, workspaceId: "", assetName: "" });
    expect(personalKeyDraftProblem({ ...draft, name: " " })).toBe("name");
    expect(personalKeyDraftProblem({ ...draft, actions: [] })).toBe("scopes");
    const spaced = { ...draft, workspaceId: "ws-tax", assetName: "vat helper" };
    expect(personalKeyDraftProblem(spaced)).toBe("assetName");
    expect(personalKeyRequest(spaced, now)).toBeUndefined();
    expect(personalKeyRequest({ ...draft, workspaceId: "ws-tax", expiry: 30 }, now)).toEqual({
      name: "laptop",
      scopes: ["agent.write:ws-tax"],
      expiresAt: "2026-11-12T12:00:00.000Z"
    });
  });

  it("offers 30, 90 and 365 days and never, and nothing else", () => {
    expect(personalKeyExpiryOf("365")).toBe(365);
    expect(personalKeyExpiryOf("never")).toBe("never");
    expect(personalKeyExpiryOf("400")).toBeUndefined();
    const longest = personalKeyRequest(
      { ...initialPersonalKeyDraft("x"), actions: ["agent.read"], expiry: 365 },
      now
    );
    expect(longest?.expiresAt).toBe("2027-10-13T12:00:00.000Z");
    // A key that never expires is asked for with no expiry at all.
    const lasting = personalKeyRequest(
      { ...initialPersonalKeyDraft("x"), actions: ["agent.read"], expiry: "never" },
      now
    );
    expect(lasting?.expiresAt).toBeNull();
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

  it("reads a scope back as its action and the workspace and asset it is limited to", () => {
    expect(personalKeyScopeParts("agent.write:ws-tax")).toEqual({
      action: "agent.write",
      workspaceId: "ws-tax"
    });
    expect(personalKeyScopeParts("agent.write:ws-tax/vat-helper")).toEqual({
      action: "agent.write",
      workspaceId: "ws-tax",
      assetName: "vat-helper"
    });
    expect(personalKeyScopeParts("skill.read")).toEqual({ action: "skill.read" });
  });

  it("tells a key by how it starts only where its owner holds another of the same name", () => {
    const keys = [
      key({ id: "laptop", name: "Laptop" }),
      key({ id: "laptop-again", name: " laptop " }),
      key({ id: "script", name: "script" }),
      key({ id: "other-owner", name: "script", ownerUserId: "user_2" })
    ];
    expect([...keysSharingAName(keys)].sort()).toEqual(["laptop", "laptop-again"]);
  });

  it("tells active, revoked and expired keys apart", () => {
    expect(personalKeyState(key(), now)).toBe("active");
    expect(personalKeyState(key({ revokedAt: "2026-10-02T10:00:00.000Z" }), now)).toBe("revoked");
    expect(personalKeyState(key({ expiresAt: "2026-10-02T10:00:00.000Z" }), now)).toBe("expired");
    expect(personalKeyState(lastingKey(), now)).toBe("active");
    expect(personalKeyState(lastingKey({ revokedAt: "2026-10-02T10:00:00.000Z" }), now)).toBe(
      "revoked"
    );
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

  it("shows API keys and Connect a local agent to every user while the module is on", () => {
    expect(ids()).not.toContain("you/api-keys");
    expect(ids({ personalApiKeys: { enabled: false } })).not.toContain("you/connect");
    const shown = ids({ personalApiKeys: { enabled: true } });
    expect(shown).toContain("you/api-keys");
    expect(shown).toContain("you/connect");
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
    expect(markup).toContain("Fabian Kai");
    expect(markup).not.toContain("cat.apic_");
    // Only the active key offers Revoke.
    expect(markup.match(/>Revoke</gu)?.length).toBe(1);
  });
});

/** A refusal as the API answers it: a missing right, or the instance's policy. */
function refusal(code: "FORBIDDEN" | "POLICY_DENIED"): ApiError {
  return new ApiError(403, "Forbidden", {
    error: { code, message: "You may not do this. Settings > Instance > Access" }
  });
}

/** The scope box named `label`, as its label names it. */
function scopeBox(within: ParentNode, label: string): HTMLElement {
  const named = required(
    [...within.querySelectorAll<HTMLLabelElement>("label")].find(
      (candidate) => candidate.textContent === label
    )
  );
  return required(document.getElementById(named.htmlFor));
}

/** The scope label whose text is `label`, which a person may click instead of its box. */
function scopeLabel(within: ParentNode, label: string): HTMLLabelElement {
  return required(
    [...within.querySelectorAll<HTMLLabelElement>("label")].find(
      (candidate) => candidate.textContent === label
    )
  );
}

/**
 * Ticks and unticks scopes by the box and by its label, as e2e/personal-api-keys.spec.ts
 * `chooseScopes` did, and checks that only the clicked one changes each time.
 */
async function chooseScopes(within: ParentNode): Promise<void> {
  const checked = () =>
    [...within.querySelectorAll('[role="checkbox"][aria-checked="true"]')].length;
  expect(within.querySelectorAll('[role="checkbox"]').length).toBeGreaterThan(0);
  expect(checked()).toBe(0);
  const click = async (target: HTMLElement) => {
    await act(async () => {
      target.click();
    });
  };
  await click(scopeBox(within, "View agents"));
  await click(scopeLabel(within, "Edit skills"));
  await click(scopeBox(within, "Edit agents"));
  expect(checked()).toBe(3);
  // A second click unticks that one box and no other.
  await click(scopeLabel(within, "View agents"));
  expect(checked()).toBe(2);
  expect(scopeBox(within, "Edit agents").getAttribute("aria-checked")).toBe("true");
  expect(scopeBox(within, "Edit skills").getAttribute("aria-checked")).toBe("true");
  expect(scopeBox(within, "View agents").getAttribute("aria-checked")).toBe("false");
}

/** The button whose text is `label`, in the page or the dialog. */
function buttonNamed(label: string, within: ParentNode = document): HTMLButtonElement {
  return required(
    [...within.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === label
    )
  );
}

/** The buttons with words of a dialog, without its icon-only close button in the head. */
function footerButtons(dialog: HTMLElement): string[] {
  return [...dialog.querySelectorAll("button")]
    .map((button) => button.textContent ?? "")
    .filter((text) => text !== "");
}

describe("You > API keys, for a person and an admin alike", () => {
  // The refusal stood under the fields in the scrolling body, below the fold where Create key
  // was pressed, so the person saw nothing happen. Round 2: it was a red error, and Create key
  // sent the same refused key again.
  it("a refused new key says whom to ask beside Create key, which waits for a changed field", async () => {
    const posts: string[] = [];
    const answer: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path !== apiOperations["me.api_keys.list"].buildPath({})) {
        return Response.json(editorContext());
      }
      if (request.method !== "POST") return Response.json({ items: [] });
      posts.push(await request.text());
      return Response.json({ error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    };
    const mounted = await mountPage(
      settingsPageContext(
        createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: answer }),
        settingsUser({ instanceAdminName: "Mara" })
      ),
      "en",
      createElement(ApiKeysPage)
    );
    const said = "You may not issue this key. Ask an admin for all workspaces, for example Mara.";
    const name = () => required(document.querySelector<HTMLInputElement>("dialog input"));
    const type = async (value: string) => {
      await act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setValue?.call(name(), value);
        name().dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    try {
      await waitForText(mounted.container, "No personal API keys yet.");
      await act(async () => {
        buttonNamed("New key").click();
      });
      await type("laptop");
      await act(async () => {
        required(document.querySelector<HTMLElement>('dialog [role="checkbox"]')).click();
      });
      await act(async () => {
        buttonNamed("Create key").click();
      });
      await waitForText(document.body, said);
      expect(posts).toHaveLength(1);

      // The same key again would be refused again.
      expect(buttonNamed("Create key").disabled).toBe(true);
      await act(async () => {
        required(document.querySelector<HTMLFormElement>("dialog form")).requestSubmit();
      });
      expect(posts).toHaveLength(1);

      // A changed field is a new key to ask for.
      await type("laptop-2");
      expect(buttonNamed("Create key").disabled).toBe(false);
      expect(document.body.textContent).not.toContain(said);
      await act(async () => {
        buttonNamed("Create key").click();
      });
      await waitForText(document.body, said);
      expect(posts).toHaveLength(2);
      expect(posts[1]).toContain("laptop-2");
    } finally {
      await mounted.unmount();
    }
  });

  // Round 2: a refused Revoke still offered Revoke and Cancel, so the person could ask again
  // for what had just been refused.
  it("a refused revoke says whom to ask and leaves one Close", async () => {
    const revokes: string[] = [];
    const answer: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === apiOperations["me.api_keys.list"].buildPath({})) {
        return Response.json({ items: [key()] });
      }
      if (path === apiOperations["me.api_keys.revoke"].buildPath({ params: { keyId: "cred_1" } })) {
        revokes.push(path);
        return Response.json(
          { error: { code: "FORBIDDEN", message: "Forbidden" } },
          { status: 403 }
        );
      }
      return Response.json(platformContext());
    };
    const mounted = await mountPage(
      settingsPageContext(
        createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: answer }),
        settingsUser({ instanceAdminName: "Mara" })
      ),
      "en",
      createElement(ApiKeysPage)
    );
    const said = "You may not revoke this key. Ask an admin for all workspaces, for example Mara.";
    try {
      await waitForText(mounted.container, "fabian-mbp");
      await act(async () => {
        buttonNamed("Revoke").click();
      });
      const dialog = required(document.querySelector<HTMLDialogElement>("dialog[open]"));
      await act(async () => {
        buttonNamed("Revoke", dialog).click();
      });
      await waitForText(dialog, said);
      expect(revokes).toHaveLength(1);
      expect(footerButtons(dialog)).toEqual(["Close"]);
      await act(async () => {
        buttonNamed("Close", dialog).click();
      });
      expect(document.querySelector("dialog[open]")).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("a failed revoke is an error and offers Revoke again", async () => {
    const answer: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === apiOperations["me.api_keys.list"].buildPath({})) {
        return Response.json({ items: [key()] });
      }
      if (path === apiOperations["me.api_keys.revoke"].buildPath({ params: { keyId: "cred_1" } })) {
        return Response.json(
          { error: { code: "TIMEOUT", message: "The instance did not answer in time." } },
          { status: 504 }
        );
      }
      return Response.json(platformContext());
    };
    const mounted = await mountPage(
      settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: answer })),
      "en",
      createElement(ApiKeysPage)
    );
    try {
      await waitForText(mounted.container, "fabian-mbp");
      await act(async () => {
        buttonNamed("Revoke").click();
      });
      const dialog = required(document.querySelector<HTMLDialogElement>("dialog[open]"));
      await act(async () => {
        buttonNamed("Revoke", dialog).click();
      });
      await waitForText(dialog, "The instance did not answer in time.");
      expect(footerButtons(dialog)).toEqual(["Cancel", "Revoke"]);
    } finally {
      await mounted.unmount();
    }
  });

  it("a refused list of keys names whom to ask", async () => {
    const answer: typeof fetch = async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      return path === apiOperations["me.api_keys.list"].buildPath({})
        ? Response.json({ error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 })
        : Response.json(platformContext());
    };
    const mounted = await mountPage(
      settingsPageContext(
        createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: answer }),
        settingsUser({ instanceAdminName: "Mara" })
      ),
      "en",
      createElement(ApiKeysPage)
    );
    try {
      await waitForText(
        mounted.container,
        "You may not see your keys. Ask an admin for all workspaces, for example Mara."
      );
    } finally {
      await mounted.unmount();
    }
  });

  // Replaces e2e/personal-api-keys.spec.ts "a new key starts with no scope ticked and gets
  // exactly the scopes ticked": a click on a box or its label changes that box alone, and the
  // key is posted with exactly the ticked scopes.
  it("a new key starts with no scope ticked and is posted with exactly the scopes ticked", async () => {
    const posted: unknown[] = [];
    const answer: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path !== apiOperations["me.api_keys.list"].buildPath({})) {
        return Response.json(editorContext());
      }
      if (request.method !== "POST") return Response.json({ items: [] });
      posted.push(await request.json());
      return Response.json({ error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    };
    const mounted = await mountPage(
      settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: answer })),
      "en",
      createElement(ApiKeysPage)
    );
    try {
      await waitForText(mounted.container, "No personal API keys yet.");
      await act(async () => {
        buttonNamed("New key").click();
      });
      const dialog = required(document.querySelector<HTMLElement>("dialog[open]"));
      const name = required(dialog.querySelector<HTMLInputElement>("input"));
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          name,
          "scope-check"
        );
        name.dispatchEvent(new Event("input", { bubbles: true }));
      });
      // Nothing is ticked, so nothing can be created yet.
      expect(buttonNamed("Create key", dialog).disabled).toBe(true);
      await chooseScopes(dialog);
      await act(async () => {
        buttonNamed("Create key", dialog).click();
      });
      await waitForText(document.body, "You may not issue this key.");
      expect(posted).toEqual([
        expect.objectContaining({ name: "scope-check", scopes: ["agent.write", "skill.write"] })
      ]);
    } finally {
      await mounted.unmount();
    }
  });

  // Replaces e2e/personal-api-keys.spec.ts "a CLI's connect code starts with no scope ticked
  // and gets exactly the scopes ticked": it starts with every right offered but deleting, None
  // unticks them and Select all ticks every one, deleting too.
  it("a CLI's connect code starts with every right offered but deleting ticked and confirms exactly the scopes ticked", async () => {
    const confirmed: ConfirmConnectCodeRequest[] = [];
    const mounted = await mountPage(
      settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: fetch })),
      "en",
      createElement(ConnectCodeConfirm, {
        code: "BCDF-GHJK",
        request: {
          clientLabel: "catalyst CLI",
          createdAt: "2026-10-13T11:58:00.000Z",
          expiresAt: "2026-10-13T12:13:00.000Z"
        },
        offer: {
          ...cliOffer,
          everywhere: { actions: personalKeyActionOffer(platformContext()), useActions: [] }
        },
        pending: false,
        onConfirm: async (body) => {
          confirmed.push(body);
        }
      })
    );
    try {
      const boxes = () => [...mounted.container.querySelectorAll('[role="checkbox"]')];
      const ticked = () => boxes().filter((box) => box.getAttribute("aria-checked") === "true");
      const deletes = ["Delete agents", "Delete skills"];
      for (const label of deletes) {
        expect(scopeBox(mounted.container, label).getAttribute("aria-checked")).toBe("false");
      }
      expect(ticked().length).toBe(boxes().length - deletes.length);
      expect(buttonNamed("Select all", mounted.container).disabled).toBe(false);
      await act(async () => {
        buttonNamed("None", mounted.container).click();
      });
      expect(ticked()).toEqual([]);
      expect(buttonNamed("None", mounted.container).disabled).toBe(true);
      await act(async () => {
        buttonNamed("Select all", mounted.container).click();
      });
      expect(ticked().length).toBe(boxes().length);
      await act(async () => {
        buttonNamed("None", mounted.container).click();
      });
      await chooseScopes(mounted.container);
      await act(async () => {
        required(
          mounted.container.querySelector<HTMLButtonElement>('button[type="submit"]')
        ).click();
      });
      expect(confirmed).toEqual([
        expect.objectContaining({ scopes: ["agent.write", "skill.write"] })
      ]);
    } finally {
      await mounted.unmount();
    }
  });

  it("a connect code confirmed to never expire is sent with no expiry", async () => {
    const confirmed: ConfirmConnectCodeRequest[] = [];
    const mounted = await mountPage(
      settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: fetch })),
      "en",
      createElement(ConnectCodeConfirm, {
        code: "BCDF-GHJK",
        request: {
          clientLabel: "catalyst CLI",
          createdAt: "2026-10-13T11:58:00.000Z",
          expiresAt: "2026-10-13T12:13:00.000Z"
        },
        offer: {
          ...cliOffer,
          everywhere: { actions: personalKeyActionOffer(platformContext()), useActions: [] }
        },
        pending: false,
        onConfirm: async (body) => {
          confirmed.push(body);
        }
      })
    );
    try {
      const expiry = required(mounted.container.querySelector<HTMLSelectElement>("select"));
      // 90 days is where a key starts; never is one choice beside it.
      expect(expiry.value).toBe("90");
      await act(async () => {
        expiry.value = "never";
        expiry.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        required(
          mounted.container.querySelector<HTMLButtonElement>('button[type="submit"]')
        ).click();
      });
      expect(confirmed).toEqual([expect.objectContaining({ expiresAt: null })]);
    } finally {
      await mounted.unmount();
    }
  });

  it("a new key offers system.view unticked to a person who holds it and posts it once ticked", async () => {
    const posted: unknown[] = [];
    const answer: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path !== apiOperations["me.api_keys.list"].buildPath({})) {
        return Response.json({ ...platformContext(), instanceActions: ["system.view"] });
      }
      if (request.method !== "POST") return Response.json({ items: [] });
      posted.push(await request.json());
      return Response.json({ error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    };
    const mounted = await mountPage(
      settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: answer })),
      "en",
      createElement(ApiKeysPage)
    );
    try {
      await waitForText(mounted.container, "No personal API keys yet.");
      await act(async () => {
        buttonNamed("New key").click();
      });
      const dialog = required(document.querySelector<HTMLElement>("dialog[open]"));
      await waitForText(dialog, "View the System pages");
      const name = required(dialog.querySelector<HTMLInputElement>("input"));
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          name,
          "models-check"
        );
        name.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(scopeBox(dialog, "View the System pages").getAttribute("aria-checked")).toBe("false");
      expect(buttonNamed("Create key", dialog).disabled).toBe(true);
      await act(async () => {
        scopeLabel(dialog, "View the System pages").click();
      });
      await act(async () => {
        buttonNamed("Create key", dialog).click();
      });
      await waitForText(document.body, "You may not issue this key.");
      expect(posted).toEqual([
        expect.objectContaining({ name: "models-check", scopes: ["system.view"] })
      ]);
    } finally {
      await mounted.unmount();
    }
  });

  it("a connect code for `catalyst setup` or `login` offers neither the instance level nor the account and workspaces level", async () => {
    const confirmed: ConfirmConnectCodeRequest[] = [];
    const holder: PlatformContext = {
      ...platformContext(),
      instanceActions: ["agent.read", "system.view"],
      authoringActions: ["agent.read"]
    };
    const mounted = await mountPage(
      settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: fetch })),
      "en",
      createElement(ConnectCodeConfirm, {
        code: "BCDF-GHJK",
        request: {
          clientLabel: "catalyst CLI",
          createdAt: "2026-10-13T11:58:00.000Z",
          expiresAt: "2026-10-13T12:13:00.000Z"
        },
        offer: {
          ...cliOffer,
          everywhere: { actions: personalKeyHeldActionOffer(holder), useActions: [] },
          instanceActions: personalKeyInstanceOffer(holder),
          accountActions: personalKeyAccountOffer(holder),
          workspaces: [sharedWorkspace("ws-tax", "Tax", ["agent.read"])]
        },
        pending: false,
        onConfirm: async (body) => {
          confirmed.push(body);
        }
      })
    );
    try {
      const text = mounted.container.textContent;
      expect(text).not.toContain("View the System pages");
      expect(text).not.toContain("Lets the key only read what is shared by all workspaces");
      expect(text).not.toContain("Account and workspaces");
      expect(text).not.toContain("Change your name");
      await act(async () => {
        required(
          mounted.container.querySelector<HTMLButtonElement>('button[type="submit"]')
        ).click();
      });
      expect(confirmed.at(-1)?.scopes).toEqual(["agent.read"]);
    } finally {
      await mounted.unmount();
    }
  });

  // A refusal sent the person to Settings > Instance > Access, a page only an admin opens.
  it("a refused confirmation names whom to ask, never a page", async () => {
    const said = "You may not issue this key. Ask an admin for all workspaces.";
    const mounted = await mountPage(
      settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: fetch })),
      "en",
      createElement(ConnectCodeConfirm, {
        code: "BCDF-GHJK",
        request: {
          createdAt: "2026-10-13T11:58:00.000Z",
          expiresAt: "2026-10-13T12:13:00.000Z"
        },
        offer: cliOffer,
        pending: false,
        onConfirm: () => Promise.reject(refusal("POLICY_DENIED"))
      })
    );
    try {
      const box = required(mounted.container.querySelector<HTMLElement>('[role="checkbox"]'));
      await act(async () => {
        box.click();
      });
      const confirm = required(
        mounted.container.querySelector<HTMLButtonElement>('button[type="submit"]')
      );
      await act(async () => {
        confirm.click();
      });
      await waitForText(mounted.container, said);
      expect(mounted.container.textContent).not.toContain("Settings >");
      // The same key would be refused again: Confirm waits for a changed field.
      expect(confirm.disabled).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });
});

// You > Connect a local agent: one command per tool that installs the CLI version the instance
// names, one on npm, and runs `catalyst setup` against the instance (CONNECT-1a).
describe("You > Connect a local agent", () => {
  it("gives each tool one command with the instance's CLI version and address", () => {
    expect(LOCAL_AGENT_TOOLS).toEqual(["claude-code", "codex", "other"]);
    expect(localAgentCommand("claude-code", "1.4.0", SETTINGS_INSTANCE_URL)).toBe(
      "npm install --global @work-shape/catalyst-cli@1.4.0 && catalyst setup claude-code --instance https://chat.example.com"
    );
    expect(localAgentCommand("codex", "1.4.0", SETTINGS_INSTANCE_URL)).toContain(
      "catalyst setup codex --instance"
    );
    expect(localAgentCommand("other", "1.4.0", SETTINGS_INSTANCE_URL)).toContain(
      "catalyst setup other --instance"
    );
  });

  it.each([undefined, "1.4.0"])(
    "opening, switching tools and copying issues no key or code (CLI %s)",
    async (cliVersion) => {
      const calls: string[] = [];
      const context = { ...platformContext(), release: { version: "1.4.0", cliVersion } };
      const record: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        return Response.json(context);
      };
      // Also record a direct fetch, so bypassing the API client cannot issue a key unseen.
      vi.stubGlobal("fetch", record);
      const mounted = await mountPage(
        settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: record })),
        "en",
        createElement(ConnectLocalAgentPage)
      );
      const { container } = mounted;
      const copied: string[] = [];
      const clipboard = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockImplementation(async (value) => {
          copied.push(value);
        });
      try {
        await waitForText(
          container,
          cliVersion ? "npm install" : "The command is not available yet"
        );
        for (const tool of LOCAL_AGENT_TOOLS) {
          const label = { "claude-code": "Claude Code", codex: "Codex", other: "Other" }[tool];
          const option = required(
            [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
              (node) => node.textContent === label
            )
          );
          await act(async () => {
            option.click();
          });
          expect(option.getAttribute("aria-checked")).toBe("true");
          const copy = container.querySelector<HTMLButtonElement>(
            'button[aria-label="Copy"], button[aria-label="Copied"]'
          );
          if (cliVersion) {
            expect(container.textContent).toContain(
              localAgentCommand(tool, cliVersion, SETTINGS_INSTANCE_URL)
            );
            await act(async () => {
              required(copy).click();
            });
            expect(copied.at(-1)).toBe(localAgentCommand(tool, cliVersion, SETTINGS_INSTANCE_URL));
          } else {
            expect(copy).toBeNull();
          }
          const operation = apiOperations["platform.context.get"];
          expect(calls).toEqual([`${operation.method} ${operation.buildPath({})}`]);
        }
      } finally {
        clipboard.mockRestore();
        await mounted.unmount();
      }
    }
  );
});
