import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ApiError, createApiClient, type LocaleCode } from "@work-shape/catalyst-api-client";
import {
  ASSET_ADDRESS_MAX_LENGTH,
  ASSET_ADDRESS_PATTERN,
  assetAddressFromName
} from "@work-shape/catalyst-core";
import { addressOf, DocsAddressProvider } from "@work-shape/catalyst-ui";
import {
  addressBlocksCreate,
  addressCheckOf,
  approverNamesOf,
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  buildLocationOfRoute,
  BuildNavigationProvider,
  buildRouteOfLocation,
  buildScopes,
  buildWorkspaceName,
  clearBuildStartRequest,
  deleteBlockedReason,
  isEditableKind,
  mayCreateAgents,
  PendingApprovalError,
  readBuildRefusal,
  refusalsOf,
  requestBuildStart,
  resolveBuildPlace,
  resolveBuildRights,
  resolveBuildScope,
  SkillEditor,
  skillConfigToForm,
  visibleBuildKinds,
  type BuildAsset,
  type BuildAssetEditorProps,
  type BuildAssetKind,
  type BuildAssetRead,
  type BuildAssetRow,
  type BuildKind,
  type BuildList,
  type BuildLocation,
  type BuildScope,
  type BuildSource
} from "@work-shape/catalyst-chat-ui/build-area";
import {
  instanceActions,
  legalWorkspace,
  platformContext,
  taxWorkspace,
  type Workspaces
} from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { createAssetWrites } from "./support/chat-ui";
import { createTranslationContext } from "./support/chat-ui/shared";

const [agentKind, skillKind, connectionKind] = buildAssetKinds;
if (
  !agentKind ||
  !skillKind ||
  !connectionKind ||
  !isEditableKind(agentKind) ||
  !isEditableKind(skillKind)
) {
  throw new Error("The platform registry has no agent, skill and connection entry.");
}
/** A kind that only lists, as a module's kind without a page is: Connections without their page. */
const { kind, path, label, searchLabel, emptyText, icon } = connectionKind;
const listedConnections: BuildKind = { kind, path, label, searchLabel, emptyText, icon };

function row(kind: string, name: string, overrides: Partial<BuildAssetRow> = {}): BuildAssetRow {
  return {
    id: `asset_${name}`,
    kind,
    name,
    title: name,
    scope: { kind: "instance" },
    revision: 1,
    updatedAt: "2026-10-08T10:00:00.000Z",
    ...overrides
  };
}

function asset(kind: string, name: string, overrides: Partial<BuildAsset> = {}): BuildAsset {
  return {
    id: `asset_${name}`,
    kind,
    name,
    scope: { kind: "instance" },
    revision: 3,
    config: { name },
    updatedAt: "2026-10-08T10:00:00.000Z",
    ...overrides
  };
}

const agents: BuildAssetRow[] = [
  row("agent", "tax-steuer_agent", { title: "Steuer-Agent" }),
  row("agent", "workflow_assistant", {
    title: "Workflow Assistant",
    description: "Reviews a workflow and plans the next checks.",
    isDefault: true,
    revision: 3
  })
];
const skills: BuildAssetRow[] = [row("skill", "tax-review", { title: "Tax review" })];

const noop = () => undefined;

interface SourceInput {
  /** The rights the session names on the whole instance. */
  permissions?: string[];
  /** The workspaces the reader holds rights in. */
  workspaces?: Workspaces;
  /** The workspace Studio works in, where a new asset is started. */
  inWorkspace?: string;
  /** What a kind's list answers, where it differs from the fixed rows. */
  lists?: Record<string, Partial<BuildList>>;
  /** What the read of one asset answers, by `kind/name`. Any other asset is missing. */
  assets?: Record<string, BuildAssetRead>;
  overrides?: Partial<BuildSource>;
}

/**
 * A source with fixed answers. The rights are resolved as the product resolves them, so a
 * test names who reads and the frame decides what that reader is offered.
 */
function source(input: SourceInput = {}): BuildSource {
  const permissions = input.permissions ?? ["config_assets.read", "config_assets.write"];
  const context = platformContext(input.workspaces, instanceActions(permissions));
  const rights = resolveBuildRights({ permissions }, context);
  const rows: Record<string, BuildAssetRow[]> = { agent: agents, skill: skills };
  return {
    kinds: context.kinds
      .filter((kind) => rights.reads(kind.kind))
      .map((kind) => ({
        kind: kind.kind,
        canCreate: rights.mayCreate(kind.kind, input.inWorkspace),
        canDelete: true
      })),
    rights,
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: (kind) => ({
      rows: rows[kind] ?? [],
      error: undefined,
      hasMore: false,
      loadingMore: false,
      loadMore: noop,
      retry: noop,
      ...input.lists?.[kind]
    }),
    useAsset: (kind, name) => input.assets?.[`${kind}/${name}`] ?? { status: "missing" },
    exists: async () => true,
    checkName: async () => ({ available: true }),
    writes: {
      put: async () => ({ revision: 1 }),
      readFiles: async () => [],
      delete: async () => undefined,
      publish: async () => ({ draftRevision: 1, publishedRevision: 1 }),
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    },
    ...input.overrides
  };
}

function ready(loaded: BuildAsset): BuildAssetRead {
  return { status: "ready", asset: loaded, loadedAt: 1, reload: async () => "loaded" };
}

function render(
  location: BuildLocation,
  input: {
    source?: BuildSource;
    kinds?: readonly BuildKind[];
    locale?: LocaleCode;
    /** Where the instance's documentation is read. Absent as on an instance that names none. */
    docsAddress?: string;
  } = {}
): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        TranslationProvider,
        { children: null, locale: input.locale ?? "en" },
        createElement(
          DocsAddressProvider,
          { address: input.docsAddress, children: null },
          createElement(
            BuildAssetKindsProvider,
            { value: input.kinds ?? buildAssetKinds },
            createElement(
              BuildNavigationProvider,
              {
                value: {
                  location,
                  open: () => undefined,
                  href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
                }
              },
              createElement(BuildFrame, { source: input.source ?? source() })
            )
          )
        )
      )
    )
  );
}

/** A kind no platform file knows: one entry, no change to the frame. */
const plantedKind: BuildAssetKind = {
  kind: "workflow",
  path: "workflows",
  label: "settings.apiAccess",
  searchLabel: "build.agentsSearch",
  newLabel: "configNewAgent",
  titleLabel: "configTitle",
  deleteTitle: "configDeleteSkillTitle",
  deleteDescription: "configDeleteSkillDescription",
  emptyText: "build.agentsEmpty",
  emptyReadOnlyText: "build.agentsEmptyReadOnly",
  missingText: "build.agentMissing",
  icon: skillKind.icon,
  Editor: ({ asset: open }) => createElement("p", null, `workflow body of ${open?.name}`)
};

