import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import type { ServicePrincipalDetail } from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import { ApiAccessPanel } from "../packages/chat-ui/src/api-access-panel";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";

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
        { locale: "en" },
        createElement(ApiAccessPanel, {
          canMutate: true,
          principals: [detail],
          loading: false,
          mutating: false,
          onCreatePrincipal: noopResult,
          onUpdatePrincipal: noopResult,
          onCreateCredential: async () => ({ credential: detail.credentials[0]!, secret: "never-rendered" }),
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
        { locale: "de" },
        createElement(ApiAccessPanel, {
          canMutate: true,
          principals: [],
          loading: false,
          mutating: false,
          onCreatePrincipal: noopResult,
          onUpdatePrincipal: noopResult,
          onCreateCredential: async () => ({ credential: detail.credentials[0]!, secret: "never-rendered" }),
          onRevokeCredential: async () => detail.credentials[0]!,
          onClearRevealedCredential: () => undefined
        })
      )
    );

    expect(markup).toContain("API-Zugriff");
    expect(markup).toContain("Noch keine Service Principals");
    expect(markup).not.toContain("never-rendered");
  });

  it("keeps API access inspectable but hides mutation controls from view-only managers", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "en" },
        createElement(ApiAccessPanel, {
          canMutate: false,
          principals: [detail],
          loading: false,
          mutating: false,
          onCreatePrincipal: noopResult,
          onUpdatePrincipal: noopResult,
          onCreateCredential: async () => ({ credential: detail.credentials[0]!, secret: "never-rendered" }),
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
        { locale: "en" },
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
          onCreateCredential: async () => ({ credential: detail.credentials[0]!, secret: "unused" }),
          onRevokeCredential: async () => detail.credentials[0]!,
          onClearRevealedCredential: () => undefined
        })
      )
    );

    expect(markup).toContain("https://catalyst.example.com");
    expect(markup).toContain("cat_live_once");
    expect(markup).toContain('data-secret="one-time"');
  });
});
