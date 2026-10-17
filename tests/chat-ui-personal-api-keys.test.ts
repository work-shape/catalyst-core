// @vitest-environment happy-dom

import { act, createElement } from "react";
import { ApiError, createApiClient } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { required } from "./support/assertions";
import { describe, expect, it, vi } from "vitest";
import type { PersonalApiKey, PlatformContext } from "@work-shape/catalyst-api-client";
import { administration } from "@work-shape/catalyst-chat-ui/admin";
import {
  PersonalApiKeysTable,
  buildPersonalKeyScopes,
  connectCodeAsksUseLevel,
  connectCodeOfSearch,
  formatConnectCode,
  initialPersonalKeyDraft,
  instanceUrl,
  isCompleteConnectCode,
  keysSharingAName,
  personalKeyActionOffer,
  personalKeyDraftProblem,
  personalKeyExpiryOf,
  personalKeyRequest,
  personalKeyUseOffer,
  personalKeyScopeParts,
  personalKeyState,
  setupKeyActions,
  settingsCatalog,
  visibleSettingsPages,
  ApiKeysPage,
  ConnectCodeConfirm,
  ConnectLocalAgentPage,
  ConnectLocalAgentView,
  LOCAL_AGENT_TOOLS,
  localAgentCommand,
  type LocalAgentCommandState,
  type LocalAgentTool
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
  actions: ["agent.read", "agent.write"],
  useActions: [],
  setupActions: [],
  namespaces: [],
  settled: true
};

