// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { act, createElement } from "react";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { apiOperations, safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { createSafeConfigView } from "@work-shape/catalyst-config-schema";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { createTestConfig } from "./support/fixtures";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import {
  SettingsPageProvider,
  type SettingsPageContextValue
} from "@work-shape/catalyst-chat-ui/settings-page-context";
import { describe, expect, it, vi } from "vitest";
import type { PersonalApiKey, PlatformContext } from "@work-shape/catalyst-api-client";
import { administration } from "@work-shape/catalyst-chat-ui/admin";
import { PersonalApiKeysTable } from "../packages/chat-ui/src/admin/control-plane/personal-api-keys-list";
import {
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
  personalKeyState
} from "../packages/chat-ui/src/admin/control-plane/personal-api-keys-model";
import {
  settingsCatalog,
  visibleSettingsPages
} from "../packages/chat-ui/src/admin/settings/catalog";
import { ConnectCodeConfirm } from "../packages/chat-ui/src/admin/settings/pages/api-keys";
import {
  ConnectLocalAgentPage,
  ConnectLocalAgentView,
  LOCAL_AGENT_TOOLS,
  localAgentCommand,
  type LocalAgentCommandState,
  type LocalAgentTool
} from "../packages/chat-ui/src/admin/settings/pages/connect-local-agent";
import { platformContext } from "./chat-ui-build-fixtures";
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
            offer: { actions: ["agent.read", "agent.write"], namespaces: [] },
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

// You > Connect a local agent: one command per tool that installs the CLI version the instance
// names, one on npm, and runs `catalyst setup` against the instance. Platform Access acceptance
// check 52 (CONNECT-1a). Fails without the change: the page did not exist.

const URL_OF_INSTANCE = "https://chat.example.com";

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
    expect(localAgentCommand("claude-code", "1.4.0", URL_OF_INSTANCE)).toBe(
      "npm install --global @work-shape/catalyst-cli@1.4.0 && catalyst setup claude-code --instance https://chat.example.com"
    );
    expect(localAgentCommand("codex", "1.4.0", URL_OF_INSTANCE)).toContain(
      "catalyst setup codex --instance"
    );
    expect(localAgentCommand("other", "1.4.0", URL_OF_INSTANCE)).toContain(
      "catalyst setup other --instance"
    );
  });

  it("shows the command of the chosen tool with a copy button, in English and German", () => {
    for (const tool of LOCAL_AGENT_TOOLS) {
      const command = localAgentCommand(tool, "1.4.0", URL_OF_INSTANCE);
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
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const calls: string[] = [];
      const context = { ...platformContext(), release: { version: "1.4.0", cliVersion } };
      const record: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        return Response.json(context);
      };
      // Also record a direct fetch, so bypassing the API client cannot issue a key unseen.
      vi.stubGlobal("fetch", record);
      const client = createApiClient({ baseUrl: URL_OF_INSTANCE, fetchImpl: record });
      const config = createTestConfig();
      const settings: SettingsPageContextValue = {
        apiBaseUrl: URL_OF_INSTANCE,
        authScope: "connect-test",
        client,
        user: settingsUser(),
        config: safeConfigSchema.parse(
          createSafeConfigView(
            config,
            { version: 0, agents: [], skills: [] },
            resolveInstanceModules(config, []).snapshot
          )
        ),
        locales: ["en", "de"],
        locale: "en",
        selectLocale: () => undefined,
        showContextIndicator: false,
        setShowContextIndicator: () => undefined,
        themePreference: "light",
        selectThemePreference: () => undefined,
        workspace: undefined,
        activeWorkspace: personalWorkspace(),
        onAccountDeleted: () => undefined,
        onWorkspaceLeft: () => undefined,
        onWorkspaceDeleted: () => undefined
      };
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const copied: string[] = [];
      const clipboard = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockImplementation(async (value) => {
          copied.push(value);
        });
      try {
        await act(async () => {
          root.render(
            createElement(
              QueryClientProvider,
              { client: queryClient },
              createElement(
                SettingsPageProvider,
                { value: settings },
                createElement(
                  TranslationProvider,
                  { locale: "en", children: null },
                  createElement(
                    UiRoot,
                    { mode: "light", labels: uiLabelsEn },
                    createElement(ConnectLocalAgentPage)
                  )
                )
              )
            )
          );
        });
        await vi.waitFor(
          async () => {
            await act(async () => {
              expect(container.textContent).toContain(
                cliVersion ? "npm install" : "The command is not available yet"
              );
            });
          },
          { timeout: CONDITION_WAIT_MS }
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
              localAgentCommand(tool, cliVersion, URL_OF_INSTANCE)
            );
            await act(async () => {
              required(copy).click();
            });
            expect(copied.at(-1)).toBe(localAgentCommand(tool, cliVersion, URL_OF_INSTANCE));
          } else {
            expect(copy).toBeNull();
          }
          const operation = apiOperations["platform.context.get"];
          expect(calls).toEqual([`${operation.method} ${operation.buildPath({})}`]);
        }
      } finally {
        await act(async () => {
          root.unmount();
        });
        queryClient.clear();
        container.remove();
        clipboard.mockRestore();
        vi.unstubAllGlobals();
      }
    }
  );
});
