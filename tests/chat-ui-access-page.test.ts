import { createElement, type ComponentProps } from "react";
import {
  ApiError,
  type AdministeredUser,
  type ConfigAssetSummary,
  type EffectivePermissions,
  type NamespaceWithUsage,
  type PermissionGrantRow
} from "@vivd-catalyst/api-client";
import {
  accessWriteFailure,
  checkAsset,
  checkedAssetId,
  CheckTab,
  grantRequests,
  GrantsTab,
  namespaceLockedLists,
  namespacePrefixProblem,
  namespaceRequest,
  NamespacesTab
} from "@vivd-catalyst/chat-ui/access";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

const AT = "2026-10-01T10:00:00Z";
const never = async () => undefined;
const nothing = () => undefined;

function render(node: ReturnType<typeof createElement>, locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
}

function user(id: string, displayLabel: string): AdministeredUser {
  return {
    id,
    clientInstanceId: "client-1",
    displayLabel,
    roles: ["user"],
    permissionRefs: [],
    permissions: [],
    status: "active",
    createdAt: AT,
    updatedAt: AT,
    identities: []
  };
}

function agent(id: string, name: string): ConfigAssetSummary {
  return { id, kind: "agent", name, revision: 1, updatedAt: AT };
}

const kai: NamespaceWithUsage = {
  prefix: "kai-",
  displayName: "Kai",
  allowedToolNames: null,
  allowedModelBindingIds: [],
  createdAt: AT,
  grantCount: 2,
  assetCount: 1
};

const namespaceGrant: PermissionGrantRow = {
  id: "grant-1",
  holderKind: "user",
  holderId: "user-1",
  action: "agent.write",
  effect: "allow",
  scopeKind: "namespace",
  namespace: "kai-",
  grantedBy: "admin-1",
  createdAt: AT
};

const orphanedDeny: PermissionGrantRow = {
  id: "grant-2",
  holderKind: "user",
  holderId: "user-1",
  action: "agent.read",
  effect: "deny",
  scopeKind: "asset",
  scopeId: "asset-gone",
  scopeAsset: { kind: "agent", name: "kai-old", active: false },
  createdAt: AT
};

function namespacesTab(props: Partial<ComponentProps<typeof NamespacesTab>>) {
  return createElement(NamespacesTab, {
    namespaces: undefined,
    loadFailed: false,
    onRetry: nothing,
    references: undefined,
    referencesFailed: false,
    onCreate: never,
    onUpdate: never,
    onDelete: never,
    ...props
  });
}

function grantsTab(props: Partial<ComponentProps<typeof GrantsTab>>) {
  return createElement(GrantsTab, {
    grants: undefined,
    loadFailed: false,
    onRetry: nothing,
    users: [user("user-1", "Kai Example")],
    usersFailed: false,
    namespaces: [kai],
    assets: [],
    assetsFailed: false,
    onGrant: never,
    onRevoke: never,
    ...props
  });
}

function checkTab(props: Partial<ComponentProps<typeof CheckTab>>) {
  return createElement(CheckTab, {
    users: [user("user-1", "Kai Example")],
    usersFailed: false,
    assets: [],
    holderId: undefined,
    onHolderChange: nothing,
    effective: undefined,
    effectiveFailure: undefined,
    onRetry: nothing,
    holderGrants: [],
    ...props
  });
}

describe("Namespaces tab", () => {
  it("says that no Namespace is registered and offers to register one", () => {
    const markup = render(namespacesTab({ namespaces: [] }));
    expect(markup).toContain("No Namespace yet.");
    expect(markup).toContain("New Namespace");
    expect(markup).not.toContain('data-testid="namespace-row"');
  });

  it("says that the Namespaces could not be loaded and offers another try", () => {
    const markup = render(namespacesTab({ loadFailed: true }));
    expect(markup).toContain("The Namespaces could not be loaded.");
    expect(markup).toContain("Try again");
  });

  it("says in German that the Namespaces could not be loaded", () => {
    expect(render(namespacesTab({ loadFailed: true }), "de")).toContain(
      "Die Namespaces konnten nicht geladen werden."
    );
  });

  it("tells an unrestricted list from a list that allows nothing", () => {
    const markup = render(namespacesTab({ namespaces: [kai] }));
    expect(markup).toContain("No limit");
    expect(markup).toContain("None allowed");
  });
});

describe("Grants tab", () => {
  it("says that nothing is granted and offers to grant", () => {
    const markup = render(grantsTab({ grants: [] }));
    expect(markup).toContain("No grant yet.");
    expect(markup).not.toContain('data-testid="grant-row"');
  });

  it("says that the grants could not be loaded and offers another try", () => {
    const markup = render(grantsTab({ loadFailed: true }));
    expect(markup).toContain("The grants could not be loaded.");
    expect(markup).toContain("Try again");
  });

  it("shows a deny whose asset was deleted under the asset's name", () => {
    const markup = render(grantsTab({ grants: [namespaceGrant, orphanedDeny] }));
    expect(markup).toContain("kai-old");
    expect(markup).toContain("Asset no longer exists");
  });

  it("shows a row whose granter is hidden without an empty cell or an error", () => {
    const markup = render(grantsTab({ grants: [orphanedDeny] }));
    expect(markup).toContain("Not available");
    expect(markup).not.toContain("could not be loaded");
  });
});

