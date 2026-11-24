import { createElement, type ComponentProps } from "react";
import {
  ApiError,
  createApiClient,
  type AdministeredUser,
  type AssetRightsCheck,
  type ConfigAssetSummary,
  type EffectivePermissions,
  type PermissionGrantRow,
  type Role
} from "@work-shape/catalyst-api-client";
import {
  accessWriteFailure,
  areaRightChoices,
  canAssignRole,
  canEditRole,
  pendingApplyBlock,
  resetBlock,
  RolePage,
  RolesTab,
  roleAreaActions,
  roleAreaOf,
  roleGrantsByArea,
  rolesWithPending,
  roleAssignmentFailure,
  roleWriteFailure,
  ROLE_AREAS,
  withAreaAllows,
  withoutGrant,
  type RoleEditor,
  checkedActions,
  checkedAssetId,
  checkState,
  CheckTab,
  emptyGrantForm,
  furtherGrantKinds,
  GRANT_KINDS,
  grantExtras,
  grantLevels,
  grantRequests,
  grantRowCount,
  grantScopeKinds,
  grantsNameWorkspaces,
  GrantsTab,
  grantVerbs,
  groupGrants,
  listGrantChoiceAssets,
  splitGrantableAction,
  withGrantKind,
  type GrantForm
} from "@work-shape/catalyst-chat-ui/access";
import {
  ACTIONS,
  GRANTABLE_ACTION_SCOPES,
  GRANTABLE_ACTIONS,
  ROLE_DEFAULT_ACTIONS
} from "@work-shape/catalyst-core";
import { decideAssetActions } from "@work-shape/catalyst-server";
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

const workspaceGrant: PermissionGrantRow = {
  id: "grant-1",
  holderKind: "user",
  holderId: "user-1",
  action: "agent.write",
  effect: "allow",
  scopeKind: "workspace",
  scopeId: "ws-kai",
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
    holderId: undefined,
    onHolderChange: nothing,
    name: "",
    onNameChange: nothing,
    check: undefined,
    checkFailure: undefined,
    onRetry: nothing,
    holderGrants: [],
    grantsFailed: false,
    onRetryGrants: nothing,
    ...props
  });
}

describe("Grants tab", () => {
  it("shows a deny whose asset was deleted under the asset's name, an unseen one never by its id", () => {
    expect(render(grantsTab({ grants: [workspaceGrant, orphanedDeny] }))).toContain("kai-old");
    const unnamed: PermissionGrantRow = {
      ...orphanedDeny,
      scopeAsset: { kind: "agent", active: true }
    };
    expect(render(grantsTab({ grants: [unnamed] }))).not.toContain("asset-gone");
  });

  it("names a workspace row by the workspace's name, never by its id (fix: before NS-0)", () => {
    const inWorkspace: PermissionGrantRow = {
      ...workspaceGrant,
      id: "grant-c2",
      action: "connection.read",
      scopeId: "ws-1"
    };
    const named = render(
      grantsTab({
        grants: [inWorkspace],
        workspaces: { items: [{ id: "ws-1", name: "Team" }], failed: false }
      })
    );
    expect(named).toContain("Team");
    expect(render(grantsTab({ grants: [inWorkspace] }))).not.toContain("ws-1");
    expect(grantsNameWorkspaces(["connection"], [])).toBe(true);
    expect(grantsNameWorkspaces([], [inWorkspace])).toBe(true);
  });

  it("names every right in words in both languages, never by its action", () => {
    const rows = GRANTABLE_ACTIONS.map((action, index): PermissionGrantRow => ({
      ...workspaceGrant,
      id: `grant-${index}`,
      action,
      scopeKind: "instance",
      scopeId: undefined
    }));
    for (const locale of ["en", "de"] as const) {
      const markup = render(grantsTab({ grants: rows }), locale);
      const shown = GRANTABLE_ACTIONS.filter((action) => markup.includes(action));
      expect([locale, shown]).toEqual([locale, []]);
    }
  });

  it("counts and groups rows by person and place", () => {
    const sameRow = { ...workspaceGrant, id: "grant-5", action: "agent.read" };
    expect(grantRowCount([workspaceGrant, sameRow, orphanedDeny])).toBe(2);
    expect(grantRowCount(undefined)).toBeUndefined();
    const other = { ...workspaceGrant, id: "grant-4", holderId: "user-2" };
    const groups = groupGrants([workspaceGrant, orphanedDeny, other], (id) => id);
    expect(groups.map((group) => [group.holderId, group.grants.map((grant) => grant.id)])).toEqual([
      ["user-1", ["grant-2"]],
      ["user-1", ["grant-1"]],
      ["user-2", ["grant-4"]]
    ]);
  });
});