/**
 * The skill kind with the skill form and without the instance's configuration, which the
 * platform's own entry reads from the Settings context.
 */
const skillPages: BuildAssetKind = {
  ...skillKind,
  Editor: (frame) =>
    createElement(SkillEditor, {
      frame,
      initialForm: skillConfigToForm(frame.asset?.config ?? {}),
      editable: true
    })
};
const pageKinds = [agentKind, skillPages];

describe("Studio frame", () => {
  it("opens the page of a new agent on the list when a page outside Studio started it", () => {
    // The agent's form reads the instance's configuration from Settings: a plain body stands in.
    const kinds = [
      {
        ...agentKind,
        Editor: ({ start }: BuildAssetEditorProps) =>
          createElement("p", null, `new ${start?.title} as ${start?.name}`)
      },
      skillPages
    ];
    const newPage = "new Kai Helper as kai_helper";
    try {
      expect(render({ kindPath: "agents" }, { kinds })).not.toContain(newPage);

      requestBuildStart("agents", { name: "kai_helper", title: "Kai Helper" });
      const markup = render({ kindPath: "agents" }, { kinds });
      expect(markup).toContain(newPage);
      // The dialog was answered where the agent was started: Studio does not ask again.
      expect(markup).not.toContain('<form id="build-create-form"');
      // The start names one kind's list: no other list and no asset's page opens with it.
      expect(render({ kindPath: "skills" }, { kinds })).not.toContain(newPage);
      expect(render({ kindPath: "agents", name: "workflow_assistant" }, { kinds })).not.toContain(
        newPage
      );

      clearBuildStartRequest();
      expect(render({ kindPath: "agents" }, { kinds })).not.toContain(newPage);
    } finally {
      clearBuildStartRequest();
    }
  });

  it("lists agents by title and what they do, never by id, each row a link to its address", () => {
    const markup = render({});

    expect(markup).toContain(">Workflow Assistant<");
    expect(markup).toContain(">Reviews a workflow and plans the next checks.<");
    expect(markup).not.toContain(">workflow_assistant<");
    expect(markup).toMatch(/<a [^>]*href="\/build\/agents\/workflow_assistant"/u);
    // Without a title the row falls back to the id.
    const untitled = source({
      lists: { agent: { rows: [row("agent", "untitled", { title: " " })] } }
    });
    expect(render({ kindPath: "agents" }, { source: untitled })).toContain(">untitled</");
  });

  it("gives a custom skill named like a shipped one the generic icon, never the shipped one", () => {
    const markup = render(
      { kindPath: "skills" },
      {
        source: source({
          lists: {
            skill: {
              rows: [
                row("skill", "pdf", { title: "PDF", attributes: { icon: "pdf" } }),
                row("skill", "platform.pdf", {
                  title: "PDF",
                  attributes: { origin: "release", icon: "pdf" }
                })
              ]
            }
          }
        })
      }
    );
    const rowOf = (name: string) =>
      new RegExp(
        `<li[^>]*>(?:(?!</li>).)*href="/build/skills/${name}"(?:(?!</li>).)*</li>`,
        "u"
      ).exec(markup)?.[0] ?? "";

    expect(rowOf("pdf")).toContain('data-skill-icon="generic"');
    expect(rowOf("pdf")).not.toContain("data-file-type");
    expect(rowOf("platform.pdf")).toContain('data-file-type="pdf"');
  });

  it("shows a planted kind with its list and its asset page, only where the instance answered for it", () => {
    const kinds = [...buildAssetKinds, plantedKind];
    const base = source();
    const withWorkflows = source({
      lists: { workflow: { rows: [row("workflow", "crm", { title: "CRM" })] } },
      assets: { "workflow/crm": ready(asset("workflow", "crm")) },
      overrides: {
        kinds: [...base.kinds, { kind: "workflow", canCreate: false, canDelete: false }]
      }
    });
    const list = render({ kindPath: "workflows" }, { kinds, source: withWorkflows });

    expect(list).toContain(">CRM<");
    // Without the right to create, the list has no New button.
    expect(list).not.toContain("New agent");
    expect(
      render({ kindPath: "workflows", name: "crm" }, { kinds, source: withWorkflows })
    ).toContain("workflow body of crm");
    expect(render({ kindPath: "agents" }, { kinds })).not.toContain("API access");
  });

  it("lists Connections as links with New connection for a creator, and a list-only kind without pages", () => {
    const base = source();
    const withConnections = (rows: BuildAssetRow[]) =>
      source({
        lists: { connection: { rows } },
        overrides: {
          kinds: [...base.kinds, { kind: "connection", canCreate: true, canDelete: true }]
        }
      });
    const rows = [
      row("connection", "crm", {
        title: "CRM",
        attributes: { connectorType: "mcp", origin: "release", enabled: true }
      })
    ];
    const list = render({ kindPath: "connections" }, { source: withConnections(rows) });

    expect(list).toContain(">CRM<");
    expect(list).toContain('href="/build/connections/crm"');
    // "New connection" stands on the tab that manages them, not on the reader's own.
    expect(list).not.toContain(">New connection<");
    // A kind that only lists has no page: its rows are no links and an asset's address shows the list.
    const listedOnly = [agentKind, skillKind, listedConnections];
    expect(
      render({ kindPath: "connections" }, { kinds: listedOnly, source: withConnections(rows) })
    ).not.toContain("<a ");
    expect(
      render(
        { kindPath: "connections", name: "crm" },
        { kinds: listedOnly, source: withConnections(rows) }
      )
    ).toContain('aria-label="Connections"');
    // The instance did not answer for the kind: no rail item.
    expect(render({ kindPath: "agents" })).not.toContain("Connections");
  });

  it("lists other people's own servers apart from the reader's, each only for its owner (PMCP)", () => {
    const base = source();
    const mcp = { connectorType: "mcp", origin: "runtime", enabled: true };
    const rows = [
      row("connection", "crm", { title: "CRM", attributes: mcp }),
      row("connection", "mine-notes", {
        title: "My notes",
        attributes: { ...mcp, ownServer: "reader" }
      }),
      row("connection", "carol-notes", {
        title: "Notes of Carol",
        attributes: { ...mcp, ownServer: "other", ownerLabel: "Carol" }
      })
    ];
    const listOf = (listed: BuildAssetRow[]) =>
      render(
        { kindPath: "connections" },
        {
          source: source({
            lists: { connection: { rows: listed } },
            overrides: {
              kinds: [...base.kinds, { kind: "connection", canCreate: true, canDelete: true }]
            }
          })
        }
      );
    const list = listOf(rows);
    const othersAt = list.indexOf(">Added by others</h2>");
    expect(othersAt).toBeGreaterThan(-1);
    const yours = list.slice(0, othersAt);
    const others = list.slice(othersAt);

    expect(yours).toContain(">CRM<");
    // The reader's own server is a card under "My connections", not a row of this list.
    expect(list).not.toContain(">My notes<");
    expect(yours).not.toContain("Carol");
    expect(others).toContain(">Notes of Carol<");
    expect(others).toContain(">Only for Carol<");
    expect(others).toContain('href="/build/connections/carol-notes"');
    expect(listOf(rows.slice(0, 2))).not.toContain("Added by others");
  });

  it("offers New on an empty list only to a writer", () => {
    const empty = (permissions: string[]) =>
      render(
        { kindPath: "skills" },
        { source: source({ permissions, lists: { skill: { rows: [] } } }) }
      );

    expect(empty(["config_assets.write"])).toContain("New skill");
    expect(empty(["config_assets.read"])).not.toContain("New skill");
  });

  it("shows the not-found state at an address without an asset, with a link to the list and no id", () => {
    const missing = render({ kindPath: "agents", name: "retired_helper" });

    expect(missing).toContain("data-not-found");
    expect(missing).toMatch(/<a[^>]*href="\/build\/agents\/"[^>]*>Back to Agents<\/a>/u);
    expect(missing).not.toContain("retired_helper");
  });

  it("shows a skeleton until rights and a list arrived, and an error with Try again after a failure", () => {
    const busy = [
      render({}, { source: source({ overrides: { kinds: [], loading: true } }) }),
      render({ kindPath: "agents" }, { source: source({ lists: { agent: { rows: undefined } } }) }),
      render(
        { kindPath: "agents", name: "workflow_assistant" },
        { source: source({ assets: { "agent/workflow_assistant": { status: "loading" } } }) }
      )
    ];
    for (const markup of busy) {
      expect(markup).toContain('aria-busy="true"');
      expect(markup).not.toContain("There is nothing to build here yet.");
      expect(markup).not.toContain("No agents yet");
      expect(markup).not.toContain("There is no agent");
    }

    const area = render(
      {},
      { source: source({ overrides: { kinds: [], error: "Studio could not be loaded." } }) }
    );
    const list = render(
      { kindPath: "agents" },
      {
        source: source({
          lists: { agent: { rows: undefined, error: "The list could not be read." } }
        })
      }
    );
    for (const [markup, said] of [
      [area, "Studio could not be loaded."],
      [list, "The list could not be read."]
    ] as const) {
      expect(markup).toContain('role="alert"');
      expect(markup).toContain(said);
      expect(markup).toContain("Try again");
      expect(markup).not.toContain('aria-busy="true"');
    }
    expect(render({}, { source: source({ overrides: { kinds: [] } }) })).toContain(
      "There is nothing to build here yet."
    );
  });

  it("offers a list's next page only while the instance holds more rows", () => {
    const more = render(
      { kindPath: "agents" },
      { source: source({ lists: { agent: { hasMore: true } } }) }
    );

    expect(more).toContain(">Show more<");
    expect(render({ kindPath: "agents" })).not.toContain("Show more");
  });
});

