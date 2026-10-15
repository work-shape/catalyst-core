import { createElement, type ComponentProps } from "react";
import {
  ApiError,
  type AdministeredUser,
  type PermissionGrantRow
} from "@work-shape/catalyst-api-client";
import {
  accessWriteFailure,
  emptyGrantForm,
  furtherGrantKinds,
  GRANT_KINDS,
  grantRequests,
  grantScopeKinds,
  GrantsTab,
  grantVerbs,
  splitGrantableAction,
  withGrantKind
} from "@work-shape/catalyst-chat-ui/access";
import { GRANTABLE_ACTION_SCOPES, GRANTABLE_ACTIONS } from "@work-shape/catalyst-core";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Access page offers what core lets it grant: its kinds and verbs are read from core's
// grantable actions, and the rights on a Workflow are among them.

const AT = "2026-10-01T10:00:00Z";

const member: AdministeredUser = {
  id: "user-1",
  clientInstanceId: "client-1",
  displayLabel: "Kai Example",
  roles: ["user"],
  permissionRefs: [],
  permissions: [],
  status: "active",
  createdAt: AT,
  updatedAt: AT,
  identities: []
};

function rowOf(action: string, index: number): PermissionGrantRow {
  return {
    id: `grant-${index}`,
    holderKind: "user",
    holderId: member.id,
    action,
    effect: "allow",
    scopeKind: "namespace",
    namespace: "kai-",
    grantedBy: "admin-1",
    createdAt: AT
  };
}

function rights(props: Partial<ComponentProps<typeof GrantsTab>>, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    createElement(TranslationProvider, {
      locale,
      children: createElement(GrantsTab, {
        grants: undefined,
        loadFailed: false,
        onRetry: () => undefined,
        users: [member],
        usersFailed: false,
        assets: [],
        assetsFailure: undefined,
        onGrant: async () => ({ added: 0, existing: 0 }),
        onRevoke: async () => undefined,
        ...props
      })
    })
  );
}

describe("what the Access page offers", () => {
  it("is every kind core writes a grant row for, with every action of it", () => {
    const kindsOfCore = [...new Set(GRANTABLE_ACTIONS.map((action) => action.split(".")[0]))];
    expect(GRANT_KINDS).toEqual(kindsOfCore);

    const offered = GRANT_KINDS.flatMap((kind) =>
      grantVerbs(kind).map((verb) => `${kind}.${verb}`)
    );
    expect([...offered].sort()).toEqual([...GRANTABLE_ACTIONS].sort());
    for (const action of GRANTABLE_ACTIONS) {
      const parts = splitGrantableAction(action);
      expect([action, parts && `${parts.kind}.${parts.verb}`]).toEqual([action, action]);
    }
  });

  it("offers a place only where every action of the kind is written", () => {
    for (const kind of GRANT_KINDS) {
      for (const scopeKind of grantScopeKinds(kind)) {
        for (const verb of grantVerbs(kind)) {
          const action = GRANTABLE_ACTIONS.find((candidate) => candidate === `${kind}.${verb}`);
          const scopes: readonly string[] = action ? GRANTABLE_ACTION_SCOPES[action] : [];
          expect([kind, verb, scopeKind, scopes.includes(scopeKind)]).toEqual([
            kind,
            verb,
            scopeKind,
            true
          ]);
        }
      }
    }
  });

  it("names every right in words in both languages, never by its action", () => {
    const rows = GRANTABLE_ACTIONS.map(rowOf);
    for (const locale of ["en", "de"] as const) {
      const markup = rights({ grants: rows }, locale);
      const shown = GRANTABLE_ACTIONS.filter((action) => markup.includes(action));
      expect([locale, shown]).toEqual([locale, []]);
    }
  });

  it("offers a further kind where the instance registers it", () => {
    expect(furtherGrantKinds(undefined)).toEqual([]);
    expect(furtherGrantKinds(["agent", "skill", "app"])).toEqual([]);
    expect(furtherGrantKinds(["agent", "skill", "workflow"])).toEqual(["workflow"]);
    expect(furtherGrantKinds(["workflow", "connection", "agent"])).toEqual(
      GRANT_KINDS.filter((kind) => kind === "connection" || kind === "workflow")
    );
  });
});

describe("rights on a Workflow", () => {
  it("are reading, using, writing and publishing, on one Workflow", () => {
    expect(grantVerbs("workflow")).toEqual(["read", "use", "write", "publish"]);
    expect(grantScopeKinds("workflow")).toEqual(["asset"]);
  });

  it("writes one row per ticked right on the chosen Workflow", () => {
    // A workspace is no place of a Workflow: the first place it has is taken.
    const form = withGrantKind(
      {
        ...emptyGrantForm,
        holderId: member.id,
        kind: "connection",
        verbs: ["use", "read"],
        scopeKind: "workspace",
        workspaceId: "ws-1"
      },
      "workflow"
    );
    expect(form).toMatchObject({ kind: "workflow", scopeKind: "asset", assetId: undefined });
    expect(grantRequests(form)).toBeUndefined();
    expect(grantRequests({ ...form, assetId: "asset-wf" })).toEqual(
      ["workflow.read", "workflow.use"].map((action) => ({
        holderKind: "user",
        holderId: member.id,
        action,
        effect: "allow",
        scopeKind: "asset",
        scopeId: "asset-wf"
      }))
    );
    // No workspace owns a Workflow, so no such row is asked for.
    expect(grantRequests({ ...form, scopeKind: "workspace", workspaceId: "ws-1" })).toBeUndefined();
  });

  it("lists a row on one Workflow under the Workflow's name and the rights in their order", () => {
    const onWorkflow = (action: string, index: number): PermissionGrantRow => ({
      ...rowOf(action, index),
      scopeKind: "asset",
      namespace: undefined,
      scopeId: "asset-wf",
      scopeAsset: { kind: "workflow", name: "agent-inventory", active: true }
    });
    const rows = ["workflow.publish", "workflow.use", "workflow.read"].map(onWorkflow);
    const markup = rights({ grants: rows });
    expect(markup).toContain("Workflow agent-inventory");
    const order = ["View workflows", "Use workflows", "Publish workflows"].map((label) =>
      markup.indexOf(`${label}</`)
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));

    const german = rights({ grants: rows }, "de");
    expect(german).toContain("Workflows verwenden");
    expect(german).toContain("Workflows veröffentlichen");
  });
});

describe("a refused right", () => {
  const refusal = (status: number, code: string, details: Record<string, string>) =>
    new ApiError(status, "refused", { error: { code, message: "refused", details } });

  it("is read as what the server refused it for", () => {
    expect(
      accessWriteFailure(refusal(400, "VALIDATION_FAILED", { reason: "action_not_grantable" }))
    ).toBe("rightNotOffered");
    expect(accessWriteFailure(refusal(400, "VALIDATION_FAILED", { reason: "invalid_scope" }))).toBe(
      "assetGone"
    );
    expect(accessWriteFailure(refusal(404, "NOT_FOUND", { reason: "module_off" }))).toBe(
      "moduleOff"
    );
    // Without the right to manage users, and with it for a superadmin's row.
    expect(
      accessWriteFailure(refusal(403, "FORBIDDEN", { action: "users.manage", reason: "no_grant" }))
    ).toBe("missingManageRight");
    expect(
      accessWriteFailure(
        refusal(403, "FORBIDDEN", { action: "permissions.grant", reason: "no_grant" })
      )
    ).toBe("holderIsSuperadmin");
    expect(
      accessWriteFailure(refusal(403, "FORBIDDEN", { action: "auth_scope:user_admin:write" }))
    ).toBe("other");
  });
});
