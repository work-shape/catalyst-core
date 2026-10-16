import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdministeredUser } from "@work-shape/catalyst-api-client";
import { TranslationProvider } from "@work-shape/catalyst-chat-ui";
import { UiRoot, uiLabelsDe } from "@work-shape/catalyst-ui";
import {
  UserAdministrationPanel,
  AuditView,
  formatMomentShort
} from "@work-shape/catalyst-chat-ui/control-plane";

function german(node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(
      UiRoot,
      { mode: "light", labels: uiLabelsDe },
      createElement(TranslationProvider, { locale: "de", children: node })
    )
  );
}

const lastAuthenticatedAt = "2026-10-16T08:00:00Z";
const user: AdministeredUser = {
  id: "user-1",
  clientInstanceId: "client-1",
  displayLabel: "E2E Superadmin",
  roles: ["user", "superadmin"],
  permissionRefs: [],
  permissions: [],
  status: "active",
  createdAt: "2026-10-16T08:00:00Z",
  updatedAt: "2026-10-16T08:00:00Z",
  lastAuthenticatedAt,
  identities: []
};
const unused = async (): Promise<never> => {
  throw new Error("A render must issue no mutation");
};

describe("German Settings copy", () => {
  it("renders Users, creation, search, status, pagination and last activity in German", () => {
    const markup = german(
      createElement(UserAdministrationPanel, {
        users: [user],
        loading: false,
        canManageSuperadminAccess: true,
        mutating: false,
        onCreateUser: unused,
        onUpdateUser: unused,
        onDeleteUser: unused,
        onUpsertIdentity: unused,
        onDeleteIdentity: unused,
        onResetPassword: unused
      })
    );
    for (const text of [
      "Benutzer",
      "Neuer Benutzer",
      "Benutzer suchen",
      "Eingeladen",
      "Nächste Seite",
      "E2E Superadmin"
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toMatch(/<h1[^>]*>Benutzer<\/h1>/u);
    expect(markup).toMatch(/<input[^>]*type="search"[^>]*aria-label="Benutzer suchen"/u);
    expect(markup).toMatch(/<th[^>]*>Zuletzt aktiv<\/th>/u);
    expect(markup).toMatch(/<button[^>]*aria-label="Nächste Seite"/u);
    expect(markup).toContain(formatMomentShort(lastAuthenticatedAt, "de"));
  });

  it("formats a German last-activity date with hours and minutes, without seconds", () => {
    expect(formatMomentShort("2026-10-16T08:00:27Z", "de")).toMatch(
      /^\d{1,2}\.\d{1,2}\.\d{4}, \d{2}:\d{2}$/u
    );
  });

  it("renders Audit and recent activity in German", () => {
    const markup = german(
      createElement(AuditView, {
        auditActivities: [
          {
            correlationId: "activity-1",
            at: "2026-10-16T08:00:00Z",
            label: "Signed in",
            tier: "governance",
            outcome: "success",
            actor: { kind: "user", label: user.displayLabel },
            eventCount: 1,
            repeatCount: 1,
            evidence: []
          }
        ]
      })
    );
    expect(markup).toContain("Audit");
    expect(markup).toContain("Letzte Aktivitäten");
  });
});
