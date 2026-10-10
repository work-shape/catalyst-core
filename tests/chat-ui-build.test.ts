import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { LocaleCode } from "@vivd-catalyst/api-client";
import {
  BUILD_LIST_PAGE_SIZE,
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  buildListPage,
  buildLocationOfRoute,
  BuildNavigationProvider,
  buildRouteOfLocation,
  resolveBuildPlace,
  visibleBuildKinds,
  type BuildAsset,
  type BuildAssetKind,
  type BuildData,
  type BuildLocation
} from "@vivd-catalyst/chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

const [agentKind, skillKind] = buildAssetKinds;
if (!agentKind || !skillKind) {
  throw new Error("The platform registry has no agent and skill entry.");
}

function asset(kind: string, name: string, config: Record<string, unknown> = {}): BuildAsset {
  return { kind, name, config: { name, ...config }, isDefault: false, summary: undefined };
}

const agents: BuildAsset[] = [
  {
    ...asset("agent", "workflow_assistant", {
      displayName: { en: "Workflow Assistant", de: "Workflow-Assistent" }
    }),
    isDefault: true,
    summary: {
      kind: "agent",
      name: "workflow_assistant",
      revision: 3,
      updatedAt: "2026-10-08T10:00:00.000Z",
      availability: { mode: "all", personalWorkspaces: true, collaborationWorkspaceIds: [] }
    }
  },
  asset("agent", "tax-steuer_agent", { displayName: "Steuer-Agent" })
];
const skills: BuildAsset[] = [asset("skill", "tax-review", { title: "Tax review" })];

function data(overrides: Partial<BuildData> = {}): BuildData {
  return {
    kinds: [
      { kind: "agent", assets: agents, canCreate: true },
      { kind: "skill", assets: skills, canCreate: true }
    ],
    loading: false,
    error: undefined,
    reload: async () => undefined,
    ...overrides
  };
}

function render(
  location: BuildLocation,
  input: { data?: BuildData; kinds?: readonly BuildAssetKind[]; locale?: LocaleCode } = {}
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: input.locale ?? "en" },
      createElement(
        BuildAssetKindsProvider,
        { value: input.kinds ?? buildAssetKinds },
        createElement(
          BuildNavigationProvider,
          { value: { location, open: () => undefined } },
          createElement(BuildFrame, { data: input.data ?? data() })
        )
      )
    )
  );
}

/** A kind no platform file knows: one entry, no change to the frame. */
const connectionKind: BuildAssetKind = {
  kind: "connection",
  path: "connections",
  label: "settings.apiAccess",
  searchLabel: "build.agentsSearch",
  newLabel: "configNewAgent",
  emptyText: "build.agentsEmpty",
  emptyReadOnlyText: "build.agentsEmptyReadOnly",
  missingText: "build.agentMissing",
  icon: skillKind.icon,
  title: (item) => (typeof item.config.label === "string" ? item.config.label : undefined),
  status: () => "needs reconnect",
  Editor: ({ asset: open }) => createElement("p", null, `connection body of ${open?.name}`)
};

