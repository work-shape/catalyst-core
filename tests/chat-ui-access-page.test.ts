import { createElement, type ComponentProps } from "react";
import {
  ApiError,
  createApiClient,
  type AdministeredUser,
  type ConfigAssetSummary,
  type EffectivePermissions,
  type NamespaceWithUsage,
  type PermissionGrantRow
} from "@work-shape/catalyst-api-client";
import {
  accessWriteFailure,
  boundAssets,
  checkAsset,
  checkedAssetId,
  checkState,
  CheckTab,
  emptyGrantForm,
  grantRequests,
  grantScopeKinds,
  grantsNameWorkspaces,
  GrantsTab,
  grantVerbs,
  groupGrants,
  listGrantChoiceAssets,
  namespaceLockedLists,
  namespacePrefixProblem,
  namespaceRequest,
  NamespacesTab,
  withGrantKind
} from "@work-shape/catalyst-chat-ui/access";
import { DocsAddressProvider } from "@work-shape/catalyst-ui";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

const AT = "2026-10-01T10:00:00Z";
const never = async () => undefined;
const nothingAdded = async () => ({ added: 0, existing: 0 });
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
    referencesFailure: undefined,
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
    assets: [],
    assetsFailure: undefined,
    onGrant: nothingAdded,
    onRevoke: never,
    ...props
  });
}

