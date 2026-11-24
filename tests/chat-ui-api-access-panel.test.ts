// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ServicePrincipalDetail } from "@work-shape/catalyst-api-client";
import { canManageApiAccess, canViewAdministrationPanel } from "@work-shape/catalyst-chat-ui/admin";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { required, waitUntil } from "./support/assertions";
import {
  ApiAccessPanel,
  constrainCredentialScopes,
  copySecretField,
  copyStateFor,
  createApiAccessAuthorityKey,
  createApiAccessRevealController,
  DEFAULT_SERVICE_PRINCIPAL_PERMISSIONS,
  isCredentialActive,
  scopesAllowedByPermissions,
  SecretFields
} from "./support/chat-ui";

function principal(
  id: string,
  displayLabel: string,
  permissions: ServicePrincipalDetail["principal"]["permissions"]
): ServicePrincipalDetail {
  return {
    principal: {
      id,
      clientInstanceId: "client-1",
      name: id,
      displayLabel,
      status: "active",
      permissionRefs: [],
      permissions,
      createdAt: "2026-10-25T10:00:00Z",
      updatedAt: "2026-10-25T10:00:00Z"
    },
    credentials: []
  };
}

const detail: ServicePrincipalDetail = {
  ...principal("sp_cli", "Catalyst CLI", ["config_assets.read", "config_assets.release"]),
  credentials: [
    {
      id: "cred-1",
      clientInstanceId: "client-1",
      servicePrincipalId: "sp_cli",
      name: "CI production",
      keyPrefix: "cat_live_abc123",
      scopes: ["config_assets:read", "config_assets:release"],
      createdAt: "2026-07-12T10:00:00Z"
    }
  ]
};
const credential = required(detail.credentials[0]);

function panelProps(
  overrides: Partial<ComponentProps<typeof ApiAccessPanel>> = {}
): ComponentProps<typeof ApiAccessPanel> {
  return {
    may: { principals: true, keys: true },
    principals: [detail],
    loading: false,
    mutating: false,
    onCreatePrincipal: async () => detail,
    onUpdatePrincipal: async () => detail,
    onCreateCredential: async () => ({ credential, secret: "never-rendered" }),
    onRevokeCredential: async () => credential,
    onClearRevealedCredential: () => undefined,
    ...overrides
  };
}

const staticPanel = (
  overrides: Partial<ComponentProps<typeof ApiAccessPanel>> = {},
  locale: "en" | "de" = "en"
) =>
  renderToStaticMarkup(
    createElement(TranslationProvider, {
      locale,
      children: createElement(ApiAccessPanel, panelProps(overrides))
    })
  );