describe("Studio with rights in a workspace", () => {
  const holder = (workspaces: Workspaces, input: SourceInput = {}) =>
    source({ permissions: [], workspaces, inWorkspace: "ws-tax", ...input });

  it("offers a new asset only for a kind the holder may write in the workspace", () => {
    const from = holder([taxWorkspace]);

    expect(render({ kindPath: "agents" }, { source: from })).toContain(">New agent<");
    const skillList = render({ kindPath: "skills" }, { source: from });
    expect(skillList).toContain(">Tax review<");
    expect(skillList).not.toContain("New skill");
    expect(
      render(
        { kindPath: "agents" },
        { source: holder([legalWorkspace], { inWorkspace: "ws-legal" }) }
      )
    ).not.toContain("New agent");
  });

  it("has no rail item for a kind the holder has no right on", () => {
    const agentsOnly = render(
      { kindPath: "skills" },
      { source: holder([{ ...taxWorkspace, actions: ["agent.read"] }]) }
    );

    // The address of the kind without an item lands on the first kind with one.
    expect(agentsOnly).toContain(">Steuer-Agent<");
    expect(agentsOnly).not.toContain("Tax review");
    expect(agentsOnly).not.toContain('<option value="skills"');
  });
});

// Studio's scope: the instance's own assets, or what one Shared Workspace owns (WS-OWN-1a).
describe("the Studio scope picker", () => {
  const TEAM = "cws_team";
  const scoped = (permissions: string[], actions: string[], scope: BuildScope) =>
    render(
      { kindPath: "agents" },
      {
        source: source({
          permissions,
          workspaces: [{ id: TEAM, name: "Team", kind: "shared", member: true, actions }],
          lists: {
            agent: {
              rows:
                scope.kind === "workspace"
                  ? [
                      row("agent", "team-helper", {
                        scope: { kind: "workspace", workspaceId: TEAM }
                      })
                    ]
                  : [row("agent", "house-agent")]
            }
          },
          overrides: {
            scopeOf: (kind) => (kind === "agent" || kind === "skill" ? scope : undefined),
            chooseScope: noop
          }
        })
      }
    );
  const admin = ["config_assets.read", "config_assets.write"];

  it("is offered to a reader of the instance and a workspace, and a workspace's row names it", () => {
    const inTeam = scoped(admin, ["agent.read", "agent.write"], {
      kind: "workspace",
      workspaceId: TEAM
    });
    expect(inTeam).toContain('aria-label="Where: Team"');
    expect(inTeam).toMatch(/team-helper[\s\S]*>Team</u);

    const onInstance = scoped(admin, ["agent.read"], { kind: "instance" });
    expect(onInstance).toContain('aria-label="Where:');
    expect(onInstance).toContain("house-agent");
    expect(onInstance).not.toContain(">Team<");
  });

  it("is not offered to a reader of one workspace alone", () => {
    const member = scoped([], ["agent.read", "agent.write"], {
      kind: "workspace",
      workspaceId: TEAM
    });
    expect(member).not.toContain('aria-label="Where:');
    expect(member).toContain("team-helper");
  });
});