function key(overrides: Partial<PersonalApiKey> = {}): PersonalApiKey {
  return {
    id: "cred_1",
    ownerUserId: "user_1",
    ownerDisplayLabel: "Fabian Kai",
    name: "fabian-mbp",
    keyPrefix: "cat.apic_1f0c2a9e-7b6d-4c3a-9e8f-0a1b2c3d4e5f.",
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

  it("starts the key `catalyst setup` asks for with the held authoring rights the screen offers and the use level", () => {
    expect(setupKeyActions(undefined)).toEqual([]);
    expect(
      setupKeyActions({
        ...platformContext(),
        authoringActions: ["agent.read", "agent.write", "workflow.publish"],
        useActions: ["connection.use"]
      })
    ).toEqual(["agent.read", "agent.write", "connection.use"]);
  });

  it("reads whether the CLI's setup asked for the use level", () => {
    expect(connectCodeAsksUseLevel("?code=bcdf-ghjk&level=use")).toBe(true);
    expect(connectCodeAsksUseLevel("?code=bcdf-ghjk")).toBe(false);
    expect(connectCodeAsksUseLevel("?code=bcdf-ghjk&level=admin")).toBe(false);
    expect(initialPersonalKeyDraft("x", ["connection.use"]).actions).toEqual(["connection.use"]);
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

  it("limits every chosen action to the Namespace where one is given", () => {
    expect(buildPersonalKeyScopes(["agent.write", "skill.read"], "")).toEqual([
      "agent.write",
      "skill.read"
    ]);
    expect(buildPersonalKeyScopes(["agent.write"], " kai- ")).toEqual(["agent.write:kai-"]);
  });

  it("sends a draft once it has a name, a scope and a well-formed Namespace", () => {
    const draft = { ...initialPersonalKeyDraft("laptop"), actions: ["agent.write"] };
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
      { ...initialPersonalKeyDraft("x"), actions: ["agent.read"], expiryDays: 365 },
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

  it("reads a scope back as its action and the prefix it is limited to", () => {
    expect(personalKeyScopeParts("agent.write:kai-")).toEqual({
      action: "agent.write",
      prefix: "kai-"
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

  const renderConfirm = (locale: "en" | "de", asksUseLevel?: boolean) =>
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
          offer: {
            ...cliOffer,
            actions: ["agent.read", "agent.write"],
            useActions: ["connection.use", "workflow.use"],
            setupActions: ["agent.read", "agent.write", "connection.use", "workflow.use"]
          },
          ...(asksUseLevel === undefined ? {} : { asksUseLevel }),
          pending: false,
          onConfirm: async () => undefined
        })
      )
    );

  it("ticks the authoring rights and the use level for the key `catalyst setup` asks for, and nothing for any other", () => {
    const setup = renderConfirm("en", true);
    expect(setup).toContain("Use");
    expect(setup.match(/aria-checked="true"/gu)?.length).toBe(4);
    expect(renderConfirm("de", true)).toContain("Verwenden");
    expect(renderConfirm("en").match(/aria-checked="true"/gu)).toBeNull();
  });

  it("shows what a connect code asks for with the warning, in English and German", () => {
    const render = (locale: "en" | "de") => renderConfirm(locale);
    const english = render("en");
    expect(english).toContain("catalyst CLI on fabian-mbp");
    expect(english).toContain("Only confirm a code your own terminal shows you");
    expect(english).toContain("BCDF-GHJK");
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
    expect(markup).toContain("Revoked");
    // Only the active key offers Revoke.
    expect(markup.match(/>Revoke</gu)?.length).toBe(1);
  });
});

/** The keys table as static markup, in one language. */
function keysTable(locale: "en" | "de", keys: PersonalApiKey[], showOwner = false): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(PersonalApiKeysTable, {
        keys,
        loading: false,
        showOwner,
        revoking: false,
        onRevoke: async () => undefined
      })
    )
  );
}

/** The element of `tag` in the markup whose text is exactly `text`. */
function elementSaying(markup: string, tag: string, text: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = markup;
  return required(
    [...root.querySelectorAll<HTMLElement>(tag)].find((element) => element.textContent === text)
  );
}

/**
 * The text of each head of a table's markup, whether it folds, and whether it takes only its
 * content's width.
 */
function heads(markup: string): { text: string; folds: boolean; narrowest: boolean }[] {
  const table = document.createElement("div");
  table.innerHTML = markup;
  return [...table.querySelectorAll("th")].map((head) => ({
    text: head.textContent ?? "",
    folds: head.hasAttribute("data-column"),
    narrowest: head.classList.contains("w-0")
  }));
}

// UI-KEYS, from the design reviews of 2026-10-17: the table showed raw scope ids and key
// prefixes, times with seconds, and at 1280 Status and Revoke sat behind a sideways scroll.
describe("You > API keys in plain words", () => {
  it("names each scope as the rights screens do, with its prefix, in English and German", () => {
    const english = keysTable("en", [key()]);
    expect(english).toContain("Edit agents in kai-");
    expect(english).toContain("View skills");
    expect(english).not.toContain("agent.write");
    expect(english).not.toContain("skill.read");
    const german = keysTable("de", [key()]);
    expect(german).toContain("Agenten bearbeiten in kai-");
    expect(german).toContain("Skills ansehen");
    expect(german).toContain("Was der Schlüssel darf");
  });

  // Badges of rights stacked and were cut at 390; one muted line breaks between words instead.
  it("lists what a key may do as one muted line, comma-separated", () => {
    // The span carries the muted tone, since a folded cell moves only its children.
    const rights = elementSaying(
      keysTable("en", [key()]),
      "span",
      "Edit agents in kai-, View skills"
    );
    expect(rights.classList.contains("text-muted-foreground")).toBe(true);
  });

  it("says how a key starts only where its owner holds another of the same name", () => {
    expect(keysTable("en", [key()])).not.toContain("cat.apic_");
    const twins = [
      key(),
      key({ id: "cred_2", keyPrefix: "cat.apic_8d7e6f5a-1b2c-4d3e-8f9a-0b1c2d3e4f5a." })
    ];
    const english = keysTable("en", twins);
    // The id's first eight letters tell the two apart; the rest and the stored dot are left out.
    expect(english).toContain("Starts with cat.apic_1f0c2a9e…");
    expect(english).toContain("Starts with cat.apic_8d7e6f5a…");
    expect(english).not.toContain("1f0c2a9e-7b6d");
    expect(keysTable("de", twins)).toContain("Beginnt mit cat.apic_1f0c2a9e…");
    // Wrapped anywhere at a phone's width, never cut.
    const start = elementSaying(english, "span", "Starts with cat.apic_1f0c2a9e…");
    expect(start.classList.contains("wrap-anywhere")).toBe(true);
    expect(start.classList.contains("truncate")).toBe(false);
  });

  it("shows an active key in the success tone and Revoke as an outline button", () => {
    const markup = keysTable("en", [key()]);
    expect(elementSaying(markup, "span", "Active").classList.contains("bg-success-soft")).toBe(
      true
    );
    expect(elementSaying(markup, "button", "Revoke").classList.contains("border-input")).toBe(true);
  });

  it("shows created, expires and last used without seconds", () => {
    const markup = keysTable("de", [
      key({
        createdAt: "2026-10-01T10:00:37.000Z",
        expiresAt: "2027-01-01T10:00:41.000Z",
        lastUsedAt: "2026-10-12T08:15:53.000Z"
      })
    ]);
    expect(markup).not.toMatch(/:(37|41|53)\b/u);
    expect(markup).toContain("01.10.2026");
  });

  // At 390 Status and Revoke took the room the name's details needed, which then spilled over.
  it("folds every column but name, status and Revoke, which leave the name the room", () => {
    expect(heads(keysTable("en", [key()], true))).toEqual([
      { text: "Name", folds: false, narrowest: false },
      { text: "Owner", folds: true, narrowest: false },
      { text: "What the key may do", folds: true, narrowest: false },
      { text: "Expires", folds: true, narrowest: false },
      { text: "Last used", folds: true, narrowest: false },
      { text: "Created", folds: true, narrowest: false },
      { text: "Status", folds: false, narrowest: true },
      { text: "", folds: false, narrowest: true }
    ]);
  });

  it("offers each scope of a new key by its title alone, one under the other", () => {
    const render = (locale: "en" | "de") =>
      renderToStaticMarkup(
        createElement(
          TranslationProvider,
          { children: null, locale },
          createElement(ConnectCodeConfirm, {
            code: "BCDF-GHJK",
            request: {
              createdAt: "2026-10-13T11:58:00.000Z",
              expiresAt: "2026-10-13T12:13:00.000Z"
            },
            offer: { ...cliOffer, actions: ["agent.write", "workflow.publish"] },
            pending: false,
            onConfirm: async () => undefined
          })
        )
      );
    const english = render("en");
    expect(english).toContain("Edit agents");
    expect(english).toContain("Publish workflows");
    expect(english).not.toContain("Make a draft the version that runs.");
    expect(english).not.toContain("agent.write");
    expect(english).not.toContain("workflow.publish");
    // One right under the other at every width.
    expect(english).not.toContain("sm:grid-cols-2");
    expect(english).toContain("Where you use the key, such as your laptop or a script.");
    expect(english).toContain("If you lose a right later, the key loses it too.");
    const german = render("de");
    expect(german).toContain("Agenten bearbeiten");
    expect(german).toContain("Workflows veröffentlichen");
    // Ends without a full stop, as the hint was approved.
    expect(german).toContain(
      "Wo du den Schlüssel verwendest, etwa auf dem Laptop oder in einem Skript</"
    );
    expect(german).toContain("Verlierst du später ein Recht, verliert es auch der Schlüssel.");
  });
});

/** A refusal as the API answers it: a missing right, or the instance's policy. */
function refusal(code: "FORBIDDEN" | "POLICY_DENIED"): ApiError {
  return new ApiError(403, "Forbidden", {
    error: { code, message: "You may not do this. Settings > Instance > Access" }
  });
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

/** The banner or error that says exactly `said`. */
function noticeSaying(said: string): HTMLElement {
  return required(
    [...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')].find(
      (notice) => notice.textContent === said
    )
  );
}

describe("You > API keys, for a person and an admin alike", () => {
  // UXA-5: the page opened with Connect the CLI; a person's own keys stood below it.
  it("opens with the person's own keys and puts Connect the CLI second", async () => {
    const answer: typeof fetch = async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      return path === apiOperations["me.api_keys.list"].buildPath({})
        ? Response.json({ items: [key()] })
        : Response.json(platformContext());
    };
    const mounted = await mountPage(
      settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: answer })),
      "en",
      createElement(ApiKeysPage)
    );
    try {
      await waitForText(mounted.container, "fabian-mbp");
      const headings = [...mounted.container.querySelectorAll("h2")].map(
        (heading) => heading.textContent
      );
      expect(headings).toEqual(["Your keys", "Connect the CLI"]);
    } finally {
      await mounted.unmount();
    }
  });

  // The refusal stood under the fields in the scrolling body, below the fold where Create key
  // was pressed, so the person saw nothing happen. Round 2: it was a red error, and Create key
  // sent the same refused key again.
  it("a refused new key says whom to ask beside Create key, which waits for a changed field", async () => {
    const posts: string[] = [];
    const answer: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path !== apiOperations["me.api_keys.list"].buildPath({})) {
        return Response.json(platformContext());
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
    const said = "You may not issue this key. Ask an instance admin, for example Mara.";
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
      const refusal = noticeSaying(said);
      expect(refusal.getAttribute("data-tone")).toBe("info");
      expect(refusal.parentElement?.contains(buttonNamed("Create key"))).toBe(true);
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
    const said = "You may not revoke this key. Ask an instance admin, for example Mara.";
    try {
      await waitForText(mounted.container, "fabian-mbp");
      await act(async () => {
        buttonNamed("Revoke").click();
      });
      const dialog = required(document.querySelector<HTMLDialogElement>("dialog[open]"));
      expect(footerButtons(dialog)).toEqual(["Cancel", "Revoke"]);
      await act(async () => {
        buttonNamed("Revoke", dialog).click();
      });
      await waitForText(dialog, said);
      expect(revokes).toHaveLength(1);
      expect(noticeSaying(said).getAttribute("data-tone")).toBe("info");
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
      const failure = required(dialog.querySelector('[role="alert"]'));
      expect(failure.textContent).toBe("The instance did not answer in time.");
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
        "You may not see your keys. Ask an instance admin, for example Mara."
      );
      const refusal = noticeSaying(
        "You may not see your keys. Ask an instance admin, for example Mara."
      );
      expect(refusal.getAttribute("data-tone")).toBe("info");
    } finally {
      await mounted.unmount();
    }
  });

  // A refusal sent the person to Settings > Instance > Access, a page only an admin opens.
  it.each([
    {
      locale: "en" as const,
      code: "FORBIDDEN" as const,
      instanceAdminName: "Mara",
      said: "You may not issue this key. Ask an instance admin, for example Mara."
    },
    {
      locale: "de" as const,
      code: "POLICY_DENIED" as const,
      instanceAdminName: undefined,
      said: "Du darfst diesen Schlüssel nicht ausstellen. Frag jemanden, der die Instanz verwaltet."
    }
  ])(
    "a refused confirmation names whom to ask, never a page ($locale)",
    async ({ locale, code, instanceAdminName, said }) => {
      const mounted = await mountPage(
        settingsPageContext(
          createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: fetch }),
          settingsUser({ instanceAdminName })
        ),
        locale,
        createElement(ConnectCodeConfirm, {
          code: "BCDF-GHJK",
          request: {
            createdAt: "2026-10-13T11:58:00.000Z",
            expiresAt: "2026-10-13T12:13:00.000Z"
          },
          offer: cliOffer,
          pending: false,
          onConfirm: () => Promise.reject(refusal(code))
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
        expect(noticeSaying(said).getAttribute("data-tone")).toBe("info");
        // The same key would be refused again: Confirm waits for a changed field.
        expect(confirm.disabled).toBe(true);
      } finally {
        await mounted.unmount();
      }
    }
  );
});

