import { createElement } from "react";
import {
  ApiError,
  type AssetSummary,
  type EffectivePermissions,
  type PermissionGrantRow,
  type ServicePrincipalDetail
} from "@vivd-catalyst/api-client";
import {
  grantableResources,
  principalGrantFailure,
  PrincipalGrantHeldError,
  principalGrantKinds,
  principalGrantRequest,
  principalGrantViews,
  principalHref,
  principalOfSearch,
  PrincipalRights,
  readerHolds,
  resourceHolders,
  type PrincipalRightsProps
} from "@vivd-catalyst/chat-ui/access";
import { describe, expect, it } from "vitest";
import { platformContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// What a service principal may use, as its page and a Connection's page show it. Every test
// here fails without the change: before it the interface listed no row a principal holds.

const AT = "2026-10-01T10:00:00Z";
const never = async () => undefined;

function row(id: string, overrides: Partial<PermissionGrantRow> = {}): PermissionGrantRow {
  return {
    id,
    holderKind: "service_principal",
    holderId: "spn_1",
    action: "connection.use",
    effect: "allow",
    scopeKind: "asset",
    scopeId: "asset_crm",
    scopeAsset: { kind: "connection", name: "crm", active: true },
    grantedBy: "user_root",
    createdAt: AT,
    ...overrides
  };
}

function connection(name: string, title: string, workspaceId?: string): AssetSummary {
  return {
    id: `asset_${name}`,
    kind: "connection",
    name,
    title,
    scope: workspaceId === undefined ? { kind: "instance" } : { kind: "workspace", workspaceId },
    revision: 1,
    updatedAt: AT
  };
}

const lookups = {
  assets: [connection("crm", "CRM"), connection("erp", "ERP", "ws_1")],
  workspaces: [{ id: "ws_1", name: "Finance" }],
  users: [{ id: "user_root", displayLabel: "Root Admin" }]
};

const principal = { id: "spn_1", displayLabel: "Monthly check", status: "active" as const };
const kinds = [{ kind: "connection", actions: ["connection.use"] }];

function render(props: Partial<PrincipalRightsProps>, locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    createElement(TranslationProvider, {
      locale,
      children: createElement(PrincipalRights, {
        principal,
        canMutate: true,
        read: { status: "ready", rows: [] },
        kinds,
        resources: { items: lookups.assets, failed: false },
        workspaces: lookups.workspaces,
        holds: () => undefined,
        onGive: never,
        onRemove: never,
        ...props
      })
    })
  );
}

