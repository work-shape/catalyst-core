import { createElement } from "react";
import type { HolderRights } from "@work-shape/catalyst-api-client";
import { describe, expect, it } from "vitest";
import { EffectiveRights, effectiveRightAreas } from "@work-shape/catalyst-chat-ui/access";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// AP-5b2: the User screen lists what the server decided, by area, each line with its place
// and its origin. Nothing here decides; the decision is read in access-effective-rights.

const role = {
  source: "role",
  roleId: "role-buchhaltung",
  effect: "allow"
} as const;

function asset(id: string, kind: string, name: string) {
  return { scopeKind: "asset", scopeId: id, scopeAsset: { kind, name, active: true } } as const;
}

const rights: HolderRights = {
  holderActive: true,
  roles: [{ id: "role-buchhaltung", name: "Buchhaltung", builtIn: false }],
  rights: [
    {
      action: "app.use",
      ...asset("app-1", "app", "Rechnungen"),
      allowed: true,
      grantedBy: [{ ...role, ...asset("app-1", "app", "Rechnungen") }]
    },
    {
      action: "app.use",
      ...asset("app-2", "app", "Belege"),
      allowed: false,
      reason: "denied",
      grantedBy: [{ ...role, ...asset("app-2", "app", "Belege") }],
      deniedBy: { source: "grant", effect: "deny", scopeKind: "instance" }
    },
    {
      action: "connection.use",
      ...asset("connection-1", "connection", "DATEV"),
      allowed: true,
      grantedBy: [{ ...role, ...asset("connection-1", "connection", "DATEV") }]
    }
  ]
};

function render(value: HolderRights): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "de" },
      createElement(EffectiveRights, { rights: value })
    )
  );
}

describe("the effective rights of a person", () => {
  it("group by kind in the order of the rights screens, one line per place", () => {
    expect(effectiveRightAreas(rights.rights).map((area) => [area.area, area.rows.length])).toEqual(
      [
        ["connection", 1],
        ["app", 2]
      ]
    );
  });

  it("read in German with the place, the decision and the role they come from", () => {
    const html = render(rights);
    expect(html.match(/Rolle Buchhaltung/g)).toHaveLength(3);
    expect(html).toContain("Rechnungen");
    expect(html).toContain("DATEV");
    expect(html).toContain("Direkt verweigert");
    expect(html).toContain("Die Verweigerung gilt für: Ganze Instanz");
    expect(html.match(/data-allowed="true"/g)).toHaveLength(2);
    expect(html.match(/data-allowed="false"/g)).toHaveLength(1);
    // Never an id or an action id in what a person reads.
    expect(html).not.toMatch(/>[^<]*(role-buchhaltung|app\.use|connection\.use)[^<]*</);
  });

  it("say when the person holds nothing, and when the account is not active", () => {
    const html = render({ holderActive: false, roles: [], rights: [] });
    expect(html).toContain("Dieses Konto ist nicht aktiv");
    expect(html).toContain("Diese Person hat kein Recht.");
  });

  it("name an asset by its title, the App's audience, and the workspaces a use holds in only", () => {
    const html = render({
      holderActive: true,
      roles: [{ id: "role-buchhaltung", name: "Buchhaltung", builtIn: false }],
      rights: [
        {
          action: "agent.write",
          scopeKind: "asset",
          scopeId: "agent-1",
          scopeAsset: {
            kind: "agent",
            name: "ledger_helper",
            title: "Ledger Helper",
            active: true
          },
          allowed: true,
          grantedBy: [{ source: "grant", effect: "allow", scopeKind: "asset", scopeId: "agent-1" }]
        },
        {
          action: "app.use",
          ...asset("app-3", "app", "tagebuch"),
          allowed: false,
          reason: "no_grant",
          availability: "self",
          grantedBy: [{ ...role, ...asset("app-3", "app", "tagebuch") }]
        },
        {
          action: "connection.use",
          ...asset("connection-2", "connection", "crm"),
          allowed: true,
          onlyInWorkspaces: [{ personal: false, name: "Alpha" }, { personal: true }],
          grantedBy: [
            { source: "membership", effect: "allow", ...asset("connection-2", "connection", "crm") }
          ]
        }
      ]
    });
    expect(html).toContain("Agent Ledger Helper");
    expect(html).not.toContain("ledger_helper");
    expect(html).toContain("Nur für eine andere Person verfügbar");
    expect(html).toContain(
      "Gilt nur bei der Arbeit in: Arbeitsbereich Alpha oder Persönlicher Arbeitsbereich"
    );
    expect(html).toContain("Mitgliedschaft");
  });
});