describe("when a check gives a result", () => {
  const ready = {
    holderId: "user-1",
    kind: "agent",
    name: "kai-helper",
    checkLoaded: true,
    checkFailure: undefined,
    grantsLoaded: true,
    grantsFailed: false,
    assetsLoaded: true,
    assetsFailure: undefined
  } as const;

  it("gives one only when the answer, the grants and the assets are there, and says which part failed", () => {
    expect(checkState(ready)).toBe("ready");
    expect(checkState({ ...ready, checkLoaded: false })).toBe("loading");
    expect(checkState({ ...ready, checkFailure: "hidden" })).toBe("holderHidden");
    expect(checkState({ ...ready, checkFailure: "failed" })).toBe("checkFailed");
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
    expect(checkState({ ...ready, holderId: undefined })).toBe("incomplete");
  });
});

const AGENT_ACTIONS = { read: "agent.read", write: "agent.write", delete: "agent.delete" };

/** The server's answer on one asset, from a holder's entries, as `permissions.check` gives it. */
function checkOf(
  holder: EffectivePermissions,
  assetId?: string,
  actions: Record<string, string> = AGENT_ACTIONS
): AssetRightsCheck {
  return {
    holderActive: holder.holderActive,
    roles: [],
    actions: decideAssetActions(holder.items, holder.holderActive, actions, {
      ...(assetId === undefined ? {} : { assetId })
    })
  };
}

