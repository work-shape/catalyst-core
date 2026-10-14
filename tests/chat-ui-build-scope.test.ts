import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  buildScopes,
  buildWorkspaceName,
  resolveBuildRights,
  type BuildAssetRow,
  type BuildScope,
  type BuildSource
} from "@vivd-catalyst/chat-ui/build-area";
import { instanceActions, platformContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// Studio's scope: the instance's own assets, or what one Shared Workspace owns (WS-OWN-1a).

const TEAM = "cws_team";
const noop = () => undefined;

function row(name: string, scope: BuildAssetRow["scope"]): BuildAssetRow {
  return {
    id: `asset_${name}`,
    kind: "agent",
    name,
    title: name,
    scope,
    revision: 1,
    updatedAt: "2026-10-08T10:00:00.000Z"
  };
}

function source(input: { permissions: string[]; actions: string[]; scope: BuildScope }) {
  const context = {
    ...platformContext([], instanceActions(input.permissions)),
    workspaces: [
      { id: TEAM, name: "Team", kind: "shared" as const, member: true, actions: input.actions }
    ]
  };
  const rights = resolveBuildRights({ permissions: input.permissions }, context);
  const rows =
    input.scope.kind === "workspace"
      ? [row("team-helper", { kind: "workspace", workspaceId: TEAM })]
      : [row("house-agent", { kind: "instance" })];
  const built: BuildSource = {
    kinds: [{ kind: "agent", canCreate: true, canDelete: true }],
    rights,
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: () => ({
      rows,
      error: undefined,
      hasMore: false,
      loadingMore: false,
      loadMore: noop,
      retry: noop
    }),
    useAsset: () => ({ status: "missing" }),
    exists: async () => true,
    writes: {
      put: async () => ({ revision: 1 }),
      delete: async () => undefined,
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    },
    scope: input.scope,
    chooseScope: noop,
    scoped: (kind) => kind === "agent" || kind === "skill"
  };
  return built;
}

function render(built: BuildSource, locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(
        BuildAssetKindsProvider,
        { value: buildAssetKinds },
        createElement(
          BuildNavigationProvider,
          {
            value: {
              location: { kindPath: "agents" },
              open: () => undefined,
              href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
            }
          },
          createElement(BuildFrame, { source: built })
        )
      )
    )
  );
}

describe("the Studio scope", () => {
  it("offers the instance and each workspace to a reader of both, and names a workspace's row by its chip", () => {
    const inTeam = render(
      source({
        permissions: ["config_assets.read", "config_assets.write"],
        actions: ["agent.read", "agent.write"],
        scope: { kind: "workspace", workspaceId: TEAM }
      })
    );
    expect(inTeam).toContain('aria-label="Scope: Team"');
    expect(inTeam).toContain("team-helper");
    // The row carries its workspace's name as a chip.
    expect(inTeam).toMatch(/team-helper[\s\S]*>Team</u);

    const onInstance = render(
      source({
        permissions: ["config_assets.read", "config_assets.write"],
        actions: ["agent.read"],
        scope: { kind: "instance" }
      }),
      "de"
    );
    expect(onInstance).toContain('aria-label="Geltungsbereich: Instanz"');
    expect(onInstance).toContain("house-agent");
    expect(onInstance).not.toContain(">Team<");
  });

  it("offers no scope choice to a reader of one workspace alone", () => {
    const member = render(
      source({
        permissions: [],
        actions: ["agent.read", "agent.write"],
        scope: { kind: "workspace", workspaceId: TEAM }
      })
    );
    expect(member).not.toContain('aria-label="Scope:');
    expect(member).toContain("team-helper");
  });

  it("offers the reader's Personal Workspace as Personal, and opens Studio to nobody for it alone", () => {
    const OWN = "cws_own";
    const own = {
      id: OWN,
      name: "Kai's workspace",
      kind: "personal" as const,
      member: true,
      actions: ["agent.read", "agent.write"]
    };
    const team = { id: TEAM, name: "Team", kind: "shared" as const, member: true };
    const builder = resolveBuildRights(
      { permissions: [] },
      {
        ...platformContext([], instanceActions([])),
        workspaces: [{ ...team, actions: ["agent.read", "agent.write"] }, own]
      }
    );
    expect(buildScopes(builder)).toEqual([
      { kind: "workspace", workspaceId: TEAM },
      { kind: "workspace", workspaceId: OWN }
    ]);
    expect(buildWorkspaceName(builder, OWN, "Personal")).toBe("Personal");
    expect(buildWorkspaceName(builder, TEAM, "Personal")).toBe("Team");
    // What the agent made in a personal conversation is the reader's to change there.
    expect(builder.may("write", { kind: "agent", workspaceId: OWN })).toBe(true);

    // A reader with rights in the Personal Workspace alone is not shown Studio for it.
    const alone = resolveBuildRights(
      { permissions: [] },
      {
        ...platformContext([], instanceActions([])),
        workspaces: [own]
      }
    );
    expect(alone.readsAny).toBe(false);
    expect(buildScopes(alone)).toEqual([]);
  });
});
