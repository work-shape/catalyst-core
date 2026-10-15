import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import type { AssetSummary, PermissionGrantRow } from "@work-shape/catalyst-api-client";
import {
  actionLabel,
  GrantsTab,
  PrincipalRights,
  principalGrantViews
} from "@work-shape/catalyst-chat-ui/access";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import { ACTIONS, PERMISSIONS, PRINCIPAL_GRANTABLE_ACTIONS } from "@work-shape/catalyst-core";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// RIGHTS-WORDS: every rights screen says a right in the one verb table's words and the asset
// by its name, never by an action id, a legacy key, a key scope or an asset id.

const chatUi = join(dirname(fileURLToPath(import.meta.url)), "../packages/chat-ui/src");
const AT = "2026-10-01T10:00:00Z";
const never = async () => undefined;
const locales = ["en", "de"] as const;

/** Every id a right goes by in the code: the actions, the legacy keys and the key scopes. */
const RIGHT_IDS = [...ACTIONS, ...PERMISSIONS, ...PERMISSIONS.map((key) => key.replace(".", ":"))];
const rightId = new RegExp(
  `(?<![\\w.:-])(${RIGHT_IDS.map((id) => id.replace(/\./gu, "\\.")).join("|")})(?![\\w:-]|\\.\\w)`,
  "u"
);

/** The screens the ticket names: Instance > Access, Users, API access, Members, a Connection. */
const RIGHTS_SCREENS = [
  "access/grants-tab.tsx",
  "access/check-tab.tsx",
  "access/principal-rights.tsx",
  "control-plane/api-access-panel.tsx",
  "control-plane/user-permissions-card.tsx",
  "control-plane/user-permission-overview.tsx",
  "settings/pages/access.tsx",
  "settings/pages/api-access.tsx",
  "settings/pages/workspace-members.tsx",
  "build-area/connection-page.tsx"
];

/** The words those screens are made of. */
const RIGHTS_WORDS = [
  "i18n/rights.ts",
  "i18n/access.ts",
  "i18n/api-access.ts",
  "i18n/administration.ts",
  "i18n/collaboration-workspace.ts",
  "i18n/connections.ts",
  "i18n/settings.ts"
];

function source(path: string): string {
  return readFileSync(join(chatUi, path), "utf8");
}

/** The text of every message a translation file holds, per locale. */
function values(path: string): Record<(typeof locales)[number], string[]> {
  const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest);
  const found: Record<(typeof locales)[number], string[]> = { en: [], de: [] };
  const visit = (node: ts.Node, locale: (typeof locales)[number] | undefined) => {
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(file);
      const next = locales.find((candidate) => candidate === name) ?? locale;
      if (locale !== undefined && ts.isStringLiteralLike(node.initializer)) {
        found[locale].push(node.initializer.text);
      }
      ts.forEachChild(node, (child) => visit(child, next));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, locale));
  };
  visit(file, undefined);
  return found;
}

function render(node: ReturnType<typeof createElement>, locale: "en" | "de"): string {
  return renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
}

function grant(id: string, action: string, overrides: Partial<PermissionGrantRow> = {}) {
  return {
    id,
    holderKind: "user",
    holderId: "user-1",
    action,
    effect: "allow",
    scopeKind: "asset",
    scopeId: "asset_crm",
    scopeAsset: { kind: "connection", name: "crm", active: true },
    grantedBy: "user-1",
    createdAt: AT,
    ...overrides
  } satisfies PermissionGrantRow;
}