describe("API access model", () => {
  it("maps only current service-principal grants to credential scopes", () => {
    expect(DEFAULT_SERVICE_PRINCIPAL_PERMISSIONS).toEqual(["config_assets.read"]);
    expect(scopesAllowedByPermissions(["config_assets.read"])).toEqual(["config_assets:read"]);
    expect(
      constrainCredentialScopes(
        ["config_assets:read", "config_assets:release"],
        ["config_assets.read"]
      )
    ).toEqual(["config_assets:read"]);
  });

  it("treats revoked and expired credentials as inactive", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    expect(isCredentialActive({}, now)).toBe(true);
    expect(isCredentialActive({ expiresAt: "2029-12-31T23:59:59Z" }, now)).toBe(false);
    expect(isCredentialActive({ revokedAt: "2029-01-01T00:00:00Z" }, now)).toBe(false);
  });

  it("makes API access visible only through its dedicated permission", () => {
    const apiAccessManager = {
      id: "user-1",
      clientInstanceId: "client-1",
      authSource: "standalone",
      externalUserId: "manager",
      displayLabel: "Manager",
      roles: ["superadmin"],
      permissionRefs: [],
      permissions: ["api_access.manage"]
    } as NonNullable<Parameters<typeof canManageApiAccess>[0]>;

    expect(canManageApiAccess(apiAccessManager)).toBe(true);
    expect(canViewAdministrationPanel(apiAccessManager)).toBe(true);
    expect(canManageApiAccess({ ...apiAccessManager, permissions: ["users.manage"] })).toBe(false);
  });

  it("discards a deferred credential reveal when authority changed or was lost", async () => {
    const key = (apiBaseUrl: string, principalId: string) =>
      createApiAccessAuthorityKey({ apiBaseUrl, principalId, canIssueKeys: true });
    for (const next of [key("https://b.example.com", "user-b"), undefined]) {
      const controller = createApiAccessRevealController(key("https://a.example.com", "user-a"));
      const originAuthority = controller.captureAuthority();
      let resolveResponse!: () => void;
      const responsePending = new Promise<void>((resolve) => {
        resolveResponse = resolve;
      });
      const completion = (async () => {
        await responsePending;
        return controller.accept(originAuthority, {
          secret: "cat_live_late",
          credentialName: "Late key",
          serverUrl: "https://a.example.com"
        });
      })();
      controller.updateAuthority(next);
      resolveResponse();
      await expect(completion).resolves.toBeUndefined();
    }
  });

  it("binds an accepted reveal to its origin authority, and rejects one from an earlier session", () => {
    const authority = createApiAccessAuthorityKey({
      apiBaseUrl: "https://a.example.com",
      principalId: "user-a",
      canIssueKeys: true
    });
    const reveal = {
      secret: "cat_live_once",
      credentialName: "Laptop",
      serverUrl: "https://a.example.com"
    };
    const controller = createApiAccessRevealController(authority);
    expect(controller.accept(controller.captureAuthority(), reveal)).toEqual({
      ...reveal,
      authorityKey: authority
    });

    // An old completion is refused even if the same authority later returns.
    const old = createApiAccessRevealController("authority-a");
    const originAuthority = old.captureAuthority();
    old.updateAuthority("authority-b");
    old.updateAuthority("authority-a");
    expect(old.accept(originAuthority, reveal)).toBeUndefined();
  });

  it("drops an API key copy result when the dialog opens for another credential", () => {
    for (const state of [{ failed: true }, { copied: "key" as const }]) {
      const recorded = { secret: "cat_live_first", state };
      expect(copyStateFor(recorded, "cat_live_first")).toEqual(state);
      expect(copyStateFor(recorded, "cat_live_next")).toEqual({});
    }
    expect(copyStateFor(undefined, "cat_live_first")).toEqual({});
  });
});

describe("API access panel", () => {
  it("offers nothing to a reader who may not see the service principals", () => {
    const markup = staticPanel({ may: { principals: false, keys: true }, principals: [] });
    expect(markup).toContain("You may not see the service principals.");
    expect(markup).not.toContain("Create service principal");
    expect(markup).not.toContain("Create API key");
    expect(markup).not.toContain(">Revoke<");
  });

  it("offers principals to who administers them and keys only to who issues keys", () => {
    const markup = staticPanel({ may: { principals: true, keys: false } });
    expect(markup).toContain("Create service principal");
    expect(markup).toContain(">Edit<");
    expect(markup).not.toContain("Create API key");
    expect(markup).not.toContain(">Revoke<");
  });

  it("shows a revealed key only while the hook supplies it", () => {
    const revealed = staticPanel({
      revealedCredential: {
        secret: "cat_live_once",
        credentialName: "Laptop",
        serverUrl: "https://catalyst.example.com",
        authorityKey: "authority-a"
      }
    });
    expect(revealed).toContain("cat_live_once");
    expect(staticPanel()).not.toContain("cat_live_once");
    expect(staticPanel()).not.toContain("never-rendered");
  });

  const secret = {
    secret: "cat_live_secret",
    serverUrl: "https://catalyst.example.test",
    credentialName: "CI production"
  };
  type SecretCopyState = ComponentProps<typeof SecretFields>["copyState"];
  const secretFields = (copyState: SecretCopyState) =>
    renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "en",
        children: createElement(SecretFields, {
          secret,
          copyState,
          onCopy: () => undefined,
          onClose: () => undefined
        })
      })
    );

  it("reports a rejected clipboard write instead of marking the field as copied", async () => {
    const rejected = await new Promise<SecretCopyState>((resolve) => {
      copySecretField("key", secret.secret, resolve, () =>
        Promise.reject(new Error("Clipboard access was denied"))
      );
    });
    expect(rejected).toEqual({ failed: true });
    const markup = secretFields(rejected);
    expect(markup).toContain('role="alert"');
    // The browser's own wording is not shown.
    expect(markup).not.toContain("Clipboard access was denied");
    expect(markup).not.toContain("lucide-check");
  });

  it("marks only the copied field after a successful clipboard write", async () => {
    const written: string[] = [];
    const copied = await new Promise<SecretCopyState>((resolve) => {
      copySecretField("key", secret.secret, resolve, async (value) => {
        written.push(value);
      });
    });
    expect(written).toEqual(["cat_live_secret"]);
    expect(copied).toEqual({ copied: "key" });
    const markup = secretFields(copied);
    expect(markup.match(/lucide-check/g)).toHaveLength(1);
    expect(markup).not.toContain('role="alert"');
  });

  // ACCEPT-FIX-11: an account with rights on resources only read "No rights" beside its
  // "Rights on resources 2/3". The line counts the rights on the configuration alone.
  it("says which rights an account lacks, not that it has none at all", () => {
    const resourcesOnly = principal("sp_cli", "Catalyst CLI", []);
    for (const [locale, words, misleading] of [
      ["en", ">No configuration rights<", ">No rights<"],
      ["de", ">Keine Rechte an der Konfiguration<", ">Keine Rechte<"]
    ] as const) {
      const markup = staticPanel({ principals: [resourcesOnly] }, locale);
      expect(markup).toContain(words);
      expect(markup).not.toContain(misleading);
    }
  });
});