describe("Check tab", () => {
  it("asks for a person and an asset before it shows anything", () => {
    const markup = render(checkTab({}));
    expect(markup).toContain("Choose a person and enter an asset name");
    expect(markup).not.toContain('data-testid="check-row"');
  });

  it("says that the people could not be loaded", () => {
    expect(render(checkTab({ users: undefined, usersFailed: true }))).toContain(
      "The users could not be loaded."
    );
  });
});

describe("what a check decides", () => {
  const effective: EffectivePermissions = {
    holderActive: true,
    items: [
      {
        action: "agent.write",
        effect: "allow",
        scopeKind: "namespace",
        namespace: "kai-",
        source: "grant"
      },
      {
        action: "agent.delete",
        effect: "allow",
        scopeKind: "namespace",
        namespace: "kai-",
        source: "grant"
      }
    ]
  };

  function decisions(holder: EffectivePermissions, name: string, assetId?: string) {
    return checkAsset(holder, { kind: "agent", name }, assetId).map((action) => [
      action.verb,
      action.allowed,
      action.reason
    ]);
  }

  it("allows what a Namespace row covers and refuses the rest for want of a grant", () => {
    expect(decisions(effective, "kai-helper")).toEqual([
      ["read", false, "no_grant"],
      ["write", true, "grant"],
      ["delete", true, "grant"]
    ]);
    expect(decisions(effective, "other-helper")).toEqual([
      ["read", false, "no_grant"],
      ["write", false, "no_grant"],
      ["delete", false, "no_grant"]
    ]);
  });

  it("lets a deny on the asset win, and refuse the delete with it", () => {
    const denied: EffectivePermissions = {
      holderActive: true,
      items: [
        ...effective.items,
        {
          action: "agent.write",
          effect: "deny",
          scopeKind: "asset",
          scopeId: "asset-1",
          source: "grant"
        }
      ]
    };
    const actions = checkAsset(denied, { kind: "agent", name: "kai-helper" }, "asset-1");
    expect(actions.map((action) => [action.verb, action.allowed, action.reason])).toEqual([
      ["read", false, "no_grant"],
      ["write", false, "deny"],
      ["delete", false, "deny"]
    ]);
    expect(actions[2]?.deniedThrough).toBe("write");
    // The deny names one asset: its neighbour under the prefix stays allowed.
    expect(decisions(denied, "kai-other", "asset-2")[1]).toEqual(["write", true, "grant"]);
  });

  it("holds nothing for a holder that is not active", () => {
    expect(decisions({ ...effective, holderActive: false }, "kai-helper")).toEqual([
      ["read", false, "holder_inactive"],
      ["write", false, "holder_inactive"],
      ["delete", false, "holder_inactive"]
    ]);
  });

  it("finds the id of a deleted asset through the row that still names it", () => {
    const asset = { kind: "agent", name: "kai-old" } as const;
    expect(checkedAssetId(asset, [], [orphanedDeny])).toBe("asset-gone");
    expect(checkedAssetId(asset, [agent("asset-new", "kai-old")], [orphanedDeny])).toBe(
      "asset-new"
    );
    expect(checkedAssetId(asset, [], [])).toBeUndefined();
  });
});

describe("what the dialogs send", () => {
  it("refuses a prefix that overlaps a registered one, in either direction", () => {
    expect(namespacePrefixProblem("kai-x-", ["kai-"])).toEqual({ kind: "overlap", prefix: "kai-" });
    expect(namespacePrefixProblem("kai-", ["kai-team-"])).toEqual({
      kind: "overlap",
      prefix: "kai-team-"
    });
    expect(namespacePrefixProblem("team-", ["kai-"])).toBeUndefined();
    expect(namespacePrefixProblem("Kai_", [])).toEqual({ kind: "pattern" });
    expect(namespacePrefixProblem("k", [])).toEqual({ kind: "length" });
  });

  it("sends null for a list that is switched off and the empty list for one that allows nothing", () => {
    const form = {
      prefix: "kai-",
      displayName: " Kai ",
      limitTools: false,
      toolNames: ["read_skill"],
      limitModels: true,
      modelBindingIds: []
    };
    expect(namespaceRequest(form)).toEqual({
      prefix: "kai-",
      displayName: "Kai",
      allowedToolNames: null,
      allowedModelBindingIds: []
    });
    expect(namespaceLockedLists(form, 0)).toEqual([]);
    expect(namespaceLockedLists(form, 2)).toEqual(["models"]);
  });

  it("writes one row per chosen action", () => {
    const form = {
      holderId: "user-1",
      kind: "agent",
      verbs: ["delete", "read"],
      scopeKind: "namespace",
      namespace: "kai-",
      assetId: undefined,
      effect: "allow"
    } as const;
    expect(grantRequests({ ...form, verbs: [...form.verbs] })?.map((row) => row.action)).toEqual([
      "agent.read",
      "agent.delete"
    ]);
    expect(grantRequests({ ...form, verbs: [] })).toBeUndefined();
  });

  it("reads a conflict without a reason as a user who is being deleted", () => {
    const refusal = (status: number, code: string, details?: Record<string, string>) =>
      new ApiError(status, "refused", { error: { code, message: "refused", details } });
    expect(accessWriteFailure(refusal(409, "CONFLICT"))).toBe("userBeingDeleted");
    expect(accessWriteFailure(refusal(409, "CONFLICT", { reason: "duplicate_grant" }))).toBe(
      "duplicateGrant"
    );
    expect(accessWriteFailure(refusal(409, "CONFLICT", { reason: "namespace_in_use" }))).toBe(
      "namespaceInUse"
    );
    expect(accessWriteFailure(new Error("offline"))).toBe("other");
  });
});
