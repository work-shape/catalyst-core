import { createElement } from "react";
import type { PermissionGrantRow } from "@work-shape/catalyst-api-client";
import { actionLabel, GrantsTab } from "@work-shape/catalyst-chat-ui/access";
import { createTranslationContext } from "./support/chat-ui/shared";
import { ACTIONS, PERMISSIONS } from "@work-shape/catalyst-core";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// RIGHTS-WORDS: every rights screen says a right in the one verb table's words and the asset
// by its name, never by an action id, a legacy key, a key scope or an asset id. One verb per
// right, said the same by an agent's refusal and every rights screen: the interface takes
// core's `RIGHT_VERB_WORDS` and keeps no verb dictionary of its own. Core's words are swapped
// here, so a screen that spells a verb itself no longer follows them.

vi.mock("@work-shape/catalyst-core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@work-shape/catalyst-core")>();
  return {
    ...core,
    RIGHT_VERB_WORDS: {
      ...core.RIGHT_VERB_WORDS,
      write: { en: "core-edit", de: "core-bearbeiten" },
      approve: { en: "core-approve", de: "core-freigeben" }
    }
  };
});

const AT = "2026-10-01T10:00:00Z";
const never = async () => undefined;
const locales = ["en", "de"] as const;

/** Every id a right goes by in the code: the actions, the legacy keys and the key scopes. */
const RIGHT_IDS = [...ACTIONS, ...PERMISSIONS, ...PERMISSIONS.map((key) => key.replace(".", ":"))];
const rightId = new RegExp(
  `(?<![\\w.:-])(${RIGHT_IDS.map((id) => id.replace(/\./gu, "\\.")).join("|")})(?![\\w:-]|\\.\\w)`,
  "u"
);

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
      }
      expect(unknown).not.toContain("not.an_action");
    }
  });

  it("are core's words for a right, in both languages", () => {
    const en = createTranslationContext("en").t;
    const de = createTranslationContext("de").t;
    expect(actionLabel("agent.write", en)).toBe("Core-edit agents");
    expect(actionLabel("skill.approve", de)).toBe("Skills core-freigeben");
    // A verb core did not change keeps its words.
    expect(actionLabel("connection.use", de)).toBe("Verbindungen verwenden");
  });

  it("list each grant row by its words and its asset's name, never by an id", () => {
    // One person per right, so each row's sentence says that right alone.
    const rows = [
      ...ACTIONS.map((action, index) =>
        grant(`g${index}`, action, {
          holderId: `user-${index}`,
          scopeKind: "instance",
          scopeId: undefined,
          scopeAsset: undefined
        })
      ),
      grant("g-crm", "connection.use"),
      grant("g-hidden", "agent.read", {
        scopeAsset: { kind: "agent", active: true },
        scopeId: "asset_secret_id"
      }),
      grant("g-workspace", "agent.read", { scopeKind: "workspace", scopeId: "ws_secret_id" })
    ];
    const markup = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "en",
        children: createElement(GrantsTab, {
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
        })
      })
    );
    expect(markup).not.toMatch(rightId);
    expect(markup).not.toContain("asset_secret_id");
    expect(markup).not.toContain("ws_secret_id");
    expect(markup).toContain("CRM system");
  });
});