describe("Studio asset page", () => {
  const taxSkill = asset("skill", "tax-review", {
    scope: { kind: "workspace", workspaceId: "ws-tax" },
    config: {
      name: "tax-review",
      title: "Tax review",
      description: "Review a tax file.",
      content: "# Review"
    }
  });
  const page = (from: BuildSource) =>
    render({ kindPath: "skills", name: "tax-review" }, { kinds: pageKinds, source: from });
  const read = { "skill/tax-review": ready(taxSkill) };
  const skillWriter: Workspaces[number] = {
    ...taxWorkspace,
    actions: ["skill.read", "skill.write", "skill.delete"]
  };

  it("opens an asset the reader may not write read-only, with no way to save, naming its owner", () => {
    const markup = page(source({ permissions: [], workspaces: [taxWorkspace], assets: read }));

    expect(markup).toMatch(/data-build-read-only=""[^>]*>.*Belongs to Tax\./u);
    expect(markup).toMatch(/<input[^>]*readOnly=""[^>]*value="Tax review"/u);
    expect(markup).not.toContain('aria-label="Add a file to references/"');
    expect(markup).not.toContain('type="submit"');
    // History and "Copy ID" are offered to everybody who reads the asset.
    expect(markup).toContain('aria-label="More actions"');
  });

  it("opens an asset of a workspace the reader writes for editing", () => {
    const markup = page(source({ permissions: [], workspaces: [skillWriter], assets: read }));

    expect(markup).not.toContain("data-build-read-only");
    expect(markup).toContain('aria-label="Add a file to references/"');
    // Nothing is changed yet, so there is nothing to save.
    expect(markup).not.toContain("Save changes");
  });

  it("offers Copy to edit of a shipped skill, which even an instance writer only reads", () => {
    const shippedSkill = asset("skill", "tax-review", {
      config: { ...taxSkill.config, origin: "release" }
    });
    const markup = page(source({ assets: { "skill/tax-review": ready(shippedSkill) } }));

    expect(markup).toMatch(/<div[^>]*data-build-read-only=""[\s\S]*?Copy to edit<\/button>/u);
  });

  it("reads only an asset outside the workspaces the reader writes, or of the instance without its right", () => {
    const elsewhere = asset("skill", "tax-review", {
      scope: { kind: "workspace", workspaceId: "ws-legal" },
      config: taxSkill.config
    });
    const inLegal = page(
      source({
        permissions: [],
        workspaces: [skillWriter, legalWorkspace],
        assets: { "skill/tax-review": ready(elsewhere) }
      })
    );
    expect(inLegal).toMatch(/data-build-read-only=""[^>]*>.*Belongs to Legal\./u);

    const instanceSkill = asset("skill", "tax-review", { config: taxSkill.config });
    const onInstance = page(
      source({
        permissions: ["config_assets.read"],
        assets: { "skill/tax-review": ready(instanceSkill) }
      })
    );
    expect(onInstance).toContain("data-build-read-only");
  });

  it("links the read-only notice to the documentation in a new tab without an opener, and only with a docs address", () => {
    const from = source({ permissions: [], workspaces: [taxWorkspace], assets: read });
    const linked = render(
      { kindPath: "skills", name: "tax-review" },
      { kinds: pageKinds, source: from, docsAddress: "https://docs.workshape.ai/catalyst/" }
    );

    expect(linked.match(/data-docs-link/gu)).toHaveLength(1);
    expect(linked).toMatch(
      /<a href="https:\/\/docs\.workshape\.ai\/catalyst\/operate\/how-rights-work\/#do-you-hold-the-right-here" target="_blank" rel="noopener noreferrer"/u
    );
    expect(page(from)).not.toContain("data-docs-link");
  });

  it("shows a failed read as the instance said it, with Try again, and a refused read without", () => {
    const sentence = "The skill store is closed for maintenance until 14:00";
    const failed = page(
      source({
        assets: { "skill/tax-review": { status: "failed", message: sentence, retry: noop } }
      })
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(sentence);
    expect(failed).toContain("Try again");
    expect(failed).not.toContain("There is no skill");

    const refused = page(source({ assets: { "skill/tax-review": { status: "refused" } } }));
    expect(refused).toContain("You may not read this asset.");
    expect(refused).not.toContain("Try again");
    expect(refused).toContain('aria-label="Back to Skills"');
  });
});

describe("Studio addresses", () => {
  const kinds = visibleBuildKinds(buildAssetKinds, source().kinds);

  it("opens the first kind at /build and at a kind the reader has not, and marks the address for correction", () => {
    expect(resolveBuildPlace(kinds, {})).toMatchObject({
      kind: { entry: agentKind },
      corrected: true
    });
    expect(resolveBuildPlace(kinds, { kindPath: "nothing", name: "x" })).toMatchObject({
      kind: { entry: agentKind },
      name: undefined,
      corrected: true
    });
    expect(resolveBuildPlace(kinds, { kindPath: "skills", name: "tax-review" })).toEqual({
      kind: kinds[1],
      name: "tax-review",
      corrected: false
    });
    expect(resolveBuildPlace([], {})).toBeUndefined();
    // A kind that only lists has no asset page: the address of an asset is corrected to its list.
    const listed = {
      entry: listedConnections,
      state: { kind: "connection", canCreate: false, canDelete: false }
    };
    expect(resolveBuildPlace([listed], { kindPath: "connections", name: "crm" })).toEqual({
      kind: listed,
      name: undefined,
      corrected: true
    });
    expect(resolveBuildPlace([listed], { kindPath: "connections" })).toEqual({
      kind: listed,
      name: undefined,
      corrected: false
    });
    // A kind with a page that shows an asset keeps the asset's address.
    const viewed = { ...listed, entry: connectionKind };
    expect(resolveBuildPlace([viewed], { kindPath: "connections", name: "crm" })).toEqual({
      kind: viewed,
      name: "crm",
      corrected: false
    });
  });

  it("maps a place in Studio to its route and back", () => {
    for (const location of [{}, { kindPath: "agents" }, { kindPath: "skills", name: "a.b" }]) {
      expect(buildLocationOfRoute(buildRouteOfLocation(location))).toEqual(location);
    }
    expect(buildLocationOfRoute({ kind: "administration" })).toBeUndefined();
  });
});

// ACCEPT-FIX-1 F2: every create dialog makes the address by the one rule the strictest kind
// holds, so the address it suggests is never refused. Fails with the old generator, which
// joined words by '_' that a Knowledge Base, Data Store and App refuse.
describe("Studio ids", () => {
  const address = (name: string) => assetAddressFromName(name, "knowledge_base");

  it("makes an address from the name people read", () => {
    expect(address("ACCEPT Nordlicht Wissen")).toBe("accept-nordlicht-wissen");
    // German letters keep their sound; other accents are dropped.
    expect(address("  Steuer-Prüfung (Köln) 2026 ")).toBe("steuer-pruefung-koeln-2026");
    expect(address("Crème brûlée")).toBe("creme-brulee");
    expect(address("already_an_id")).toBe("already-an-id");
    // A long name is cut at the limit, and the cut never ends on '-'.
    const long = address("Wissen ".repeat(20));
    expect(long.length).toBeLessThanOrEqual(ASSET_ADDRESS_MAX_LENGTH);
    expect(long).toMatch(ASSET_ADDRESS_PATTERN);
  });

  it("starts with the kind's word where the name does not start with a letter", () => {
    expect(address("2026 Jahresplan")).toBe("knowledge-base-2026-jahresplan");
    expect(address("???")).toBe("knowledge-base");
    expect(assetAddressFromName("3. Quartal", "agent")).toBe("agent-3-quartal");
    // Only an empty name makes no address.
    expect(address("   ")).toBe("");
  });
});

// UXA-2: a new asset asks for the name, and its address follows it until somebody types one.
describe("the address of a new asset", () => {
  const address = (name: string) => assetAddressFromName(name, "agent");

  it("follows the name until it is edited by hand, and then stays as typed", () => {
    expect(addressOf({ name: "Tax Review" }, address)).toBe("tax-review");
    const typed = { name: "Tax Review", typedAddress: "tax" };
    expect(addressOf(typed, address)).toBe("tax");
    expect(addressOf({ ...typed, name: "Steuer-Prüfung" }, address)).toBe("tax");
    // Emptied by hand it stays empty, so it does not jump back while the person retypes it.
    expect(addressOf({ name: "Tax Review", typedAddress: "" }, address)).toBe("");
  });

  it("blocks the create only on an address the instance refused", () => {
    const en = createTranslationContext("en").t;
    const refusedName = (reason: "name_invalid" | "name_taken") => ({
      ok: true as const,
      found: { available: false as const, reason, message: "The instance's own sentence" }
    });
    expect(addressCheckOf(refusedName("name_taken"), en, "en")).toMatchObject({
      state: "refused"
    });
    expect(addressCheckOf(refusedName("name_invalid"), en, "en")).toMatchObject({
      state: "refused"
    });
    expect(addressCheckOf({ ok: true, found: { available: true } }, en, "en")).toEqual({
      state: "free"
    });
    // A refusal of the check itself is the instance's sentence; a lost connection says
    // nothing of the name, and the create meets the instance's answer.
    const forbidden = new ApiError(403, "Missing permission agent.write", {
      error: { code: "FORBIDDEN", message: "Missing permission agent.write" }
    });
    expect(addressCheckOf({ ok: false, error: forbidden }, en, "en")).toEqual({
      state: "refused",
      reason: "Missing permission agent.write"
    });
    expect(
      addressCheckOf({ ok: false, error: new TypeError("Failed to fetch") }, en, "en")
    ).toEqual({ state: "unchecked" });

    expect(addressBlocksCreate({ state: "checking" })).toBe(false);
    expect(addressBlocksCreate({ state: "refused", reason: "taken" })).toBe(true);
    expect(addressBlocksCreate({ state: "free" })).toBe(false);
    expect(addressBlocksCreate({ state: "unchecked" })).toBe(false);
  });

  it("asks the instance with the name and the owner Studio writes in", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const client = createApiClient({
      baseUrl: "https://chat.example/",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        calls.push({ url: request.url, body: JSON.parse(await request.text()) });
        return Response.json({ available: true });
      }
    });
    await expect(
      createAssetWrites(client).checkName({
        kind: "agent",
        name: "tax_review",
        workspaceId: "cws_team"
      })
    ).resolves.toEqual({ available: true });
    expect(calls).toEqual([
      {
        url: "https://chat.example/api/v1/assets/agent/check-name",
        body: { name: "tax_review", workspaceId: "cws_team" }
      }
    ]);
  });
});