describe("the words of a right", () => {
  it("name every action of the platform in both languages, and none by its id", () => {
    for (const locale of locales) {
      const { t } = createTranslationContext(locale);
      const unknown = actionLabel("not.an_action", t);
      for (const action of ACTIONS) {
        const label = actionLabel(action, t);
        expect(label, action).not.toBe(unknown);
        expect(label, action).not.toMatch(rightId);
        expect(label.charAt(0), action).toBe(label.charAt(0).toLocaleUpperCase());
      }
      expect(unknown).not.toContain("not.an_action");
    }
  });

  it("say each verb of the table the same way on every kind", () => {
    const de = createTranslationContext("de").t;
    expect(actionLabel("agent.write", de)).toBe("Agenten bearbeiten");
    expect(actionLabel("connection.use", de)).toBe("Verbindungen verwenden");
    expect(actionLabel("workflow.read", de)).toBe("Workflows ansehen");
    expect(actionLabel("app.publish", de)).toBe("Apps veröffentlichen");
    expect(actionLabel("knowledge_base.delete", de)).toBe("Wissensbasen löschen");
    expect(actionLabel("skill.approve", de)).toBe("Skills freigeben");
    const en = createTranslationContext("en").t;
    expect(actionLabel("agent.write", en)).toBe("Edit agents");
    expect(actionLabel("workflow.read", en)).toBe("View workflows");
  });

  it("hold no id of a right in the copy of a rights screen", () => {
    for (const path of RIGHTS_WORDS) {
      for (const locale of locales) {
        expect(values(path)[locale].length, path).toBeGreaterThan(10);
        for (const text of values(path)[locale]) {
          expect(text, `${path} (${locale})`).not.toMatch(rightId);
        }
      }
    }
  });

  it("call a service principal Technisches Konto in German, and the workspace role no Rolle", () => {
    for (const path of [...RIGHTS_WORDS, "i18n/operations.ts"]) {
      for (const text of values(path).de) {
        expect(text, path).not.toMatch(/Principal/u);
      }
    }
    const de = createTranslationContext("de").t;
    expect(de("apiAccessServicePrincipals")).toBe("Technische Konten");
    expect(de("collaborationWorkspaceRoleLabel", { name: "Kai" })).not.toContain("Rolle");
    expect(de("settings.accessLevel")).toBe("Rolle");
  });

  it("are never an id a rights screen puts on the page by itself", () => {
    const rawChild = />\s*\{\s*(?:[\w?]+\.)*(action|permission|scope|scopeId|holderId)\s*\}/u;
    const rawProp =
      /\b(label|title|description)=\{\s*(?:[\w?]+\.)*(action|permission|scope|scopeId)\s*\}/u;
    for (const path of RIGHTS_SCREENS) {
      const text = source(path);
      expect(text, path).not.toMatch(rawChild);
      expect(text, path).not.toMatch(rawProp);
    }
  });
});

describe("a rights screen with a right of every kind", () => {
  it("lists each grant row by its words and its asset's name", () => {
    const rows = [
      ...ACTIONS.map((action, index) => grant(`g${index}`, action)),
      grant("g-hidden", "agent.read", {
        scopeAsset: { kind: "agent", active: true },
        scopeId: "asset_secret_id"
      }),
      grant("g-workspace", "agent.read", { scopeKind: "workspace", scopeId: "ws_secret_id" })
    ];
    for (const locale of locales) {
      const markup = render(
        createElement(GrantsTab, {
          grants: rows,
          loadFailed: false,
          onRetry: () => undefined,
          users: [],
          usersFailed: false,
          assets: [],
          assetsFailure: undefined,
          kindAssets: {
            connection: { items: [{ id: "asset_crm", name: "CRM system" }], failed: false }
          },
          onGrant: async () => ({ added: 0, existing: 0 }),
          onRevoke: never
        }),
        locale
      );
      expect(markup, locale).not.toMatch(rightId);
      expect(markup, locale).not.toContain("asset_secret_id");
      expect(markup, locale).not.toContain("ws_secret_id");
      expect(markup, locale).toContain("CRM system");
    }
  });

  it("lists what a service principal may use by its words", () => {
    const crm: AssetSummary = {
      id: "asset_crm",
      kind: "connection",
      name: "crm",
      title: "CRM",
      scope: { kind: "instance" },
      revision: 1,
      updatedAt: AT
    };
    const rows = principalGrantViews(
      PRINCIPAL_GRANTABLE_ACTIONS.map((action, index) =>
        grant(`p${index}`, action, { holderKind: "service_principal", holderId: "spn_1" })
      ),
      { assets: [crm], workspaces: [], users: [] }
    );
    for (const locale of locales) {
      const markup = render(
        createElement(PrincipalRights, {
          principal: { id: "spn_1", displayLabel: "Monthly check", status: "active" },
          canMutate: true,
          read: { status: "ready", rows },
          kinds: [{ kind: "connection", actions: ["connection.use"] }],
          resources: { items: [crm], failed: false },
          workspaces: [],
          holds: () => undefined,
          onGive: never,
          onRemove: never
        }),
        locale
      );
      expect(markup, locale).not.toMatch(rightId);
    }
  });
});