describe("the rights a service principal can be given", () => {
  it("are the ones the instance names per kind, and none the interface keeps itself", () => {
    const context = platformContext();
    expect(principalGrantKinds(context)).toEqual([]);
    expect(
      principalGrantKinds({
        kinds: [
          ...context.kinds,
          {
            kind: "connection",
            plural: "connections",
            lifecycle: "active",
            representation: "config",
            owners: ["instance"],
            actions: {
              read: "connection.read",
              use: "connection.use",
              write: "connection.write",
              delete: "connection.delete"
            },
            principalActions: ["connection.use"]
          }
        ]
      })
    ).toEqual(kinds);
    expect(principalGrantKinds(undefined)).toEqual([]);
  });

  it("writes one allowed row on one named resource", () => {
    expect(
      principalGrantRequest({ principalId: "spn_1", action: "connection.use", assetId: "a1" })
    ).toEqual({
      holderKind: "service_principal",
      holderId: "spn_1",
      action: "connection.use",
      effect: "allow",
      scopeKind: "asset",
      scopeId: "a1"
    });
  });

  it("names each refusal of the instance by what it refused", () => {
    const refusal = (status: number, code: string, reason: string) =>
      new ApiError(status, "refused", {
        error: { code, message: "refused", details: { reason } }
      });
    expect(principalGrantFailure(refusal(403, "FORBIDDEN", "holder_not_administrable"))).toBe(
      "notAdministrable"
    );
    expect(
      principalGrantFailure(refusal(422, "VALIDATION_FAILED", "action_not_grantable_to_principal"))
    ).toBe("actionNotGrantable");
    expect(principalGrantFailure(refusal(422, "VALIDATION_FAILED", "invalid_scope"))).toBe(
      "invalidScope"
    );
    expect(
      principalGrantFailure(refusal(422, "VALIDATION_FAILED", "effect_not_grantable_to_principal"))
    ).toBe("effectNotGrantable");
    expect(principalGrantFailure(refusal(409, "CONFLICT", "duplicate_grant"))).toBe("duplicate");
    expect(principalGrantFailure(refusal(404, "NOT_FOUND", "unknown_holder"))).toBe(
      "unknownHolder"
    );
    expect(principalGrantFailure(new PrincipalGrantHeldError())).toBe("held");
    expect(principalGrantFailure(new Error("offline"))).toBe("other");
  });

  it("offers the resources of the kind the principal does not hold the right on", () => {
    const choices = grantableResources(lookups.assets, {
      kind: "connection",
      action: "connection.use",
      held: [row("g1")]
    });
    expect(choices.map((asset) => asset.name)).toEqual(["erp"]);
  });

  it("are the ones the reader holds, as the server's evaluator decides over the reader's entries", () => {
    const [crm, erp] = lookups.assets;
    if (crm === undefined || erp === undefined) throw new Error("two fixture Connections");
    const entry = (
      overrides: Partial<EffectivePermissions["items"][number]>
    ): EffectivePermissions["items"][number] => ({
      action: "connection.use",
      effect: "allow",
      scopeKind: "instance",
      source: "role",
      ...overrides
    });
    // An admin holds the right by role, and a deny on one Connection takes it there.
    const admin: EffectivePermissions = {
      holderActive: true,
      items: [
        entry({}),
        entry({ effect: "deny", scopeKind: "asset", scopeId: crm.id, source: "grant" })
      ]
    };
    expect(readerHolds(admin, "connection.use", crm)).toBe(false);
    expect(readerHolds(admin, "connection.use", erp)).toBe(true);
    expect(readerHolds(admin, "workflow.use", erp)).toBe(false);
    // A right on one Connection holds there and nowhere else.
    const member: EffectivePermissions = {
      holderActive: true,
      items: [entry({ scopeKind: "asset", scopeId: erp.id, source: "grant" })]
    };
    expect(readerHolds(member, "connection.use", erp)).toBe(true);
    expect(readerHolds(member, "connection.use", crm)).toBe(false);
    // An inactive reader holds nothing, and a reader whose entries are not known is not judged.
    expect(readerHolds({ ...admin, holderActive: false }, "connection.use", erp)).toBe(false);
    expect(readerHolds(undefined, "connection.use", erp)).toBeUndefined();
  });
});