describe("Studio rights", () => {
  const rights = (permissions: string[], workspaces: Workspaces = []) =>
    resolveBuildRights({ permissions }, platformContext(workspaces, instanceActions(permissions)));
  const taxAgent = { kind: "agent", workspaceId: "ws-tax" };
  const taxSkill = { kind: "skill", workspaceId: "ws-tax" };

  it("lets an instance reader read every kind and write nothing", () => {
    const reader = rights(["config_assets.read"]);

    expect(reader.readsAny).toBe(true);
    expect(reader.reads("agent")).toBe(true);
    expect(reader.reads("skill")).toBe(true);
    expect(reader.instanceWrite).toBe(false);
    expect(reader.may("write", taxAgent)).toBe(false);
    expect(reader.may("delete", { kind: "agent" })).toBe(false);
    expect(reader.mayCreate("agent")).toBe(false);
  });

  it("lets an instance writer write, delete and create everywhere", () => {
    const writer = rights(["config_assets.write"]);

    expect(writer.readsAny).toBe(true);
    expect(writer.reads("skill")).toBe(true);
    expect(writer.instanceWrite).toBe(true);
    expect(writer.may("write", { kind: "agent" })).toBe(true);
    expect(writer.may("delete", taxSkill)).toBe(true);
    expect(writer.mayCreate("skill")).toBe(true);
    expect(writer.mayCreate("skill", "ws-tax")).toBe(true);
  });

  it("lets only a holder of agent.publish publish an agent, as the instance does (AD-4)", () => {
    const permissions = ["config_assets.write"];
    const writer = rights(permissions);
    const publisher = resolveBuildRights(
      { permissions },
      platformContext([], [...instanceActions(permissions), "agent.publish"])
    );

    expect(writer.may("write", { kind: "agent" })).toBe(true);
    expect(writer.may("publish", { kind: "agent" })).toBe(false);
    expect(publisher.may("publish", { kind: "agent" })).toBe(true);
    // A kind that names no publish right is published with the write right, as before.
    expect(writer.may("publish", { kind: "skill" })).toBe(true);
  });

  it("lets a workspace reader read the kinds its actions name and write nothing", () => {
    const reader = rights([], [legalWorkspace]);

    expect(reader.readsAny).toBe(true);
    expect(reader.reads("agent")).toBe(true);
    expect(reader.reads("skill")).toBe(true);
    expect(reader.instanceWrite).toBe(false);
    expect(reader.readsInstance).toBe(false);
    expect(reader.may("write", { kind: "agent", workspaceId: "ws-legal" })).toBe(false);
    expect(reader.mayCreate("agent", "ws-legal")).toBe(false);
    expect(reader.workspaces).toEqual([{ id: "ws-legal", name: "Legal", member: true }]);
    expect(rights([], [{ ...legalWorkspace, actions: ["skill.read"] }]).reads("agent")).toBe(false);
  });

  it("lets a workspace writer write what the workspace owns, per kind and per verb", () => {
    const writer = rights([], [taxWorkspace, legalWorkspace]);

    expect(writer.may("write", taxAgent)).toBe(true);
    expect(writer.may("delete", taxAgent)).toBe(true);
    expect(writer.may("write", taxSkill)).toBe(false);
    expect(writer.may("write", { kind: "agent", workspaceId: "ws-legal" })).toBe(false);
    // An asset the instance owns is no workspace's.
    expect(writer.may("write", { kind: "agent" })).toBe(false);
    expect(writer.may("write", { kind: "connection", workspaceId: "ws-tax" })).toBe(false);
    expect(
      rights([], [{ ...taxWorkspace, actions: ["agent.write"] }]).may("delete", taxAgent)
    ).toBe(false);
    // A new asset is started in a workspace whose kind the reader writes there.
    expect(writer.mayCreate("agent", "ws-tax")).toBe(true);
    expect(writer.mayCreate("skill", "ws-tax")).toBe(false);
    expect(writer.mayCreate("agent", "ws-legal")).toBe(false);
    expect(writer.mayCreate("agent")).toBe(false);
  });

  it("lets an agent be started by a writer on an instance that lets agents be created", () => {
    const on = { allowAgentCreation: true };

    expect(mayCreateAgents(rights(["config_assets.write"]), on)).toBe(true);
    // The right alone is not enough: the instance has its own switch.
    expect(mayCreateAgents(rights(["config_assets.write"]), { allowAgentCreation: false })).toBe(
      false
    );
    expect(mayCreateAgents(rights(["config_assets.write"]), undefined)).toBe(false);
    // Nor is the switch: a reader, and a reader in a workspace, start nothing.
    expect(mayCreateAgents(rights(["config_assets.read"]), on)).toBe(false);
    expect(mayCreateAgents(rights([], [legalWorkspace]), on)).toBe(false);
  });

  it("lets the holder of a read grant on one asset see the kind, and write nothing", () => {
    const holder = resolveBuildRights({ permissions: [] }, platformContext([], [], ["skill.read"]));

    expect(holder.readsAny).toBe(true);
    expect(holder.reads("skill")).toBe(true);
    expect(holder.reads("agent")).toBe(false);
    expect(holder.instanceWrite).toBe(false);
    expect(holder.may("write", { kind: "skill" })).toBe(false);
    expect(holder.mayCreate("skill")).toBe(false);
  });

  it("gives nobody anything: no permission, no workspace right, or no answer of the instance", () => {
    for (const nobody of [
      rights([]),
      rights(["users.manage"]),
      resolveBuildRights(undefined, undefined),
      resolveBuildRights({ permissions: [] }, undefined)
    ]) {
      expect(nobody.readsAny).toBe(false);
      expect(nobody.reads("agent")).toBe(false);
      expect(nobody.instanceWrite).toBe(false);
      expect(nobody.may("write", taxAgent)).toBe(false);
      expect(nobody.mayCreate("agent")).toBe(false);
      expect(nobody.workspaces).toEqual([]);
    }
    // The session alone opens Studio for an instance reader before the instance answered.
    expect(resolveBuildRights({ permissions: ["config_assets.read"] }, undefined).readsAny).toBe(
      true
    );
  });
});