// You > Connect a local agent: one command per tool that installs the CLI version the instance
// names, one on npm, and runs `catalyst setup` against the instance. Platform Access acceptance
// check 52 (CONNECT-1a). Fails without the change: the page did not exist.

function renderConnect(
  tool: LocalAgentTool,
  locale: "en" | "de",
  state: LocalAgentCommandState
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(ConnectLocalAgentView, { tool, onToolChange: () => undefined, state })
    )
  );
}

const ready = (command: string): LocalAgentCommandState => ({ status: "ready", command });

describe("You > Connect a local agent", () => {
  const catalog = settingsCatalog(administration);
  const ids = (modules?: Record<string, { enabled: boolean }>) =>
    visibleSettingsPages(catalog, {
      user: settingsUser(),
      workspaces: [personalWorkspace()],
      modules
    }).map((page) => `${page.group}/${page.id}`);

  it("is shown under You beside API keys while personal API keys are on", () => {
    expect(ids()).not.toContain("you/connect");
    expect(ids({ personalApiKeys: { enabled: false } })).not.toContain("you/connect");
    const shown = ids({ personalApiKeys: { enabled: true } });
    expect(shown.indexOf("you/connect")).toBe(shown.indexOf("you/api-keys") + 1);
  });

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

  it("shows the command of the chosen tool with a copy button, in English and German", () => {
    for (const tool of LOCAL_AGENT_TOOLS) {
      const command = localAgentCommand(tool, "1.4.0", SETTINGS_INSTANCE_URL);
      const english = renderConnect(tool, "en", ready(command));
      expect(english).toContain("Connect a local agent");
      expect(english).toContain(command.replaceAll("&", "&amp;"));
      expect(english).toContain('aria-label="Copy"');
      expect(english).toContain("Node 22");
      expect(english).toContain('href="/settings/you/api-keys"');
      const german = renderConnect(tool, "de", ready(command));
      expect(german).toContain("Lokalen Agenten verbinden");
      expect(german).toContain("Node 22");
    }
    expect(renderConnect("codex", "en", ready("x"))).toContain("Command for Codex");
    expect(renderConnect("other", "de", ready("x"))).toContain("dein Werkzeug bekommt einen Skill");
    const german = renderConnect("other", "de", ready("x"));
    expect(german).toContain("in deinem Namen");
    expect(german).toContain(">Anderes<");
    expect(german).toContain("Braucht Node 22 oder neuer.");
  });

  it("shows no command while the context is read, and says so while no CLI is published for the instance", () => {
    expect(renderConnect("codex", "en", { status: "loading" })).not.toContain("catalyst setup");
    const unavailable = renderConnect("codex", "en", { status: "unavailable" });
    expect(unavailable).toContain("The command is not available yet");
    expect(unavailable).not.toContain("npm install");
    expect(unavailable).not.toContain('aria-label="Copy"');
    expect(renderConnect("codex", "de", { status: "unavailable" })).toContain(
      "Der Befehl ist noch nicht verfügbar"
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
