import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import type { ServicePrincipalDetail } from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import { ApiAccessPanel } from "../packages/chat-ui/src/control-plane/api-access-panel";
import {
  copySecretField,
  SecretFields
} from "../packages/chat-ui/src/control-plane/api-access-secret-fields";

const detail: ServicePrincipalDetail = {
  principal: {
    id: "sp_cli",
    clientInstanceId: "client-1",
    displayLabel: "Catalyst CLI",
    description: "Configuration sync",
    status: "active",
    permissionRefs: [],
    permissions: ["config_assets.read", "config_assets.release"],
    createdAt: "2026-07-12T10:00:00Z",
    updatedAt: "2026-07-12T10:00:00Z"
  },
  credentials: [
    {
      id: "cred-1",
      clientInstanceId: "client-1",
      servicePrincipalId: "sp_cli",
      name: "CI production",
      keyPrefix: "cat_live_abc123",
      scopes: ["config_assets:read", "config_assets:release"],
      createdAt: "2026-07-12T10:00:00Z",
      expiresAt: "2027-07-12T10:00:00Z",
      lastUsedAt: "2026-07-13T10:00:00Z"
    }
  ]
};

const noopResult = async () => detail;

describe("API access panel", () => {
  it("renders machine identities and credential metadata in a dedicated view", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(ApiAccessPanel, {
          canMutate: true,
          principals: [detail],
          loading: false,
          mutating: false,
          onCreatePrincipal: noopResult,
          onUpdatePrincipal: noopResult,
          onCreateCredential: async () => ({
            credential: detail.credentials[0]!,
            secret: "never-rendered"
          }),
          onRevokeCredential: async () => detail.credentials[0]!,
          onClearRevealedCredential: () => undefined
        })
      )
    );

    expect(markup).toContain("API access");
    expect(markup).toContain("Machine identities are managed separately from users.");
    expect(markup).toContain("Catalyst CLI");
    expect(markup).toContain("CI production");
    expect(markup).toContain("cat_live_abc123");
    expect(markup).toContain("config_assets:read");
    expect(markup).toContain("Created");
    expect(markup).toContain("Expires");
    expect(markup).toContain("Last used");
    expect(markup).not.toContain("never-rendered");
  });

  it("renders matching German API access copy", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "de" },
        createElement(ApiAccessPanel, {
          canMutate: true,
          principals: [],
          loading: false,
          mutating: false,
          onCreatePrincipal: noopResult,
          onUpdatePrincipal: noopResult,
          onCreateCredential: async () => ({
            credential: detail.credentials[0]!,
            secret: "never-rendered"
          }),
          onRevokeCredential: async () => detail.credentials[0]!,
          onClearRevealedCredential: () => undefined
        })
      )
    );

    expect(markup).toContain("API-Zugang");
    expect(markup).toContain("Noch keine Service Principals");
    expect(markup).not.toContain("never-rendered");
  });

  it("keeps API access inspectable but hides mutation controls from view-only managers", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(ApiAccessPanel, {
          canMutate: false,
          principals: [detail],
          loading: false,
          mutating: false,
          onCreatePrincipal: noopResult,
          onUpdatePrincipal: noopResult,
          onCreateCredential: async () => ({
            credential: detail.credentials[0]!,
            secret: "never-rendered"
          }),
          onRevokeCredential: async () => detail.credentials[0]!,
          onClearRevealedCredential: () => undefined
        })
      )
    );

    expect(markup).toContain("Catalyst CLI");
    expect(markup).toContain("config_assets:release");
    expect(markup).not.toContain("Create service principal");
    expect(markup).not.toContain("Create API key");
    expect(markup).not.toContain(">Edit<");
    expect(markup).not.toContain(">Revoke<");
  });

  it("renders a hook-owned revealed key only while supplied", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(ApiAccessPanel, {
          canMutate: true,
          principals: [detail],
          revealedCredential: {
            secret: "cat_live_once",
            credentialName: "Laptop",
            serverUrl: "https://catalyst.example.com",
            authorityKey: "authority-a"
          },
          loading: false,
          mutating: false,
          onCreatePrincipal: noopResult,
          onUpdatePrincipal: noopResult,
          onCreateCredential: async () => ({
            credential: detail.credentials[0]!,
            secret: "unused"
          }),
          onRevokeCredential: async () => detail.credentials[0]!,
          onClearRevealedCredential: () => undefined
        })
      )
    );

    expect(markup).toContain("https://catalyst.example.com");
    expect(markup).toContain("cat_live_once");
    expect(markup).toContain('data-secret="one-time"');
  });

  type SecretCopyState = ComponentProps<typeof SecretFields>["copyState"];

  const secret = {
    secret: "cat_live_secret",
    serverUrl: "https://catalyst.example.test",
    credentialName: "CI production"
  };

  function renderSecretFields(copyState: SecretCopyState, locale: "en" | "de" = "en"): string {
    return renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(SecretFields, {
          secret,
          copyState,
          onCopy: () => undefined,
          onClose: () => undefined
        })
      )
    );
  }

  it("reports a rejected clipboard write instead of marking the field as copied", async () => {
    const rejected = await new Promise<SecretCopyState>((resolve) => {
      copySecretField("key", secret.secret, resolve, () =>
        Promise.reject(new Error("Clipboard access was denied"))
      );
    });
    expect(rejected).toEqual({ failed: true });

    const markup = renderSecretFields(rejected);
    expect(markup).toMatch(
      /<p role="alert" class="[^"]*text-destructive[^"]*">The value could not be copied\. Select it and copy it by hand\.<\/p>/
    );
    // The browser's own wording is not shown.
    expect(markup).not.toContain("Clipboard access was denied");
    expect(markup).not.toContain("lucide-check");
    expect(renderSecretFields(rejected, "de")).toContain(
      "Der Wert konnte nicht kopiert werden. Markiere ihn und kopiere ihn von Hand."
    );
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

    const markup = renderSecretFields(copied);
    expect(markup.match(/lucide-check/g)).toHaveLength(1);
    expect(markup).not.toContain('role="alert"');
  });

  it("names each copy button in the reader's language and warns in the warning colour", () => {
    const english = renderSecretFields({});
    expect(english).toContain('aria-label="Copy Server URL"');
    expect(english).toContain('aria-label="Copy API key"');
    expect(english).toContain("border-warning/40 bg-warning/10");
    expect(english).not.toContain("amber");

    const german = renderSecretFields({}, "de");
    expect(german).toContain('aria-label="Server-URL kopieren"');
    expect(german).toContain('aria-label="API-Schlüssel kopieren"');
  });
});
