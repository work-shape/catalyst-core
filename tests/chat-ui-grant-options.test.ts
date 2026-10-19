import { describe, expect, it } from "vitest";
import type { EffectivePermissions } from "@work-shape/catalyst-api-client";
import { grantOptions } from "@work-shape/catalyst-chat-ui/access";

const assets = {
  app: {
    failed: false,
    items: [
      {
        id: "app-a",
        name: "A",
        resource: { kind: "app", name: "app-a", assetId: "app-a", workspaceId: "w-a" }
      },
      {
        id: "app-b",
        name: "B",
        resource: { kind: "app", name: "app-b", assetId: "app-b", workspaceId: "w-b" }
      }
    ]
  }
};
const workspaces = {
  failed: false,
  items: [
    { id: "w-a", name: "A" },
    { id: "w-b", name: "B" }
  ]
};
const entries = (items: EffectivePermissions["items"]): EffectivePermissions => ({
  holderActive: true,
  items
});
const allow = (
  action: string,
  scopeKind: "asset" | "workspace" | "instance",
  scopeId?: string
): EffectivePermissions["items"][number] => ({
  action,
  effect: "allow",
  scopeKind,
  ...(scopeId === undefined ? {} : { scopeId }),
  source: "grant"
});

describe("the giver's grant choices", () => {
  it("offers nothing before rights load or for an inactive giver", () => {
    expect(grantOptions(undefined, assets, workspaces).kinds).toEqual([]);
    expect(
      grantOptions(
        { holderActive: false, items: [allow("app.write", "instance")] },
        assets,
        workspaces
      ).kinds
    ).toEqual([]);
  });
  it("does not widen an asset right or borrow a verb from another asset", () => {
    const options = grantOptions(
      entries([allow("app.read", "asset", "app-a"), allow("app.write", "asset", "app-b")]),
      assets,
      workspaces
    );
    expect(options.places("app", [])).toEqual(["asset"]);
    expect(options.verbs("app", "asset", "app-a")).toEqual(["read"]);
    expect(options.choices("app", "asset", ["write"]).map((x) => x.id)).toEqual(["app-b"]);
    expect(options.choices("app", "asset", ["read", "write"])).toEqual([]);
  });
  it("offers a workspace right only there and on its owned assets", () => {
    const options = grantOptions(
      entries([allow("app.write", "workspace", "w-a")]),
      assets,
      workspaces
    );
    expect(options.places("app", ["write"])).toEqual(["workspace", "asset"]);
    expect(options.choices("app", "workspace", ["write"]).map((x) => x.id)).toEqual(["w-a"]);
    expect(options.choices("app", "asset", ["write"]).map((x) => x.id)).toEqual(["app-a"]);
  });
  it("a deny removes the containing broad scope, but leaves another workspace available", () => {
    const options = grantOptions(
      entries([
        allow("app.write", "instance"),
        { ...allow("app.write", "asset", "app-a"), effect: "deny" }
      ]),
      assets,
      workspaces
    );
    expect(options.places("app", ["write"])).toEqual(["workspace", "asset"]);
    expect(options.choices("app", "workspace", ["write"]).map((x) => x.id)).toEqual(["w-b"]);
    expect(options.verbs("app", "asset", "app-a")).toEqual([]);
  });
  it("does not assume where a deny belongs when its asset cannot be loaded", () => {
    const options = grantOptions(
      entries([
        allow("app.write", "instance"),
        { ...allow("app.write", "asset", "hidden"), effect: "deny" }
      ]),
      assets,
      workspaces
    );
    expect(options.places("app", ["write"])).toEqual(["asset"]);
  });
  it("does not ignore a scoped deny when only an asset id is visible", () => {
    const hidden = { app: { failed: false, items: [{ id: "a", name: "a" }] } };
    const granted = allow("app.write", "asset", "a");
    expect(grantOptions(entries([granted]), hidden, workspaces).places("app", ["write"])).toEqual([
      "asset"
    ]);
    expect(
      grantOptions(
        entries([
          granted,
          {
            action: "app.write",
            effect: "deny",
            scopeKind: "namespace",
            namespace: "old-",
            source: "grant"
          }
        ]),
        hidden,
        workspaces
      ).places("app", ["write"])
    ).toEqual([]);
  });
  it("keeps historical Namespace rights effective only on matching instance assets", () => {
    const instanceAssets = {
      app: {
        failed: false,
        items: [
          { id: "a", name: "old-app", resource: { kind: "app", name: "old-app", assetId: "a" } }
        ]
      }
    };
    const options = grantOptions(
      entries([
        {
          action: "app.write",
          effect: "allow",
          scopeKind: "namespace",
          namespace: "old-",
          source: "grant"
        }
      ]),
      instanceAssets,
      workspaces
    );
    expect(options.places("app", ["write"])).toEqual(["asset"]);
  });
});

describe("rights held only through membership or availability", () => {
  const workflows = {
    workflow: {
      failed: false,
      items: [
        {
          id: "flow-a",
          name: "A",
          resource: { kind: "workflow", name: "flow-a", assetId: "flow-a" }
        }
      ]
    }
  };
  const member = (
    action: string,
    scopeKind: "asset" | "workspace",
    scopeId: string
  ): EffectivePermissions["items"][number] => ({
    action,
    effect: "allow",
    scopeKind,
    scopeId,
    source: "membership"
  });

  it("are not offered to hand on", () => {
    expect(
      grantOptions(entries([member("workflow.use", "asset", "flow-a")]), workflows, workspaces)
        .kinds
    ).toEqual([]);
    expect(
      grantOptions(entries([member("app.read", "workspace", "w-a")]), assets, workspaces).kinds
    ).toEqual([]);
  });
  it("leave an explicit allow on the same place offered", () => {
    const options = grantOptions(
      entries([
        member("workflow.use", "asset", "flow-a"),
        allow("workflow.use", "asset", "flow-a")
      ]),
      workflows,
      workspaces
    );
    expect(options.verbs("workflow", "asset", "flow-a")).toEqual(["use"]);
  });
  it("never outweigh a deny", () => {
    const options = grantOptions(
      entries([
        member("workflow.use", "asset", "flow-a"),
        allow("workflow.use", "instance"),
        { ...allow("workflow.use", "asset", "flow-a"), effect: "deny" }
      ]),
      workflows,
      workspaces
    );
    expect(options.verbs("workflow", "asset", "flow-a")).toEqual([]);
  });
});