function checkTab(props: Partial<ComponentProps<typeof CheckTab>>) {
  return createElement(CheckTab, {
    kinds: undefined,
    kindAssets: undefined,
    onKindChange: nothing,
    users: [user("user-1", "Kai Example")],
    usersFailed: false,
    assets: [],
    assetsFailure: undefined,
    onRetryAssets: nothing,
    namespaces: [kai],
    modelBindings: [],
    holderId: undefined,
    onHolderChange: nothing,
    effective: undefined,
    effectiveFailure: undefined,
    onRetry: nothing,
    holderGrants: [],
    grantsFailed: false,
    onRetryGrants: nothing,
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

  it("says what a Namespace is above the list, not only when the list is empty", () => {
    expect(render(namespacesTab({ namespaces: [kai] }))).toContain(
      "A Namespace is a name prefix such as kai-."
    );
    expect(render(namespacesTab({ namespaces: [kai] }), "de")).toContain(
      "Ein Namespace ist ein Namenspräfix wie kai-."
    );
  });
});

describe("Grants tab", () => {
  it("says that nothing is granted and offers to grant", () => {
    const markup = render(grantsTab({ grants: [] }));
    expect(markup).toContain("No right given yet.");
    expect(markup).not.toContain('data-testid="grant-row"');
  });

  it("says that the grants could not be loaded and offers another try", () => {
    const markup = render(grantsTab({ loadFailed: true }));
    expect(markup).toContain("The rights could not be loaded.");
    expect(markup).toContain("Try again");
  });

  it("shows a deny whose asset was deleted under the asset's name", () => {
    const markup = render(grantsTab({ grants: [namespaceGrant, orphanedDeny] }));
    expect(markup).toContain("kai-old");
    expect(markup).toContain("Asset no longer exists");
  });

  it("shows the orphan hint as text a touch screen shows, not as a title", () => {
    const markup = render(grantsTab({ grants: [orphanedDeny] }));
    expect(markup).toContain("This deny stays until you remove it.");
    expect(markup).not.toContain("title=");
  });

  it("shows one row per person and place, with the actions as chips", () => {
    const second = { ...namespaceGrant, id: "grant-3", action: "agent.read" };
    const markup = render(grantsTab({ grants: [namespaceGrant, second, orphanedDeny] }));
    expect(markup.split('data-testid="grant-row"')).toHaveLength(3);
    // The verbs come in the page's order, whatever order the rows were written in.
    expect(markup.indexOf("View agents")).toBeLessThan(markup.indexOf("Edit agents"));
    // A deny says so in words and carries its own mark; colour is not the only difference.
    expect(markup).toContain("Denied: View agents");
    expect(markup).toContain('data-effect="deny"');
    expect(markup).toContain('data-effect="allow"');
  });

  it("groups by person and place and by nothing else", () => {
    const other = { ...namespaceGrant, id: "grant-4", holderId: "user-2" };
    const groups = groupGrants([namespaceGrant, orphanedDeny, other], (id) => id);
    expect(groups.map((group) => [group.holderId, group.grants.map((grant) => grant.id)])).toEqual([
      ["user-1", ["grant-2"]],
      ["user-1", ["grant-1"]],
      ["user-2", ["grant-4"]]
    ]);
  });

  it("says of an asset the server leaves unnamed that the reader cannot see it, never its id", () => {
    const unnamed: PermissionGrantRow = {
      ...orphanedDeny,
      scopeAsset: { kind: "agent", active: true }
    };
    const markup = render(grantsTab({ grants: [unnamed] }));
    expect(markup).toContain("An asset you cannot see");
    expect(markup).not.toContain("asset-gone");
    expect(markup).not.toContain("Asset no longer exists");
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

  it("ends its description with one link to how a right is decided, and with none without a docs address", () => {
    const withDocs = (locale: "en" | "de") =>
      render(
        createElement(DocsAddressProvider, {
          address: "https://docs.workshape.ai/catalyst",
          children: checkTab({})
        }),
        locale
      );

    expect(withDocs("en").match(/data-docs-link/gu)).toHaveLength(1);
    expect(withDocs("en")).toMatch(
      /<p class="text-body text-muted-foreground">[^<]+ <a href="https:\/\/docs\.workshape\.ai\/catalyst\/operate\/how-rights-work\/#do-you-hold-the-right-here" target="_blank" rel="noopener noreferrer" aria-label="Learn more about how a right is decided, opens in a new tab"[^>]*>Learn more</u
    );
    expect(withDocs("de")).toMatch(
      /aria-label="Mehr erfahren darüber, wie ein Recht entschieden wird, öffnet in neuem Tab"[^>]*>Mehr erfahren</u
    );
    expect(render(checkTab({}))).not.toContain("data-docs-link");
    expect(render(checkTab({}))).not.toContain("Learn more");
  });
});

describe("when a check gives a result", () => {
  const ready = {
    holderId: "user-1",
    kind: "agent",
    name: "kai-helper",
    effectiveLoaded: true,
    effectiveFailure: undefined,
    grantsLoaded: true,
    grantsFailed: false,
    assetsLoaded: true,
    assetsFailure: undefined
  } as const;

  it("gives one when the person's rights, the grants and the assets are there", () => {
    expect(checkState(ready)).toBe("ready");
  });

  it("gives none while the grants or the assets load, and says which part failed", () => {
    expect(checkState({ ...ready, grantsLoaded: false })).toBe("loading");
    expect(checkState({ ...ready, assetsLoaded: false })).toBe("loading");
    expect(checkState({ ...ready, grantsFailed: true })).toBe("grantsFailed");
    expect(checkState({ ...ready, assetsLoaded: false, assetsFailure: "failed" })).toBe(
      "assetsFailed"
    );
    expect(checkState({ ...ready, assetsLoaded: false, assetsFailure: "forbidden" })).toBe(
      "assetsForbidden"
    );
  });

  it("gives none for a name no asset can have", () => {
    expect(checkState({ ...ready, name: "kai helper" })).toBe("incomplete");
    expect(checkState({ ...ready, kind: "skill", name: "_lives" })).toBe("incomplete");
    // A skill name of the public convention may start with a digit.
    expect(checkState({ ...ready, kind: "skill", name: "9lives" })).toBe("ready");
    expect(checkState({ ...ready, kind: "skill", name: "kai-notes" })).toBe("ready");
    expect(checkState({ ...ready, holderId: undefined })).toBe("incomplete");
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

  it("answers every action the registry names for the kind, using a Connection among them", () => {
    const connectionActions = {
      read: "connection.read",
      use: "connection.use",
      write: "connection.write",
      delete: "connection.delete"
    };
    const user: EffectivePermissions = {
      holderActive: true,
      items: [
        {
          action: "connection.use",
          effect: "allow",
          scopeKind: "asset",
          scopeId: "conn-1",
          source: "grant"
        }
      ]
    };
    const asked = (holder: EffectivePermissions, assetId?: string) =>
      checkAsset(
        holder,
        { kind: "connection", name: "sample-business" },
        assetId,
        connectionActions
      ).map((action) => [action.verb, action.allowed, action.reason]);
    // A right to use a Connection is found, in the order the page lists the actions.
    expect(asked(user, "conn-1")).toEqual([
      ["read", false, "no_grant"],
      ["use", true, "grant"],
      ["write", false, "no_grant"],
      ["delete", false, "no_grant"]
    ]);
    // The row names one Connection: the same name without its id is not covered.
    expect(asked(user)[1]).toEqual(["use", false, "no_grant"]);
    // Asked as an agent would be, the same person has no action called `use` and no right.
    expect(decisions(user, "sample-business", "conn-1")).toEqual([
      ["read", false, "no_grant"],
      ["write", false, "no_grant"],
      ["delete", false, "no_grant"]
    ]);
    // A deny on using does not refuse a delete: only a denied read or write does.
    const admin: EffectivePermissions = {
      holderActive: true,
      items: [
        ...Object.values(connectionActions).map((action) => ({
          action,
          effect: "allow" as const,
          scopeKind: "instance" as const,
          source: "role" as const
        })),
        {
          action: "connection.use",
          effect: "deny",
          scopeKind: "asset",
          scopeId: "conn-1",
          source: "grant"
        }
      ]
    };
    expect(asked(admin, "conn-1")).toEqual([
      ["read", true, "role"],
      ["use", false, "deny"],
      ["write", true, "role"],
      ["delete", true, "role"]
    ]);
  });

  it("offers the kinds of the instance's registry, and an unknown one by the instance's name", () => {
    const registry = [
      {
        kind: "agent",
        plural: "agents",
        lifecycle: "active" as const,
        representation: "config" as const,
        owners: ["instance" as const],
        actions: { read: "agent.read", write: "agent.write", delete: "agent.delete" }
      },
      {
        kind: "connection",
        plural: "connections",
        lifecycle: "active" as const,
        representation: "config" as const,
        owners: ["instance" as const],
        actions: {
          read: "connection.read",
          use: "connection.use",
          write: "connection.write",
          delete: "connection.delete"
        }
      },
      {
        kind: "app",
        plural: "apps",
        lifecycle: "active" as const,
        representation: "config" as const,
        owners: ["instance" as const],
        actions: { read: "app.read", write: "app.write", delete: "app.delete" }
      },
      {
        kind: "report",
        plural: "reports",
        lifecycle: "active" as const,
        representation: "config" as const,
        owners: ["instance" as const],
        actions: { read: "report.read", write: "report.write", delete: "report.delete" }
      }
    ];
    const markup = render(checkTab({ kinds: registry }));
    expect(markup).toContain('<option value="agent" selected="">Agents</option>');
    expect(markup).toContain('<option value="connection">Connections</option>');
    expect(markup).toContain('<option value="app">Apps</option>');
    // A kind only a deployment registers has no word here and keeps the instance's name.
    expect(markup).toContain('<option value="report">reports</option>');
    expect(render(checkTab({ kinds: registry }), "de")).toContain(
      '<option value="app">Apps</option>'
    );
    expect(markup).not.toContain('value="skill"');
    expect(render(checkTab({ kinds: registry }), "de")).toContain(
      '<option value="connection">Verbindungen</option>'
    );
    // Until the instance has answered, the two kinds every instance has are offered.
    const waiting = render(checkTab({}));
    expect(waiting).toContain('<option value="agent" selected="">Agents</option>');
    expect(waiting).toContain('<option value="skill">Skills</option>');
    expect(waiting).not.toContain('value="connection"');
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
    expect(namespaceLockedLists(form, { unit: "agents", count: 0 })).toEqual([]);
    expect(namespaceLockedLists(form, { unit: "agents", count: 2 })).toEqual(["models"]);
  });

  it("warns from the Namespace's own count when the agents could not be read", () => {
    const form = {
      prefix: "kai-",
      displayName: "Kai",
      limitTools: true,
      toolNames: [],
      limitModels: false,
      modelBindingIds: []
    };
    // Read: the agents under the prefix are counted, skills are not.
    expect(boundAssets("kai-", [agent("a", "kai-helper"), agent("b", "other")], kai)).toEqual({
      unit: "agents",
      count: 1
    });
    // Not read (loading, failed, or no right to read): the row's count of assets stands in.
    const fallback = boundAssets("kai-", undefined, kai);
    expect(fallback).toEqual({ unit: "assets", count: 1 });
    expect(namespaceLockedLists(form, fallback)).toEqual(["tools"]);
    // A new prefix has no row to count from, so the page cannot rule agents out.
    expect(namespaceLockedLists(form, boundAssets("kai-", undefined, undefined))).toEqual([
      "tools"
    ]);
  });

  it("writes one row per chosen action", () => {
    const form = {
      holderId: "user-1",
      kind: "agent",
      verbs: ["delete", "read"],
      scopeKind: "asset",
      assetId: "asset-1",
      workspaceId: undefined,
      effect: "allow"
    } as const;
    expect(grantRequests({ ...form, verbs: [...form.verbs] })?.map((row) => row.action)).toEqual([
      "agent.read",
      "agent.delete"
    ]);
    expect(grantRequests({ ...form, verbs: [] })).toBeUndefined();
  });

  it("offers a new right in a workspace or on one asset, and never in a Namespace or a workspace that owns no such asset", () => {
    expect(grantVerbs("connection")).toEqual(["read", "use"]);
    // A Connection is the instance's own, so a workspace would cover nothing. No legacy key
    // carries its rights, so the whole instance is a place too (RIGHTS-1c, D3).
    expect(grantScopeKinds("connection")).toEqual(["asset", "instance"]);
    // A workspace owns agents and skills (WS-OWN-1a), so "In workspace X" comes first.
    for (const kind of ["agent", "skill"] as const) {
      expect(grantVerbs(kind)).toEqual(
        kind === "agent" ? ["read", "write", "publish", "delete"] : ["read", "write", "delete"]
      );
      expect(grantScopeKinds(kind)).toEqual(["workspace", "asset"]);
    }
    // A new right on agents starts at the agents' first place.
    expect(emptyGrantForm).toMatchObject({ kind: "agent", scopeKind: "workspace" });

    // Another kind keeps no asset and no verb it has no grant for, and takes its first place.
    const onConnection = withGrantKind(
      {
        ...emptyGrantForm,
        holderId: "user-1",
        verbs: ["read", "write"],
        scopeKind: "workspace",
        workspaceId: "ws-1",
        assetId: "asset-agent"
      },
      "connection"
    );
    expect(onConnection).toMatchObject({
      kind: "connection",
      verbs: ["read"],
      scopeKind: "asset",
      assetId: undefined
    });
    expect(grantRequests(onConnection)).toBeUndefined();
    expect(
      grantRequests({ ...onConnection, verbs: ["use", "read"], assetId: "asset-crm" })
    ).toEqual([
      {
        holderKind: "user",
        holderId: "user-1",
        action: "connection.read",
        effect: "allow",
        scopeKind: "asset",
        scopeId: "asset-crm"
      },
      {
        holderKind: "user",
        holderId: "user-1",
        action: "connection.use",
        effect: "allow",
        scopeKind: "asset",
        scopeId: "asset-crm"
      }
    ]);
    // No row is asked for where the server writes none: a verb the kind lacks, a workspace
    // for a Connection, the whole instance for agents, whose rights a legacy key carries.
    expect(
      grantRequests({ ...onConnection, verbs: ["write"], assetId: "asset-crm" })
    ).toBeUndefined();
    const inPlace = (kind: "connection" | "agent", scopeKind: "workspace" | "instance") =>
      grantRequests({ ...onConnection, kind, scopeKind, workspaceId: "ws-1" });
    expect(inPlace("connection", "workspace")).toBeUndefined();
    expect(inPlace("agent", "instance")).toBeUndefined();
    // A Connection right for the whole instance is one row there (RIGHTS-1c, D3).
    expect(inPlace("connection", "instance")).toEqual([
      {
        holderKind: "user",
        holderId: "user-1",
        action: "connection.read",
        effect: "allow",
        scopeKind: "instance"
      }
    ]);
    // An agent right in a workspace is one row on that workspace.
    expect(inPlace("agent", "workspace")).toEqual([
      {
        holderKind: "user",
        holderId: "user-1",
        action: "agent.read",
        effect: "allow",
        scopeKind: "workspace",
        scopeId: "ws-1"
      }
    ]);
  });

  it("names a Connection row and a workspace row in words", () => {
    const onConnection: PermissionGrantRow = {
      ...namespaceGrant,
      id: "grant-c1",
      action: "connection.use",
      scopeKind: "asset",
      namespace: undefined,
      scopeId: "asset-crm",
      scopeAsset: { kind: "connection", name: "crm", active: true }
    };
    const inWorkspace: PermissionGrantRow = {
      ...namespaceGrant,
      id: "grant-c2",
      action: "connection.read",
      scopeKind: "workspace",
      namespace: undefined,
      scopeId: "ws-1"
    };
    const named = render(
      grantsTab({
        grants: [onConnection, inWorkspace],
        workspaces: { items: [{ id: "ws-1", name: "Team" }], failed: false }
      })
    );
    expect(named).toContain("Connection crm");
    expect(named).toContain("Use connections");
    expect(named).toContain("Workspace Team");
    expect(named).toContain("View connections");
    // Without the workspaces the row names the workspace by its id.
    const unnamed = render(grantsTab({ grants: [inWorkspace] }));
    expect(unnamed).toContain("A workspace you cannot see");
    expect(unnamed).not.toContain("ws-1");
    // A new agent or skill right names a workspace, so the page loads the workspaces; so it does
    // for a Connection right written on a workspace before NS-0, listed by the workspace's name.
    expect(grantsNameWorkspaces(["connection"], [])).toBe(true);
    expect(grantsNameWorkspaces([], [onConnection, inWorkspace])).toBe(true);
    // An instance-wide row is named in words, never by its scope kind.
    const onInstance: PermissionGrantRow = {
      ...namespaceGrant,
      id: "grant-c3",
      scopeKind: "instance",
      namespace: undefined
    };
    expect(render(grantsTab({ grants: [onInstance] }))).toContain("Whole instance");
    expect(render(grantsTab({ grants: [onInstance] }), "de")).toContain("Ganze Instanz");
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

describe("the assets a right can name", () => {
  it("are listed with titles in the reader's language, as Studio lists them (ACCEPT-FIX-10 C2)", async () => {
    const asked: URL[] = [];
    const client = createApiClient({
      baseUrl: "https://instance.example.test",
      fetchImpl: async (input, init) => {
        asked.push(new URL(new Request(input, init).url));
        return Response.json({ items: [] });
      }
    });
    await listGrantChoiceAssets(client, {
      kind: "agent",
      owners: ["instance", "workspace"],
      workspaceIds: ["cws_team"],
      locale: "de"
    });
    expect(asked).toHaveLength(2);
    for (const url of asked) expect(url.searchParams.get("locale"), url.href).toBe("de");
    expect(asked.map((url) => url.searchParams.get("workspaceId"))).toEqual([null, "cws_team"]);
  });
});