describe("Studio scope", () => {
  const team = { id: "cws_team", name: "Team", kind: "shared" as const };
  const mine = {
    id: "cws_mine",
    name: "Mine",
    kind: "personal" as const,
    member: true,
    actions: ["agent.write"]
  };
  const inTeam = (actions: string[], permissions: string[] = []) =>
    resolveBuildRights(
      { permissions },
      {
        ...platformContext([], instanceActions(permissions)),
        // The reader's Personal Workspace is a scope of Studio beside the others: what the
        // reader's agent made there is found and changed there.
        workspaces: [{ ...team, member: true, actions }, mine]
      }
    );

  it("lets a holder of rights in a workspace read and write what it owns, and nothing of the instance", () => {
    const member = inTeam(["agent.read", "agent.write", "skill.read"]);

    expect(member.readsAny).toBe(true);
    expect(member.readsInstance).toBe(false);
    expect(member.workspaces).toEqual([
      { id: "cws_team", name: "Team", member: true },
      { id: "cws_mine", name: "Mine", member: true, personal: true }
    ]);
    expect(member.reads("agent")).toBe(true);
    expect(member.may("write", { kind: "agent", workspaceId: "cws_team" })).toBe(true);
    expect(member.may("delete", { kind: "agent", workspaceId: "cws_team" })).toBe(false);
    expect(member.may("write", { kind: "skill", workspaceId: "cws_team" })).toBe(false);
    expect(member.may("write", { kind: "agent", workspaceId: "cws_mine" })).toBe(true);
    expect(member.may("write", { kind: "agent", workspaceId: "cws_other" })).toBe(false);
    expect(member.may("write", { kind: "agent" })).toBe(false);
    expect(member.mayCreate("agent", "cws_team")).toBe(true);
    expect(member.mayCreate("agent")).toBe(false);
    expect(buildScopes(member)).toEqual([
      { kind: "workspace", workspaceId: "cws_team" },
      { kind: "workspace", workspaceId: "cws_mine" }
    ]);
    expect(buildWorkspaceName(member, "cws_mine", "Only me")).toBe("Only me");
    expect(buildWorkspaceName(member, "cws_team", "Only me")).toBe("Team");
    expect(resolveBuildScope(member, undefined, undefined)).toEqual({
      kind: "workspace",
      workspaceId: "cws_team"
    });
  });

  it("opens Studio to nobody for their Personal Workspace alone", () => {
    const alone = resolveBuildRights(
      { permissions: [] },
      { ...platformContext([], instanceActions([])), workspaces: [mine] }
    );
    expect(alone.readsAny).toBe(false);
    expect(buildScopes(alone)).toEqual([]);
  });

  it("offers the instance first, then each workspace, and keeps the scope chosen last", () => {
    const admin = inTeam(["agent.read", "agent.write"], ["config_assets.write"]);

    expect(buildScopes(admin)).toEqual([
      { kind: "instance" },
      { kind: "workspace", workspaceId: "cws_team" },
      { kind: "workspace", workspaceId: "cws_mine" }
    ]);
    expect(resolveBuildScope(admin, undefined, "cws_team")).toEqual({ kind: "instance" });
    expect(resolveBuildScope(admin, "cws_team", undefined)).toEqual({
      kind: "workspace",
      workspaceId: "cws_team"
    });
    // A scope no longer offered falls back to the first.
    expect(resolveBuildScope(admin, "cws_gone", undefined)).toEqual({ kind: "instance" });
    // An instance writer writes in every workspace.
    expect(admin.may("delete", { kind: "skill", workspaceId: "cws_team" })).toBe(true);
  });
});