describe("the rights of a service principal on its page", () => {
  it("names the resource, whom it belongs to, what is allowed, who gave it and when", () => {
    const views = principalGrantViews(
      [row("g1"), row("g2", { scopeId: "asset_erp", grantedBy: undefined })],
      lookups
    );
    expect(
      views.map(({ title, name, place, grantedBy }) => ({ title, name, place, grantedBy }))
    ).toEqual([
      { title: "CRM", name: "crm", place: { kind: "instance" }, grantedBy: "Root Admin" },
      {
        title: "ERP",
        name: "erp",
        place: { kind: "workspace", name: "Finance" },
        grantedBy: undefined
      }
    ]);

    const markup = render({ read: { status: "ready", rows: views } });
    expect(markup.match(/data-testid="principal-right"/gu)).toHaveLength(2);
    expect(markup).toContain(">CRM<");
    expect(markup).toContain(">Instance<");
    expect(markup).toContain(">Workspace Finance<");
    expect(markup).toContain("May use this Connection");
    expect(markup).toContain("Given by Root Admin on 10/1/2026");
    expect(markup).toContain("Given on 10/1/2026");
    // Each Remove button says which right it removes.
    expect(markup).toContain('aria-label="Remove the right on CRM"');
    expect(markup).toContain('aria-label="Remove the right on ERP"');
    expect(markup).toContain(">Add right<");
  });

  it("says of a deleted resource that the right is to be removed, and of a hidden one that it is hidden", () => {
    const views = principalGrantViews(
      [
        row("g1", {
          scopeId: "asset_gone",
          scopeAsset: { kind: "connection", name: "old", active: false }
        }),
        row("g2", { scopeId: "asset_hidden", scopeAsset: { kind: "connection", active: true } })
      ],
      lookups
    );
    expect(views.map(({ title, gone }) => ({ title, gone }))).toEqual([
      { title: "old", gone: true },
      { title: undefined, gone: false }
    ]);
    const markup = render({ read: { status: "ready", rows: views } });
    expect(markup).toContain(">Deleted<");
    expect(markup).toContain("The resource was deleted. Remove this right.");
    expect(markup).toContain("A resource you cannot see");
  });

  it("says what a right is for when there is none, and offers the first one", () => {
    const markup = render({});
    expect(markup).toContain("A Workflow that runs as it can only call a Connection");
    expect(markup).toContain("Give this service principal a Connection to use");
    const german = render({}, "de");
    expect(german).toContain("Diesem Konto eine Verbindung zum Verwenden geben");
    expect(german).toContain("Was dieses Technische Konto verwenden darf");
    expect(german).not.toContain("Principal");
    expect(german).toContain("Rechte auf Ressourcen");
  });

  it("offers nothing to a reader who does not administer service principals", () => {
    const empty = render({ canMutate: false });
    expect(empty).toContain("This service principal may not use any resource.");
    expect(empty).not.toContain("<button");

    const listed = render({
      canMutate: false,
      read: { status: "ready", rows: principalGrantViews([row("g1")], lookups) }
    });
    expect(listed).toContain(">CRM<");
    expect(listed).not.toContain("<button");
  });

  it("offers no right on an instance that hands none out", () => {
    const markup = render({ kinds: [] });
    expect(markup).toContain("no kind of resource a service principal can be given a right on");
    expect(markup).not.toContain("<button");
  });

  it("says that a disabled principal keeps its rights and can use none", () => {
    const markup = render({
      principal: { ...principal, status: "disabled" },
      read: { status: "ready", rows: principalGrantViews([row("g1")], lookups) }
    });
    expect(markup).toContain("It keeps its rights and can use none of them until it is enabled.");
  });

  it("says that the rights are not shown, or could not be loaded", () => {
    expect(render({ read: { status: "forbidden" } })).toContain(
      "You may not see the rights of service principals."
    );
    const failed = render({ read: { status: "failed", retry: () => undefined } });
    expect(failed).toContain("The rights could not be loaded.");
    expect(failed).toContain(">Try again<");
  });
});

describe("who holds a right on one resource", () => {
  const principals: ServicePrincipalDetail[] = [
    {
      principal: {
        id: "spn_1",
        clientInstanceId: "client-1",
        name: "monthly-check",
        displayLabel: "Monthly check",
        status: "disabled",
        permissionRefs: [],
        permissions: [],
        createdAt: AT,
        updatedAt: AT
      },
      credentials: []
    }
  ];
  const users = [{ id: "user_kai", displayLabel: "Kai", email: "kai@example.test" }];

  it("lists people first and service principals after them, each once, and no deny", () => {
    const holders = resourceHolders(
      [
        row("g1"),
        row("g2", { holderKind: "user", holderId: "user_kai" }),
        row("g3", { holderKind: "user", holderId: "user_kai" }),
        row("g4", { holderKind: "user", holderId: "user_lena", effect: "deny" }),
        row("g5", { holderKind: "user", holderId: "user_kai", action: "connection.read" })
      ],
      { action: "connection.use", users, principals }
    );
    expect(holders).toEqual([
      {
        grantId: "g2",
        kind: "person",
        id: "user_kai",
        name: "Kai",
        detail: "kai@example.test",
        disabled: false
      },
      {
        grantId: "g1",
        kind: "service_principal",
        id: "spn_1",
        name: "Monthly check",
        detail: undefined,
        disabled: true
      }
    ]);
  });

  it("names a principal by its address on the API access page", () => {
    const href = principalHref("/settings/instance/api-access", "spn_1");
    expect(href).toBe("/settings/instance/api-access?principal=spn_1");
    expect(principalOfSearch(new URL(href, "http://x.test").search)).toBe("spn_1");
    expect(principalOfSearch("")).toBeUndefined();
  });
});