describe("what a check decides", () => {
  /** Allowed to change and delete one agent, `asset-1`. */
  const effective: EffectivePermissions = {
    holderActive: true,
    items: ["agent.write", "agent.delete"].map((action) => ({
      action,
      effect: "allow" as const,
      scopeKind: "asset" as const,
      scopeId: "asset-1",
      source: "grant" as const
    }))
  };

  function decisions(holder: EffectivePermissions, assetId?: string) {
    return checkedActions(checkOf(holder, assetId)).map((action) => [
      action.verb,
      action.allowed,
      action.reason
    ]);
  }

  it("names an App's audience and a membership as what decided, with the workspaces a use holds in", () => {
    const answers = checkedActions({
      holderActive: true,
      roles: [],
      actions: [
        { verb: "use", action: "app.use", allowed: true, availability: "instance" },
        {
          verb: "read",
          action: "app.read",
          allowed: false,
          reason: "no_grant",
          availability: "self"
        },
        {
          verb: "write",
          action: "app.write",
          allowed: true,
          decidedBy: { source: "membership", effect: "allow", scopeKind: "workspace" },
          onlyInWorkspaces: [{ personal: false, name: "Alpha" }]
        }
      ]
    });
    expect(answers).toEqual([
      { verb: "use", allowed: true, reason: "availability", availability: "instance" },
      { verb: "read", allowed: false, reason: "availability", availability: "self" },
      {
        verb: "write",
        allowed: true,
        reason: "membership",
        entry: { source: "membership", effect: "allow", scopeKind: "workspace" },
        onlyInWorkspaces: [{ personal: false, name: "Alpha" }]
      }
    ]);
  });

  it("allows what a row on the asset covers and refuses the rest for want of a grant", () => {
    expect(decisions(effective, "asset-1")).toEqual([
      ["read", false, "no_grant"],
      ["write", true, "grant"],
      ["delete", true, "grant"]
    ]);
    expect(decisions(effective, "asset-2").map(([, allowed]) => allowed)).toEqual([
      false,
      false,
      false
    ]);
    expect(decisions({ ...effective, holderActive: false }).map(([, , reason]) => reason)).toEqual([
      "holder_inactive",
      "holder_inactive",
      "holder_inactive"
    ]);
  });

  it("lets a deny on the asset win, and refuse the delete with it", () => {
    const denied: EffectivePermissions = {
      holderActive: true,
      items: [
        ...["agent.write", "agent.delete"].map((action) => ({
          action,
          effect: "allow" as const,
          scopeKind: "instance" as const,
          source: "role" as const
        })),
        {
          action: "agent.write",
          effect: "deny",
          scopeKind: "asset",
          scopeId: "asset-1",
          source: "grant"
        }
      ]
    };
    const actions = checkedActions(checkOf(denied, "asset-1"));
    expect(actions.map((action) => [action.verb, action.allowed, action.reason])).toEqual([
      ["read", false, "no_grant"],
      ["write", false, "deny"],
      ["delete", false, "deny"]
    ]);
    expect(actions[2]?.deniedThrough).toBe("write");
    // The deny names one asset: its neighbour stays allowed.
    expect(decisions(denied, "asset-2")[1]).toEqual(["write", true, "role"]);
  });

  it("answers every action the registry names for a Connection; a deny on using refuses no delete", () => {
    const connectionActions = {
      read: "connection.read",
      use: "connection.use",
      write: "connection.write",
      delete: "connection.delete"
    };
    const asked = (holder: EffectivePermissions, assetId?: string) =>
      checkedActions(checkOf(holder, assetId, connectionActions)).map((action) => [
        action.verb,
        action.allowed,
        action.reason
      ]);
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
    expect(asked(user, "conn-1")[1]).toEqual(["use", true, "grant"]);
    // The row names one Connection: the same name without its id is not covered.
    expect(asked(user)[1]).toEqual(["use", false, "no_grant"]);
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

  it("offers the kinds of the instance's registry, and agents and skills until it answers", () => {
    const kind = (name: string) => ({
      kind: name,
      plural: `${name}s`,
      lifecycle: "active" as const,
      representation: "config" as const,
      owners: ["instance" as const],
      actions: { read: `${name}.read`, write: `${name}.write`, delete: `${name}.delete` }
    });
    const markup = render(checkTab({ kinds: [kind("agent"), kind("connection"), kind("report")] }));
    expect(markup).toContain('value="connection"');
    expect(markup).toContain('value="report"');
    expect(markup).not.toContain('value="skill"');
    const waiting = render(checkTab({}));
    expect(waiting).toContain('value="skill"');
    expect(waiting).not.toContain('value="connection"');
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

/** A bundle, Builder or Publisher, is offered as a verb of the kind `workspace`. */
const actionOf = (kind: string, verb: string) => (kind === "workspace" ? verb : `${kind}.${verb}`);

describe("what the Access page offers", () => {
  it("is every kind core writes a grant row for, with every action of it but one's own server's add", () => {
    const kindsOfCore = [
      ...new Set(
        GRANTABLE_ACTIONS.map((action) =>
          action.includes(".") ? action.split(".")[0] : "workspace"
        )
      )
    ];
    expect(GRANT_KINDS).toEqual(kindsOfCore);
    const offered = GRANT_KINDS.flatMap((kind) =>
      grantVerbs(kind).map((verb) => actionOf(kind, verb))
    );
    // Adding one's own MCP server names no Connection: the role editor holds it (PMCP).
    const ofTheDialog = GRANTABLE_ACTIONS.filter((action) => action !== "connection.add_own");
    expect([...offered].sort()).toEqual([...ofTheDialog].sort());
    expect(splitGrantableAction("connection.add_own")).toBeUndefined();
    for (const action of ofTheDialog) {
      const parts = splitGrantableAction(action);
      expect([action, parts && actionOf(parts.kind, parts.verb)]).toEqual([action, action]);
    }
  });

  it("offers a place only where every action of the kind is written", () => {
    for (const kind of GRANT_KINDS) {
      for (const scopeKind of grantScopeKinds(kind)) {
        for (const verb of grantVerbs(kind)) {
          const action = GRANTABLE_ACTIONS.find((candidate) => candidate === actionOf(kind, verb));
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
    // Run data is given on one Workflow only (D4); a Connection is the instance's own (RIGHTS-1c).
    expect(grantScopeKinds("workflow")).toEqual(["asset"]);
    expect(grantScopeKinds("connection")).toEqual(["asset", "instance"]);
    expect(grantScopeKinds("agent")).toEqual(["workspace", "asset"]);
  });

  it("offers a further kind where the instance registers it", () => {
    expect(furtherGrantKinds(undefined)).toEqual([]);
    expect(furtherGrantKinds(["agent", "skill", "app"])).toEqual(["app"]);
    expect(furtherGrantKinds(["agent", "skill", "guardrails"])).toEqual([]);
    expect(furtherGrantKinds(["workflow", "connection", "agent"])).toEqual(
      GRANT_KINDS.filter((kind) => kind === "connection" || kind === "workflow")
    );
  });
});

describe("what the dialogs send", () => {
  const actions = (patch: Partial<GrantForm>) =>
    grantRequests({
      ...emptyGrantForm,
      holderId: "user-1",
      scopeKind: "asset",
      assetId: "asset-1",
      ...patch
    })?.map((row) => `${row.effect} ${row.action}`);

  it("writes one row per action of the chosen level: an allow below it, a deny above it", () => {
    // Using an agent is its lowest level, below View (AGENT-USE-1).
    expect(grantLevels("agent")).toEqual(["use", "read", "write", "publish", "delete"]);
    expect(actions({ level: "write" })).toEqual([
      "allow agent.read",
      "allow agent.use",
      "allow agent.write"
    ]);
    expect(actions({ level: "write", effect: "deny" })).toEqual([
      "deny agent.write",
      "deny agent.publish",
      "deny agent.delete"
    ]);
    expect(actions({ level: undefined })).toBeUndefined();
    // A right that is no level is given on its own, beside a level or without one.
    expect(grantExtras("data_store")).toEqual(["insert", "execute", "records"]);
    expect(
      actions({ kind: "data_store", level: undefined, extras: ["records"], scopeKind: "instance" })
    ).toEqual(["allow data_store.records"]);
  });

  it("gives View on a Workflow or a Connection without Use, which acts with the asset's own rights", () => {
    expect(actions({ kind: "workflow", level: "read" })).toEqual(["allow workflow.read"]);
    expect(actions({ kind: "workflow", level: "use" })).toEqual([
      "allow workflow.read",
      "allow workflow.use"
    ]);
    expect(actions({ kind: "connection", level: "read" })).toEqual(["allow connection.read"]);
    expect(actions({ kind: "connection", level: "write" })).toEqual([
      "allow connection.read",
      "allow connection.use",
      "allow connection.write"
    ]);
    // A deny of Use leaves viewing alone.
    expect(actions({ kind: "connection", level: "use", effect: "deny" })).toEqual([
      "deny connection.use",
      "deny connection.write",
      "deny connection.delete"
    ]);
    // A Knowledge Base is queried, not acted as: Use stays below View.
    expect(grantLevels("knowledge_base")).toEqual(["use", "read", "write", "publish", "delete"]);
  });

  it("keeps on a kind change no asset or level it lacks, and asks no row where the server writes none", () => {
    const onConnection = withGrantKind(
      {
        ...emptyGrantForm,
        holderId: "user-1",
        level: "read",
        scopeKind: "workspace",
        workspaceId: "ws-1",
        assetId: "asset-agent"
      },
      "connection"
    );
    expect(onConnection).toMatchObject({
      kind: "connection",
      level: "read",
      scopeKind: "asset",
      assetId: undefined
    });
    expect(
      withGrantKind({ ...emptyGrantForm, level: "publish" }, "connection").level
    ).toBeUndefined();
    expect(grantRequests(onConnection)).toBeUndefined();
    expect(
      grantRequests({ ...onConnection, level: "publish", assetId: "asset-crm" })
    ).toBeUndefined();
    const inPlace = (kind: "connection" | "agent", scopeKind: "workspace" | "instance") =>
      grantRequests({ ...onConnection, kind, scopeKind, workspaceId: "ws-1" });
    expect(inPlace("connection", "workspace")).toBeUndefined();
    expect(inPlace("agent", "instance")).toBeUndefined();
    expect(inPlace("connection", "instance")).toEqual([
      {
        holderKind: "user",
        holderId: "user-1",
        action: "connection.read",
        effect: "allow",
        scopeKind: "instance"
      }
    ]);
    expect(inPlace("agent", "workspace")).toEqual(
      ["agent.read", "agent.use"].map((action) => ({
        holderKind: "user",
        holderId: "user-1",
        action,
        effect: "allow",
        scopeKind: "workspace",
        scopeId: "ws-1"
      }))
    );
    // A workspace owns the Workflows made in it, so a row in a workspace reaches those (WS-OWN-1b).
    const onWorkflow = withGrantKind({ ...onConnection, level: "use" }, "workflow");
    expect(onWorkflow).toMatchObject({ kind: "workflow", scopeKind: "asset", assetId: undefined });
    expect(
      grantRequests({ ...onWorkflow, scopeKind: "workspace", workspaceId: "ws-1" })?.map(
        (row) => `${row.scopeKind} ${row.action}`
      )
    ).toEqual(["workspace workflow.read", "workspace workflow.use"]);
  });

  it("reads a refused write as what the server refused it for", () => {
    const refusal = (status: number, code: string, details?: Record<string, string>) =>
      new ApiError(status, "refused", { error: { code, message: "refused", details } });
    expect(accessWriteFailure(refusal(409, "CONFLICT"))).toBe("userBeingDeleted");
    expect(accessWriteFailure(refusal(409, "CONFLICT", { reason: "duplicate_grant" }))).toBe(
      "duplicateGrant"
    );
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

// Instance > Access > Roles (AP-5b1): what the role list and a role's page offer, and to whom.

const names = { workspace: () => undefined, asset: () => undefined };

const allow = (action: string) => ({
  action,
  effect: "allow" as const,
  scopeKind: "instance" as const
});

function rights(actions: readonly string[]): EffectivePermissions {
  return {
    holderActive: true,
    items: actions.map((action) => ({ ...allow(action), source: "role" as const, roleId: "x" }))
  };
}

const admin: RoleEditor = { superadmin: false, rights: rights(ROLE_DEFAULT_ACTIONS.admin) };
const adminWithEdit: RoleEditor = {
  superadmin: false,
  rights: rights([...ROLE_DEFAULT_ACTIONS.admin, "roles.edit_built_in"])
};
const root: RoleEditor = { superadmin: true, rights: rights(ROLE_DEFAULT_ACTIONS.superadmin) };

function builtIn(id: "user" | "admin" | "superadmin", extra: Partial<Role> = {}): Role {
  const grants = ROLE_DEFAULT_ACTIONS[id].map(allow);
  return {
    id,
    name: id,
    builtIn: true,
    editable: id !== "superadmin",
    grants,
    defaultGrants: grants,
    equalsDefault: true,
    pendingActions: [],
    ...extra
  };
}

const reviewers: Role = {
  id: "role_reviewers",
  name: "Reviewers",
  description: "Read the audit log",
  builtIn: false,
  editable: true,
  grants: [allow("audit.view"), { action: "usage.view", effect: "deny", scopeKind: "instance" }],
  pendingActions: []
};

const writes = {
  onCreate: async () => reviewers,
  onUpdate: never,
  onDelete: never,
  onReset: never,
  onDecide: never
};

describe("the role model", () => {
  it("puts every action a role can hold in exactly one area of the User screen's grouping", () => {
    const placed = ROLE_AREAS.flatMap((area) => roleAreaActions(area));
    expect([...placed].sort()).toEqual(ACTIONS.filter((a) => a !== "assets.release").sort());
    expect(roleAreaOf("roles.edit_built_in")).toBe("roles");
    expect(roleAreaOf("builder")).toBe("workspace");
    expect(roleAreaOf("agent.use")).toBe("agent");
    expect(roleAreaOf("users.manage")).toBe("users");
    expect(roleAreaOf("users.delete")).toBe("users");
    expect(roleAreaOf("jobs.retry")).toBe("jobs");
    expect(roleAreaOf("audit.view")).toBe("administration");
    expect(ROLE_AREAS.at(-1)).toBe("administration");
  });

  it("groups a role's grants by area and place, the whole instance first", () => {
    const areas = roleGrantsByArea([
      { action: "agent.use", effect: "allow", scopeKind: "workspace", scopeId: "ws-1" },
      allow("agent.read"),
      { action: "agent.use", effect: "allow", scopeKind: "asset", scopeId: "agent-1" }
    ]);
    expect(areas.map((area) => area.area)).toEqual([...ROLE_AREAS]);
    const agents = areas.find((area) => area.area === "agent");
    expect(agents?.places.map((place) => place.place)).toEqual([
      { scopeKind: "instance" },
      { scopeKind: "workspace", scopeId: "ws-1" },
      { scopeKind: "asset", scopeId: "agent-1", scopeAsset: { kind: "agent", active: true } }
    ]);
  });

  it("lets user and admin be edited only with roles.edit_built_in, and superadmin never", () => {
    const user = builtIn("user");
    expect(canEditRole(user, admin)).toBe(false);
    expect(canEditRole(reviewers, admin)).toBe(true);
    expect(canEditRole(user, adminWithEdit)).toBe(true);
    expect(canEditRole(builtIn("admin"), adminWithEdit)).toBe(true);
    expect(canEditRole(builtIn("superadmin"), root)).toBe(false);
    expect(canEditRole(user, root)).toBe(true);
    expect(canEditRole(reviewers, { superadmin: false, rights: rights(["usage.view"]) })).toBe(
      false
    );
  });

  it("offers a right to tick only to who holds it, a superadmin's right only to a superadmin", () => {
    const narrow: RoleEditor = {
      superadmin: false,
      rights: rights(["users.manage", "roles.edit_built_in", "usage.view"])
    };
    const choices = new Map(
      // Service principals are their own area since RIGHTS-1f grants them to a person.
      ["administration", "users", "service_principals"]
        .flatMap((area) => areaRightChoices(area, reviewers.grants, narrow))
        .map((c) => [c.action, c])
    );
    // Held: tickable. Ticked already: may be unticked although not held.
    expect(choices.get("users.manage")).toEqual({ action: "users.manage", checked: false });
    expect(choices.get("audit.view")).toEqual({ action: "audit.view", checked: true });
    expect(choices.get("service_principals.manage")?.lock).toBe("notHeld");
    expect(choices.get("api_access.manage")?.lock).toBe("superadminOnly");
    // Usage is its own area since `usage.view_users` is granted on a workspace (LU-3).
    expect(roleAreaOf("usage.view")).toBe("usage");
    expect(
      areaRightChoices("usage", reviewers.grants, narrow).find((c) => c.action === "usage.view")
        ?.lock
    ).toBe("refusedByRole");
    expect(
      areaRightChoices("administration", [], root).find((c) => c.action === "api_access.manage")
    ).toEqual({ action: "api_access.manage", checked: false });
  });

  it("holds back a reset or an applied release change the server would refuse, and says why", () => {
    // The editor is a `user` too, so holds the add of one's own MCP server (PMCP).
    const narrow: RoleEditor = {
      superadmin: false,
      rights: rights(["users.manage", "roles.edit_built_in", "audit.view", "connection.add_own"])
    };
    const deny = (action: string) => ({ ...allow(action), effect: "deny" as const });
    const narrowed = builtIn("admin", {
      grants: [allow("audit.view"), deny("usage.view")],
      equalsDefault: false
    });
    // A reset gives back every default allow and lifts the deny: it needs what it gives.
    expect(resetBlock(narrowed, narrow)).toMatchObject({ kind: "needsRight" });
    expect(
      resetBlock(builtIn("user", { grants: [deny("usage.view")], equalsDefault: false }), narrow)
    ).toEqual({ kind: "needsRight", action: "usage.view" });
    expect(resetBlock(narrowed, adminWithEdit)).toBeUndefined();
    // Taking away a right only a superadmin hands out is a superadmin's, also by a reset.
    const widened = builtIn("admin", {
      grants: [...ROLE_DEFAULT_ACTIONS.admin.map(allow), allow("api_access.manage")],
      equalsDefault: false
    });
    expect(resetBlock(widened, adminWithEdit)).toEqual({ kind: "superadminOnly" });
    expect(resetBlock(widened, root)).toBeUndefined();
    expect(resetBlock(reviewers, narrow)).toBeUndefined();

    const added = (action: string) => ({ action, change: "added" as const });
    const removed = (action: string) => ({ action, change: "removed" as const });
    expect(pendingApplyBlock(narrowed, added("usage.view"), narrow)).toEqual({
      kind: "needsRight",
      action: "usage.view"
    });
    expect(pendingApplyBlock(narrowed, added("usage.view"), adminWithEdit)).toBeUndefined();
    expect(pendingApplyBlock(narrowed, added("agent_models.manage"), adminWithEdit)).toEqual({
      kind: "superadminOnly"
    });
    expect(pendingApplyBlock(narrowed, added("agent_models.manage"), root)).toBeUndefined();
    // A removal takes only the allow away and leaves a deny: nothing to hold for it.
    expect(pendingApplyBlock(narrowed, removed("audit.view"), narrow)).toBeUndefined();
    expect(pendingApplyBlock(narrowed, removed("usage.view"), narrow)).toBeUndefined();
    expect(pendingApplyBlock(widened, removed("api_access.manage"), adminWithEdit)).toEqual({
      kind: "superadminOnly"
    });
  });

  it("replaces only the area's instance-wide allows, and keeps refusals and places", () => {
    const grants = [
      allow("audit.view"),
      allow("agent.use"),
      { action: "usage.view", effect: "deny" as const, scopeKind: "instance" as const },
      {
        action: "users.manage",
        effect: "allow" as const,
        scopeKind: "workspace" as const,
        scopeId: "ws"
      }
    ];
    expect(withAreaAllows(grants, "administration", ["limits.manage"])).toEqual([
      allow("agent.use"),
      { action: "usage.view", effect: "deny", scopeKind: "instance" },
      { action: "users.manage", effect: "allow", scopeKind: "workspace", scopeId: "ws" },
      allow("limits.manage")
    ]);
    expect(
      withoutGrant(grants, { action: "usage.view", effect: "deny", scopeKind: "instance" })
    ).toEqual([allow("audit.view"), allow("agent.use"), grants[3]]);
  });

  it("reads a role write's refusal", () => {
    const refusal = (status: number, code: string, details?: Record<string, unknown>) =>
      new ApiError(status, "refused", { error: { code, message: "refused", details } });
    expect(roleWriteFailure(refusal(409, "CONFLICT", { reason: "role_name_taken" }))).toEqual({
      kind: "nameTaken"
    });
    expect(roleWriteFailure(refusal(409, "CONFLICT", { reason: "role_in_use" }))).toEqual({
      kind: "inUse"
    });
    expect(
      roleWriteFailure(
        refusal(403, "FORBIDDEN", { action: "roles.edit_built_in", reason: "no_grant" })
      )
    ).toEqual({ kind: "needsRight", action: "roles.edit_built_in" });
    expect(
      roleWriteFailure(refusal(403, "FORBIDDEN", { action: "roles.update", reason: "no_grant" }))
    ).toEqual({ kind: "superadminOnly" });
    expect(roleWriteFailure(new Error("offline"))).toEqual({ kind: "other" });
  });
});

describe("the role list and a role's page", () => {
  const roles = [
    builtIn("user"),
    builtIn("admin", {
      equalsDefault: false,
      pendingActions: [{ action: "usage.view", change: "added" }]
    }),
    builtIn("superadmin"),
    reviewers
  ];
  const list = (editor: RoleEditor) =>
    render(
      createElement(RolesTab, {
        ...writes,
        roles,
        loadFailed: false,
        onRetry: nothing,
        editor,
        selectedRoleId: undefined,
        onSelect: nothing,
        names
      })
    );
  const page = (role: Role, editor: RoleEditor) =>
    render(
      createElement(RolePage, {
        role,
        editor,
        names,
        onBack: nothing,
        onRename: nothing,
        onDelete: nothing,
        onUpdate: never,
        onReset: never,
        onDecide: never
      })
    );

  it("offers a role's menu only where the editor may write it", () => {
    expect(list(admin)).toContain("Actions for Reviewers");
    expect(list(admin)).not.toContain("Actions for User");
    expect(list({ superadmin: false, rights: rights(["usage.view"]) })).not.toContain(
      "Actions for Reviewers"
    );
    expect(rolesWithPending(roles).map((role) => role.id)).toEqual(["admin"]);
  });

  it("offers no reset on a role the editor may not edit", () => {
    expect(page(builtIn("superadmin"), root)).not.toContain("Reset to default");
    expect(page(builtIn("user"), admin)).not.toContain("Reset to default");
    expect(page(builtIn("admin", { equalsDefault: false }), adminWithEdit)).toContain(
      "Reset to default"
    );
  });

  it("holds back Reset and Add where the server would refuse them", () => {
    const html = page(
      builtIn("admin", {
        grants: [...ROLE_DEFAULT_ACTIONS.admin.map(allow), allow("api_access.manage")],
        equalsDefault: false,
        pendingActions: [
          { action: "agent_models.manage", change: "added" },
          { action: "audit.view", change: "removed" }
        ]
      }),
      adminWithEdit
    );
    expect(html).toContain('data-testid="role-reset-blocked"');
    const row = (action: string) =>
      html.split(`data-action="${action}"`)[1]?.split('data-testid="role-pending-action"')[0] ?? "";
    expect(row("agent_models.manage")).toMatch(/<button[^>]*disabled=""/);
    expect(row("audit.view")).not.toContain('disabled=""');
    expect(page(builtIn("admin", { equalsDefault: false }), root)).not.toContain(
      "role-reset-blocked"
    );
  });
});

// P30: an instance admin gives a custom role to a person, on the person's page and on the role's.
describe("who holds a custom role", () => {
  const person = (
    id: string,
    roles: string[],
    extra: Partial<AdministeredUser> = {}
  ): AdministeredUser => ({
    id,
    clientInstanceId: "instance",
    displayLabel: `Person ${id}`,
    email: `${id}@example.test`,
    roles,
    permissionRefs: [],
    permissions: [],
    status: "active",
    identities: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra
  });
  const keys: Role = {
    ...reviewers,
    id: "role_keys",
    name: "Keys",
    grants: [allow("api_access.manage")]
  };

  it("is given by a holder of users.manage, and a role with a Superadmin's right only by one", () => {
    expect(canAssignRole(reviewers, admin)).toBe(true);
    expect(canAssignRole(keys, admin)).toBe(false);
    expect(canAssignRole(keys, root)).toBe(true);
    expect(canAssignRole(builtIn("admin"), root)).toBe(false);
    expect(canAssignRole(reviewers, { superadmin: false, rights: rights([]) })).toBe(false);
  });

  it("reads a refusal to give a role for its sentence", () => {
    const refusal = (details: Record<string, string>) =>
      new ApiError(403, "refused", {
        error: { code: "FORBIDDEN", message: "refused", details }
      });
    expect(
      roleAssignmentFailure(refusal({ action: "users.update", reason: "holder_not_administrable" }))
    ).toEqual({ kind: "self" });
    expect(roleAssignmentFailure(refusal({ action: "users.update", reason: "no_grant" }))).toEqual({
      kind: "superadminOnly"
    });
    expect(roleAssignmentFailure(refusal({ action: "audit.view", reason: "no_grant" }))).toEqual({
      kind: "needsRight",
      action: "audit.view"
    });
  });

  it("lists the people who hold a custom role on its page, each to take it from, and none on a built-in one", () => {
    const people = {
      users: [person("kai", ["user", reviewers.id]), person("lena", ["user"])],
      failed: false,
      onSetRoles: never
    };
    const page = (role: Role, editor: RoleEditor) =>
      render(
        createElement(RolePage, {
          role,
          editor,
          names,
          people,
          onBack: nothing,
          onRename: nothing,
          onDelete: nothing,
          onUpdate: never,
          onReset: never,
          onDecide: never
        }),
        "de"
      );
    const html = page(reviewers, admin);
    expect(html).toContain('data-testid="role-people"');
    expect(html).toContain('data-user="kai"');
    expect(html).not.toContain('data-user="lena"');
    expect(html).toContain("Person hinzufügen");
    expect(page(keys, admin)).not.toContain("Person hinzufügen");
    expect(page(builtIn("admin"), adminWithEdit)).not.toContain('data-testid="role-people"');
  });
});