describe("Studio refusals", () => {
  const { t } = createTranslationContext("en");
  const refusal = (code: string, message: string, details?: Record<string, unknown>) =>
    new ApiError(code === "REVISION_CONFLICT" ? 412 : code === "FORBIDDEN" ? 403 : 400, message, {
      error: { code, message, ...(details ? { details } : {}) }
    });
  const said = (error: unknown, locale: "en" | "de" = "en") =>
    refusalsOf(readBuildRefusal(error, createTranslationContext(locale).t, locale), undefined);

  it("tells a refusal with a known reason in the reader's words, never the instance's sentence", () => {
    // Person context in Apps (APP-16), and a new agent's consent that the instance no longer
    // holds (ACCEPT-2d E-1), in the reader's language.
    const refused: [string, string, "en" | "de"][] = [
      ["VALIDATION_FAILED", "person_context_app_unavailable", "en"],
      ["PRECONDITION_REQUIRED", "dependency_availability_review_required", "en"],
      ["CONFLICT", "dependency_availability_changed", "de"]
    ];
    for (const [code, reason, locale] of refused) {
      const words = said(refusal(code, "Server sentence", { reason }), locale);
      expect(words).toHaveLength(1);
      expect(words[0]).not.toBe("Server sentence");
    }
    // STORE-PAGES: the instance's sentence may name assets hidden from the reader.
    const outcome = readBuildRefusal(
      refusal("VALIDATION_FAILED", "Data Store 'leads' is used by app 'secret-board'", {
        reason: "data_store_in_use"
      }),
      t,
      "en"
    );
    expect(refusalsOf(outcome, undefined).join(" ")).toContain("still in use");
    expect(refusalsOf(outcome, undefined).join(" ")).not.toContain("secret-board");
    expect(outcome).not.toMatchObject({ refusals: [{ detail: expect.anything() }] });
  });

  // SKILL-DEL-1: Delete stays in the menu and says why it cannot be chosen.
  it("says why a skill cannot be deleted now, never naming an agent the reader cannot see", () => {
    const skill = {
      id: "asset_guide",
      kind: "skill",
      name: "guide",
      scope: { kind: "workspace" as const, workspaceId: "cws_team" },
      revision: 2,
      config: { name: "guide" },
      updatedAt: "2026-11-16T10:00:00.000Z"
    };
    const team = { rung: "workspace" as const, name: "Team" };
    const reason = (
      asset: typeof skill & {
        listedBy?: { name: string; title: string }[];
        listedByUnread?: number;
      },
      may: boolean
    ) => deleteBlockedReason(asset, may, team, t, "en");
    const listed = {
      ...skill,
      listedBy: [
        { name: "intake", title: "Intake" },
        { name: "review", title: "Review" }
      ]
    };

    expect(reason(skill, true)).toBeUndefined();
    expect(reason(skill, false)).toBeDefined();
    expect(reason(listed, true)).toContain("Intake and Review");
    expect(
      reason({ ...listed, listedBy: listed.listedBy.slice(0, 1), listedByUnread: 2 }, true)
    ).toContain("Intake and 2 agents you cannot see");
    // Without the right the reader is told that, not which agents list it.
    expect(reason(listed, false)).not.toContain("Intake");
  });

  it("names a blocking guardrail by its title, with its author's reason (ACCEPT-FIX-10 E8)", () => {
    const blocked = (details: Record<string, unknown>) =>
      said(refusal("GUARDRAIL_BLOCKED", "Guardrail 'no-iban' blocked skill 'report'", details));
    const reason = "Assets hold no bank account numbers.";
    expect(
      blocked({ guardrailId: "no-iban", guardrailTitle: "Keine IBAN", guardrailReason: reason })
    ).toEqual([`The guardrail “Keine IBAN” stopped this change. ${reason}`]);
    // Without a title the instance's sentence stands as it came.
    expect(blocked({ guardrailId: "no-iban" })).toEqual([
      "Guardrail 'no-iban' blocked skill 'report'"
    ]);
  });

  it("answers a write over a newer revision as a conflict, with who wrote it and whether it is the delete", () => {
    const conflict = { kind: "agent", name: "tax", currentRevision: 4 };
    const changed = { changedBy: "Kai Lehmann", changedAt: "2026-10-12T09:30:00.000Z" };
    const plain = readBuildRefusal(
      refusal("REVISION_CONFLICT", "Config agent 'tax' is not at the revision the call names", {
        reason: "revision_conflict",
        conflicts: [{ kind: "agent", name: "tax" }]
      }),
      t,
      "en"
    );

    expect(plain).toEqual({ ok: false, conflict: true });
    expect(refusalsOf(plain, undefined)).toEqual([]);
    expect(refusalsOf(plain, "tools")).toEqual([]);
    expect(
      readBuildRefusal(
        refusal("REVISION_CONFLICT", "Config agent 'tax' was deleted at revision 4", {
          conflicts: [{ ...conflict, deleted: true, ...changed }]
        }),
        t,
        "en"
      )
    ).toEqual({ ok: false, conflict: true, deleted: true, currentRevision: 4, ...changed });
    // Any other conflict is shown as the instance said it.
    expect(readBuildRefusal(refusal("CONFLICT", "The default agent changed"), t, "en")).toEqual({
      ok: false,
      conflict: false,
      refusals: [{ message: "The default agent changed", asSent: true }]
    });
  });

  it("puts a refusal of a workspace's build limits at the tools or the model, naming the workspace", () => {
    const workspace = { workspaceId: "cws_kai", workspace: "Kai Spezis" };
    const [tool, model, missing] = [
      { reason: "tool_not_allowed", toolName: "documents.read", ...workspace },
      { reason: "model_not_allowed", modelBindingId: "reasoning", ...workspace },
      { reason: "model_binding_required", ...workspace }
    ].map((details) => readBuildRefusal(refusal("FORBIDDEN", "Forbidden", details), t, "en"));

    expect(refusalsOf(tool, "tools")).toEqual([expect.stringContaining("Kai Spezis")]);
    expect(refusalsOf(tool, "tools")[0]).toContain("documents.read");
    expect(refusalsOf(tool, "model")).toEqual([]);
    expect(refusalsOf(tool, undefined)).toEqual([]);
    expect(refusalsOf(model, "model")).toEqual([expect.stringContaining("reasoning")]);
    expect(refusalsOf(missing, "model")).toEqual([expect.stringContaining("Kai Spezis")]);
  });

  it("sends each issue of a definition to the field its path names", () => {
    const outcome = readBuildRefusal(
      refusal("VALIDATION_FAILED", "The definition is invalid", {
        issues: [
          { message: "Tool 'nope' is not registered", path: ["toolNames", 2] },
          { message: "Skill 'gone' does not exist", path: ["config", "skillNames", 0] },
          { message: "Reasoning effort 'max' is not offered", path: ["reasoningEffort"] },
          {
            message: "Model binding 'x' does not exist",
            path: ["userSelectableModelBindingIds", 0]
          },
          { message: "Instructions must not be empty", path: ["instructions"] },
          { message: "The definition names no title" },
          { path: ["toolNames"] }
        ]
      }),
      t,
      "en"
    );

    expect(refusalsOf(outcome, "tools")).toEqual(["Tool 'nope' is not registered"]);
    expect(refusalsOf(outcome, "skills")).toEqual(["Skill 'gone' does not exist"]);
    expect(refusalsOf(outcome, "model")).toEqual([
      "Reasoning effort 'max' is not offered",
      "Model binding 'x' does not exist"
    ]);
    // An issue of a field without a place of its own, or without a path, shows above the save bar.
    expect(refusalsOf(outcome, undefined)).toEqual([
      "Instructions must not be empty",
      "The definition names no title"
    ]);
  });

  // ACCEPT-FIX-9 E6: the notice named nobody. It names who may approve, as the request lists
  // them, joined by "or" in the reader's language.
  it("says that a change waits for an approval, and names who may approve it", () => {
    expect(readBuildRefusal(new PendingApprovalError(), t, "en")).toMatchObject({
      ok: false,
      conflict: false,
      refusals: [{ waiting: true }]
    });
    expect(said(new PendingApprovalError(["Mara Lindqvist", "Jonas Berg"]))).toEqual([
      "This change waits for approval by Mara Lindqvist or Jonas Berg. Nothing has changed yet and your text is still here."
    ]);
    // The names come from the waiting request's preview; anything else there is left out.
    expect(approverNamesOf({ approverNames: ["Mara Lindqvist", 7, " ", "Jonas Berg"] })).toEqual([
      "Mara Lindqvist",
      "Jonas Berg"
    ]);
    expect(approverNamesOf(undefined)).toEqual([]);
  });

  it("shows every other sentence as the instance said it, and nothing for a saved change", () => {
    const unread = "The change would break an asset the caller may not read";

    expect(readBuildRefusal(refusal("VALIDATION_FAILED", unread), t, "en")).toEqual({
      ok: false,
      conflict: false,
      refusals: [{ message: unread, asSent: true }]
    });
    expect(
      said(
        refusal("VALIDATION_FAILED", "The definition is invalid", {
          issues: [{ message: unread, path: [] }]
        })
      )
    ).toEqual([unread]);
    // A refusal for a reason this page has no sentence for keeps the instance's own.
    expect(
      said(refusal("FORBIDDEN", "Agent 'tax-a' may not be the default", { reason: "other" }))
    ).toEqual(["Agent 'tax-a' may not be the default"]);
    expect(said(new Error("Network down"))).toEqual(["Network down"]);
    expect(said(undefined)).toEqual(["The change could not be saved."]);
    expect(refusalsOf({ ok: true }, undefined)).toEqual([]);
    expect(refusalsOf(undefined, "tools")).toEqual([]);
  });
});

