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
  connectCodeOfSearch,
  formatConnectCode,
  initialPersonalKeyDraft,
  instanceUrl,
  isCompleteConnectCode,
  personalKeyActionOffer,
  personalKeyDraftProblem,
  personalKeyExpiryOf,
  personalKeyRequest,
  personalKeyState,
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
const cliOffer = { actions: ["agent.read", "agent.write"], namespaces: [] };

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
            offer: cliOffer,
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