// SP-RIGHTS-BUG: a principal created with "View configuration" was stored with the right, but
// the page then showed the first principal of the list it had before the save, which held none.
describe("creating a service principal", () => {
  let root: Root | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  function button(text: string): HTMLButtonElement {
    return required(
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === text
      )
    );
  }

  /** The heading of the principal the page shows on the right. */
  function shownPrincipal(): string | undefined {
    const selected = document.querySelector('button[aria-current="page"]');
    return selected?.querySelector("span span")?.textContent ?? undefined;
  }

  function panel(input: ComponentProps<typeof ApiAccessPanel>) {
    return createElement(
      UiRoot,
      { mode: "light", labels: uiLabelsEn },
      createElement(TranslationProvider, {
        locale: "en",
        children: createElement(ApiAccessPanel, input)
      })
    );
  }

  async function renderPanel(input: ComponentProps<typeof ApiAccessPanel>): Promise<void> {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root?.render(panel(input)));
  }

  /** Opens the create dialog, names the principal and saves, the default right left ticked. */
  async function createNamed(label: string): Promise<void> {
    await act(async () => button("Create service principal").click());
    const name = required(document.querySelector<HTMLInputElement>("dialog input"));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, label);
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save").click());
  }

  it("shows the principal just created, with its rights, before the list is read again", async () => {
    const rightless = principal("sp_first", "A first, no rights", []);
    const created = principal("sp_reader", "Reader", ["config_assets.read"]);
    const sent: unknown[] = [];
    const props = panelProps({
      principals: [rightless],
      onCreatePrincipal: async (input) => {
        sent.push(input);
        return created;
      }
    });
    await renderPanel(props);
    expect(shownPrincipal()).toBe("A first, no rights");

    await createNamed("Reader");
    await waitUntil(() => !document.querySelector("dialog"), "the dialog closes");

    expect(sent).toEqual([
      { displayLabel: "Reader", status: "active", permissions: ["config_assets.read"] }
    ]);
    // The list is not read again yet: it still holds only the principal without rights. The
    // detail names its principal by `name`, which the list does not show.
    const text = () => document.body.textContent ?? "";
    expect(text()).toContain("sp_reader");
    expect(text()).not.toContain("sp_first");
    expect(text()).not.toContain("No configuration rights");

    // Read again, the list holds it, and it stays the one shown.
    await act(async () => root?.render(panel({ ...props, principals: [rightless, created] })));
    expect(shownPrincipal()).toBe("Reader");
    expect(text()).not.toContain("No configuration rights");
  });

  it("says a refused create in its dialog, which stays open with what was entered", async () => {
    const refusal = "This call does not hold 'config_assets.read' on the whole instance";
    await renderPanel(
      panelProps({
        principals: [principal("sp_first", "A first, no rights", [])],
        onCreatePrincipal: async () => {
          throw new Error(refusal);
        }
      })
    );

    await createNamed("Reader");
    await waitUntil(
      () => document.querySelector("dialog")?.textContent?.includes(refusal) ?? false,
      "the dialog says the refusal"
    );
    const dialog = required(document.querySelector("dialog"));
    expect(required(dialog.querySelector<HTMLInputElement>("input")).value).toBe("Reader");
    // Said once, in the dialog, and not on the page behind it.
    expect(document.body.textContent?.split(refusal)).toHaveLength(2);

    // Closed, the dialog takes its refusal with it.
    await act(async () => button("Cancel").click());
    await waitUntil(() => !document.querySelector("dialog"), "the dialog closes");
    expect(document.body.textContent).not.toContain(refusal);
  });
});