describe("asset writes", () => {
  /** A client whose requests are recorded and answered as a write that was made. */
  function recordingWrites() {
    /** `asset` is the request's address below the root of the asset operations. */
    const requests: { method: string; asset: string; body: unknown }[] = [];
    const client = createApiClient({
      baseUrl: "https://chat.example/",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        const body: unknown = JSON.parse(await request.text());
        const asset = new URL(request.url).pathname.replace(/^.*\/assets\//u, "");
        requests.push({ method: request.method, asset, body });
        return Response.json({ version: 9, revision: 8, warnings: [] });
      }
    });
    return { writes: createAssetWrites(client), requests };
  }
  const address = { kind: "agent", name: "tax-assistant" };

  it("names exactly the revision it is handed, however often it is asked", async () => {
    const { writes, requests } = recordingWrites();
    const config = { name: "tax-assistant", instructions: "Help." };

    // A page that loaded revision 3 keeps writing against 3, whatever was saved since.
    await writes.put({ ...address, config, expectedRevision: 3 });
    await writes.put({ ...address, config, expectedRevision: 3 });
    await writes.revert({ ...address, revision: 1, expectedRevision: 3 });
    await writes.delete({ ...address, expectedRevision: 3 });

    const put = {
      method: "PUT",
      asset: "agent/tax-assistant",
      body: { config, expectedRevision: 3 }
    };
    expect(requests).toEqual([
      put,
      put,
      {
        method: "POST",
        asset: "agent/tax-assistant/revert",
        body: { revision: 1, expectedRevision: 3 }
      },
      { method: "POST", asset: "agent/tax-assistant/delete", body: { expectedRevision: 3 } }
    ]);
  });

  it("names null for the revision when it creates an asset", async () => {
    const { writes, requests } = recordingWrites();
    const config = { name: "tax-assistant" };

    const outcome = await writes.put({ ...address, config, expectedRevision: null });

    expect(requests).toEqual([
      { method: "PUT", asset: "agent/tax-assistant", body: { config, expectedRevision: null } }
    ]);
    expect(outcome).toMatchObject({ status: "done", output: { revision: 8 } });
  });
});