describe("Build frame", () => {
  it("lands on the Agents list, titled by display name with the id beneath", () => {
    const markup = render({});

    expect(markup).toContain('<h1 class="min-w-0 break-words outline-none text-title-lg">Agents');
    expect(markup).toContain(">Workflow Assistant<");
    expect(markup).toContain('<code class="font-mono">workflow_assistant</code> · All workspaces');
    expect(markup).toContain(">Default agent<");
    expect(markup).toContain(">New agent<");
    expect(markup).not.toContain("New skill");
    // Sorted by the name the reader sees: Steuer-Agent stands before Workflow Assistant.
    expect(markup.indexOf("Steuer-Agent")).toBeLessThan(markup.indexOf("Workflow Assistant"));
    expect(markup).not.toMatch(/Version \d/u);
    expect(markup).not.toContain("catalyst CLI");
  });

  it("titles a row in the reader's language", () => {
    const markup = render({ kindPath: "agents" }, { locale: "de" });

    expect(markup).toContain(">Workflow-Assistent<");
    expect(markup).toContain(">Agenten<");
    expect(markup).toContain("Skills");
    expect(markup).not.toContain("Fähigkeiten");
  });

  it("shows the kinds as a rail with counts, and none while a single kind is visible", () => {
    const both = render({ kindPath: "skills" });
    const one = render(
      { kindPath: "agents" },
      { data: data({ kinds: [{ kind: "agent", assets: agents, canCreate: true }] }) }
    );

    expect(both).toContain('aria-label="Kinds in Build"');
    expect(both).toContain('<option value="agents">Agents (2)</option>');
    expect(both).toContain('<option value="skills" selected="">Skills (1)</option>');
    expect(one).not.toContain('aria-label="Kinds in Build"');
  });

  it("shows a planted kind as a third rail item, with its list and its asset page", () => {
    const kinds = [...buildAssetKinds, connectionKind];
    const withConnections = data({
      kinds: [
        ...data().kinds,
        {
          kind: "connection",
          assets: [asset("connection", "crm", { label: "CRM" })],
          canCreate: false
        }
      ]
    });
    const list = render({ kindPath: "connections" }, { kinds, data: withConnections });
    const page = render({ kindPath: "connections", name: "crm" }, { kinds, data: withConnections });

    expect(list).toContain('<option value="connections" selected="">API access (1)</option>');
    expect(list).toContain(">CRM<");
    expect(list).toContain('<code class="font-mono">crm</code> · needs reconnect');
    // Without the right to create, the list has no New button.
    expect(list).not.toContain("New agent");
    expect(page).toContain("connection body of crm");
    // A kind the instance did not answer for has no rail item.
    expect(render({ kindPath: "agents" }, { kinds })).not.toContain("API access");
  });

  it("says in a sentence what an empty list is for, with the one button, or without the right", () => {
    const empty = (canCreate: boolean) =>
      render(
        { kindPath: "skills" },
        {
          data: data({
            kinds: [
              { kind: "agent", assets: agents, canCreate: true },
              { kind: "skill", assets: [], canCreate }
            ]
          })
        }
      );

    expect(empty(true)).toContain("A skill holds instructions");
    expect(empty(true).match(/New skill/gu)).toHaveLength(2);
    expect(empty(false)).toContain("No skills yet.");
    expect(empty(false)).not.toContain("New skill");
  });

  it("names an address that has no asset, and shows the skeleton while the area loads", () => {
    const missing = render({ kindPath: "agents", name: "gone" });
    const loading = render({ kindPath: "agents" }, { data: data({ loading: true }) });

    expect(missing).toContain("There is no agent with the id gone.");
    expect(missing).toContain('aria-label="Back to Agents"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('<option value="agents" selected="">Agents</option>');
  });

  it("says that Build could not be loaded and offers to try again", () => {
    const markup = render(
      { kindPath: "agents" },
      {
        data: data({
          kinds: [{ kind: "agent", assets: [], canCreate: true }],
          error: "Build could not be loaded."
        })
      }
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("No agents yet");
  });
});

describe("Build addresses", () => {
  const kinds = visibleBuildKinds(buildAssetKinds, data().kinds);

  it("opens the kind last visited at /build, else the first one, and marks the address for correction", () => {
    expect(resolveBuildPlace(kinds, {}, undefined)).toMatchObject({
      kind: { entry: agentKind },
      corrected: true
    });
    expect(resolveBuildPlace(kinds, {}, "skills")).toMatchObject({
      kind: { entry: skillKind },
      corrected: true
    });
    expect(resolveBuildPlace(kinds, { kindPath: "nothing", name: "x" }, "gone")).toMatchObject({
      kind: { entry: agentKind },
      name: undefined,
      corrected: true
    });
    expect(resolveBuildPlace(kinds, { kindPath: "skills", name: "tax-review" }, undefined)).toEqual(
      { kind: kinds[1], name: "tax-review", corrected: false }
    );
    expect(resolveBuildPlace([], {}, undefined)).toBeUndefined();
  });

  it("maps a place in Build to its route and back", () => {
    for (const location of [{}, { kindPath: "agents" }, { kindPath: "skills", name: "a.b" }]) {
      expect(buildLocationOfRoute(buildRouteOfLocation(location))).toEqual(location);
    }
    expect(buildLocationOfRoute({ kind: "administration" })).toBeUndefined();
  });
});

describe("Build list", () => {
  const many = Array.from({ length: 1234 }, (_, index) =>
    asset("skill", `ns-skill_${index}`, { title: `Skill ${index}` })
  );
  const page = (query: string, at = 1) =>
    buildListPage({ entry: skillKind, assets: many, locale: "en", query, page: at });

  it("cuts a long list into pages of fifty, in the order of the names", () => {
    const first = page("");

    expect(first.rows).toHaveLength(BUILD_LIST_PAGE_SIZE);
    expect(first.rows.slice(0, 3).map((row) => row.title)).toEqual([
      "Skill 0",
      "Skill 1",
      "Skill 2"
    ]);
    expect(first).toMatchObject({ total: 1234, page: 1, pageCount: 25, from: 1 });
    expect(page("", 25)).toMatchObject({ page: 25, from: 1201 });
    expect(page("", 25).rows).toHaveLength(34);
    // A page past the end, as after a search that left fewer rows, is the last page.
    expect(page("", 99).page).toBe(25);
  });

  it("searches the name and the id, whatever the case, and falls back to the id as title", () => {
    expect(page("skill 123").rows.map((row) => row.asset.name)).toEqual([
      "ns-skill_123",
      "ns-skill_1230",
      "ns-skill_1231",
      "ns-skill_1232",
      "ns-skill_1233"
    ]);
    expect(page("NS-SKILL_77").total).toBe(11);
    expect(page("nothing here")).toMatchObject({ total: 0, from: 0, pageCount: 1 });
    expect(
      buildListPage({
        entry: skillKind,
        assets: [asset("skill", "untitled")],
        locale: "en",
        query: "",
        page: 1
      }).rows[0]?.title
    ).toBe("untitled");
  });
});
