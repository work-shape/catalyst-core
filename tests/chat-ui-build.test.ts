import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { DocsAddressProvider } from "@work-shape/catalyst-ui";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  buildLocationOfRoute,
  BuildNavigationProvider,
  buildRouteOfLocation,
  clearBuildStartRequest,
  isEditableKind,
  requestBuildStart,
  resolveBuildPlace,
  resolveBuildRights,
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

// In the order the instance answers them: by name.
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

  it("lands on the Agents list, titled by the name with what the agent does beneath", () => {
    const markup = render({});

    expect(markup).toContain('<h1 class="min-w-0 break-words outline-none text-title-lg">Agents');
    expect(markup).toContain(">Workflow Assistant<");
    expect(markup).toContain(">Reviews a workflow and plans the next checks.<");
    // An id is never the second line of an agent.
    expect(markup).not.toContain(">workflow_assistant<");
    expect(markup).toContain(">Default agent<");
    expect(markup).toContain(">New agent<");
    expect(markup).not.toContain("New skill");
    // The instance orders the rows, and the frame shows them as they came.
    expect(markup.indexOf("Steuer-Agent")).toBeLessThan(markup.indexOf("Workflow Assistant"));
    expect(markup).not.toMatch(/Version \d/u);
    expect(markup).not.toContain("catalyst CLI");
  });

  it("makes each row a link to the asset's address", () => {
    const markup = render({ kindPath: "agents" });

    expect(markup).toMatch(/<a [^>]*href="\/build\/agents\/workflow_assistant"/u);
    expect(markup).not.toMatch(/<li[^>]*>\s*<div[^>]*>\s*<button/u);
  });

  it("falls back to the id where the instance sent no title", () => {
    const markup = render(
      { kindPath: "agents" },
      { source: source({ lists: { agent: { rows: [row("agent", "untitled", { title: " " })] } } }) }
    );

    expect(markup).toContain(">untitled</");
    expect(markup).not.toContain('<code class="font-mono">untitled</code>');
  });

  it("says what a skill knows how to do, and shows a skill without a summary by its title alone", () => {
    const summary = "Knows how to review a tax file.";
    const markup = render(
      { kindPath: "skills" },
      {
        source: source({
          lists: {
            skill: {
              rows: [
                row("skill", "tax-review", { title: "Tax review", attributes: { summary } }),
                row("skill", "plain", { title: "Plain language" }),
                // A custom skill named like a shipped one, which claims the shipped icon.
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

    expect(rowOf("tax-review")).toContain(`>${summary}<`);
    // Never the id and never the text for the agent.
    expect(markup).not.toContain("<code");
    expect(rowOf("plain")).toContain(">Plain language<");
    expect(rowOf("plain")).not.toContain("text-caption text-muted-foreground");
    expect(rowOf("plain")).toContain('data-skill-icon="generic"');
    expect(rowOf("pdf")).toContain('data-skill-icon="generic"');
    expect(rowOf("pdf")).not.toContain("data-file-type");
    expect(rowOf("platform.pdf")).toContain('data-file-type="pdf"');
    // The icon repeats the title beside it.
    expect(rowOf("platform.pdf")).toMatch(/<span aria-hidden="true" data-skill-icon="pdf"/u);
  });

  it("names the kinds in the reader's language", () => {
    const markup = render({ kindPath: "agents" }, { locale: "de" });

    expect(markup).toContain(">Agenten<");
    expect(markup).toContain("Skills");
    expect(markup).not.toContain("Fähigkeiten");
  });

  it("shows the kinds as a rail without counts, and none while a single kind is visible", () => {
    const both = render({ kindPath: "skills" });
    const one = render(
      { kindPath: "agents" },
      {
        source: source({
          permissions: [],
          workspaces: [{ ...taxWorkspace, actions: ["agent.read"] }]
        })
      }
    );

    expect(both).toContain('aria-label="Kinds in Studio"');
    expect(both).toContain('<option value="agents">Agents</option>');
    expect(both).toContain('<option value="skills" selected="">Skills</option>');
    expect(one).not.toContain('aria-label="Kinds in Studio"');
  });

  it("shows a planted kind as a third rail item, with its list and its asset page", () => {
    const kinds = [...buildAssetKinds, plantedKind];
    const base = source();
    const withWorkflows = source({
      lists: {
        workflow: { rows: [row("workflow", "crm", { title: "CRM" })] }
      },
      assets: { "workflow/crm": ready(asset("workflow", "crm")) },
      overrides: {
        kinds: [...base.kinds, { kind: "workflow", canCreate: false, canDelete: false }]
      }
    });
    const list = render({ kindPath: "workflows" }, { kinds, source: withWorkflows });
    const page = render({ kindPath: "workflows", name: "crm" }, { kinds, source: withWorkflows });

    expect(list).toContain('<option value="workflows" selected="">API access</option>');
    expect(list).toContain(">CRM<");
    // A row without a line of its kind shows the title alone, never the id.
    expect(list).not.toContain('<code class="font-mono">crm</code>');
    // Without the right to create, the list has no New button.
    expect(list).not.toContain("New agent");
    expect(page).toContain("workflow body of crm");
    // A kind the instance did not answer for has no rail item.
    expect(render({ kindPath: "agents" }, { kinds })).not.toContain("API access");
  });

  it("lists Connections with New connection for who may create one, each row with its chips and a link to its page", () => {
    const base = source();
    const withConnections = (rows: BuildAssetRow[]) =>
      source({
        lists: { connection: { rows } },
        overrides: {
          // The reader may write every asset of the instance, and so create a Connection.
          kinds: [...base.kinds, { kind: "connection", canCreate: true, canDelete: true }]
        }
      });
    const rows = [
      row("connection", "crm", {
        title: "CRM",
        attributes: { connectorType: "mcp", origin: "release", enabled: true }
      }),
      row("connection", "ledger", {
        title: "Ledger",
        scope: { kind: "workspace", workspaceId: "ws_1" },
        attributes: { connectorType: "postgres", origin: "runtime", enabled: false }
      })
    ];
    const list = render({ kindPath: "connections" }, { source: withConnections(rows) });

    expect(list).toContain('<option value="connections" selected="">Connections</option>');
    expect(list).toContain(">CRM<");
    for (const chip of [">MCP server<", ">postgres<", "Enabled", "Disabled"]) {
      expect(list, chip).toContain(chip);
    }
    // One chip says where a row sits: the frame's, never a second one of the kind.
    expect(list.split(">Everyone<")).toHaveLength(2);
    expect(list).not.toContain(">Workspace<");
    // Where a Connection comes from is no chip of the row.
    expect(list).not.toContain("Release config");
    expect(list).not.toContain(">Runtime<");
    // A row opens the Connection's page, and a new one is started from the list.
    expect(list).toContain('href="/build/connections/crm"');
    expect(list).toContain(">New connection<");
    expect(list).not.toContain("More actions");
    // The list says what Connections are and which of them are read-only, with rows and without.
    expect(list).toContain(
      "Connections give agents, apps and workflows access to outside systems. Those that come with the system setup are read-only here."
    );
    // The address of a Connection the instance does not hold says so, and names the way back.
    const missing = render(
      { kindPath: "connections", name: "crm" },
      { source: withConnections(rows) }
    );
    expect(missing).toContain("There is no connection with the id crm.");
    expect(missing).toContain('aria-label="Back to Connections"');
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

    const empty = (locale: LocaleCode) =>
      render({ kindPath: "connections" }, { locale, source: withConnections([]) });
    expect(empty("en")).toContain(
      "No connections yet. A connection holds the access to an outside system."
    );
    expect(empty("de")).toContain(
      "Verbindungen geben Agenten, Apps und Workflows Zugang zu externen Systemen. Die aus der Einrichtung des Systems sind hier schreibgeschützt."
    );
    expect(empty("en")).toContain(">New connection<");
    expect(empty("de")).toContain(
      "Noch keine Verbindungen. Eine Verbindung hält den Zugang zu einem externen System."
    );
    // The instance did not answer for the kind: no rail item.
    expect(render({ kindPath: "agents" })).not.toContain("Connections");
  });

  it("says in a sentence what an empty list is for, with the one button, or without the right", () => {
    const empty = (permissions: string[]) =>
      render(
        { kindPath: "skills" },
        { source: source({ permissions, lists: { skill: { rows: [] } } }) }
      );
    const writer = empty(["config_assets.write"]);
    const reader = empty(["config_assets.read"]);

    expect(writer).toContain("A skill holds instructions");
    expect(writer.match(/New skill/gu)).toHaveLength(2);
    expect(reader).toContain("No skills yet.");
    expect(reader).not.toContain("New skill");
  });

  it("shows the not-found state at an agent's address that has no agent, without its id", () => {
    const missing = render({ kindPath: "agents", name: "retired_helper" });

    expect(missing).toContain("data-not-found");
    expect(missing).toContain(">There is no agent at this address.</h1>");
    // One step, a link to the list, and no head with a way back beside it.
    const action =
      missing.match(/<a[^>]*href="\/build\/agents\/"[^>]*>Back to Agents<\/a>/u)?.[0] ?? "";
    expect(action).toContain("bg-primary-soft");
    expect(missing).not.toContain('aria-label="Back to Agents"');
    expect(missing).not.toContain("retired_helper");
  });

  it("shows a skeleton until the instance said what the reader may do, and until a list arrived", () => {
    const unknown = render({}, { source: source({ overrides: { kinds: [], loading: true } }) });
    const list = render(
      { kindPath: "agents" },
      { source: source({ lists: { agent: { rows: undefined } } }) }
    );
    const page = render(
      { kindPath: "agents", name: "workflow_assistant" },
      { source: source({ assets: { "agent/workflow_assistant": { status: "loading" } } }) }
    );

    expect(unknown).toContain('aria-busy="true"');
    expect(unknown).not.toContain("There is nothing to build here yet.");
    expect(list).toContain('aria-busy="true"');
    expect(list).toContain('<option value="agents" selected="">Agents</option>');
    expect(list).not.toContain("No agents yet");
    expect(page).toContain('aria-busy="true"');
    expect(page).not.toContain("There is no agent");
  });

  it("says that Studio could not be loaded and offers to try again", () => {
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

    expect(area).toContain('role="alert"');
    expect(area).toContain("Studio could not be loaded.");
    expect(area).toContain("Try again");
    expect(area).not.toContain("There is nothing to build here yet.");
    expect(list).toContain('role="alert"');
    expect(list).toContain("The list could not be read.");
    expect(list).toContain("Try again");
    expect(list).not.toContain('aria-busy="true"');
    expect(list).not.toContain("No agents yet");
  });

  it("says that there is nothing to build where the instance names no kind", () => {
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
    expect(more).toContain(">Workflow Assistant<");
    expect(render({ kindPath: "agents" })).not.toContain("Show more");
  });
});

describe("Studio with rights in a workspace", () => {
  const holder = (workspaces: Workspaces, input: SourceInput = {}) =>
    source({ permissions: [], workspaces, inWorkspace: "ws-tax", ...input });

  it("offers a new asset only for a kind the holder may write in the workspace", () => {
    const from = holder([taxWorkspace]);
    const agentList = render({ kindPath: "agents" }, { source: from });
    const skillList = render({ kindPath: "skills" }, { source: from });

    expect(agentList).toContain(">New agent<");
    expect(skillList).toContain(">Tax review<");
    expect(skillList).not.toContain("New skill");
    // Empty, the list of a kind the holder only reads has the sentence without the button.
    expect(
      render(
        { kindPath: "skills" },
        { source: holder([taxWorkspace], { lists: { skill: { rows: [] } } }) }
      )
    ).toContain("No skills yet.");
    // In a workspace where the holder only reads, nothing is offered to start.
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

  it("opens an asset the reader may not write read-only, with no way to save or delete", () => {
    const markup = page(source({ permissions: [], workspaces: [taxWorkspace], assets: read }));

    // The notice names whose asset it is and what editing needs.
    expect(markup).toMatch(/data-build-read-only=""[^>]*>.*Belongs to Tax\. Only a person/u);
    expect(markup).toContain('value="Tax review"');
    // A field that is only read stays readable: read-only, not disabled, and not required.
    expect(markup).toMatch(/<input[^>]*readOnly=""[^>]*value="Tax review"/u);
    expect(markup).not.toMatch(/<input[^>]*disabled=""[^>]*value="Tax review"/u);
    expect(markup).not.toMatch(/<input[^>]*required=""[^>]*value="Tax review"/u);
    expect(markup).not.toContain('aria-label="Add a file to references/"');
    expect(markup).not.toContain("Save changes");
    expect(markup).not.toContain('type="submit"');
    // History and "Copy ID" are offered to everybody who reads the asset.
    expect(markup).toContain('aria-label="More actions"');
    expect(markup).toContain("History");
  });

  it("opens an asset of a workspace the reader writes for editing", () => {
    const markup = page(source({ permissions: [], workspaces: [skillWriter], assets: read }));

    expect(markup).not.toContain("data-build-read-only");
    expect(markup).not.toMatch(/<input[^>]*readOnly=""[^>]*value="Tax review"/u);
    expect(markup).toContain('aria-label="Add a file to references/"');
    expect(markup).toContain('aria-label="More actions"');
    // Nothing is changed yet, so there is nothing to save.
    expect(markup).not.toContain("Save changes");
  });

  // Fails with the copy among the secondary actions: on a phone it folded into "…" with History,
  // and the head offered nothing while the notice under it said to copy the skill.
  it("keeps Copy to edit of a shipped skill in the head as its leading action", () => {
    const shippedSkill = asset("skill", "tax-review", {
      config: { ...taxSkill.config, origin: "release" }
    });
    const markup = page(
      source({
        permissions: ["config_assets.read", "config_assets.write"],
        assets: { "skill/tax-review": ready(shippedSkill) }
      })
    );
    const unfolded = /<div[^>]*inert[^>]*>(.*?)<\/div>/u.exec(markup)?.[1] ?? "";

    expect(markup).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Copy to edit<\/button>/u);
    expect(unfolded).toContain("History");
    expect(unfolded).not.toContain("Copy to edit");
  });

  it("reads only an asset outside the workspaces the reader writes", () => {
    const elsewhere = asset("skill", "tax-review", {
      scope: { kind: "workspace", workspaceId: "ws-legal" },
      config: taxSkill.config
    });
    const markup = page(
      source({
        permissions: [],
        workspaces: [skillWriter, legalWorkspace],
        assets: { "skill/tax-review": ready(elsewhere) }
      })
    );

    expect(markup).toContain(
      "Belongs to Legal. Only a person who may build in Legal can change it."
    );
  });

  it("says of an instance asset that editing needs the right on the instance", () => {
    const instanceSkill = asset("skill", "tax-review", { config: taxSkill.config });
    const markup = page(
      source({
        permissions: ["config_assets.read"],
        assets: { "skill/tax-review": ready(instanceSkill) }
      })
    );

    expect(markup).toContain(
      "This is for everyone. Only a person who may build for everyone can change it."
    );
  });

  it("ends the read-only notice with one link into the documentation, and with none on an instance without a docs address", () => {
    const from = source({ permissions: [], workspaces: [taxWorkspace], assets: read });
    const at = { kindPath: "skills", name: "tax-review" };
    const notice = (markup: string) =>
      /data-build-read-only=""[^>]*>(.*?)<\/div>\s*<\/div>/u.exec(markup)?.[1] ?? markup;
    const linked = render(at, {
      kinds: pageKinds,
      source: from,
      docsAddress: "https://docs.workshape.ai/catalyst/"
    });
    const german = render(at, {
      kinds: pageKinds,
      source: from,
      locale: "de",
      docsAddress: "https://docs.workshape.ai/catalyst"
    });

    expect(linked.match(/data-docs-link/gu)).toHaveLength(1);
    expect(notice(linked)).toMatch(
      /can change it\.[^<]*<a href="https:\/\/docs\.workshape\.ai\/catalyst\/operate\/how-rights-work\/#do-you-hold-the-right-here" target="_blank" rel="noopener noreferrer" aria-label="Learn more about who may change this, opens in a new tab"[^>]*>Learn more</u
    );
    expect(german).toMatch(
      /aria-label="Mehr erfahren darüber, wer das ändern darf, öffnet in neuem Tab"[^>]*>Mehr erfahren</u
    );
    // Without an address the notice is the same sentence and no link.
    expect(page(from)).toContain("Belongs to Tax. Only a person");
    expect(page(from)).not.toContain("data-docs-link");
    expect(page(from)).not.toContain("Learn more");
  });

  it("leaves the delete out where the instance does not let people delete the kind", () => {
    const base = source({ assets: read });
    const markup = page({
      ...base,
      kinds: base.kinds.map((kind) => ({ ...kind, canDelete: false }))
    });

    expect(markup).not.toContain("data-build-read-only");
  });

  it("shows the sentence of a failed read as the instance said it", () => {
    const sentence = "The skill store is closed for maintenance until 14:00";
    const markup = page(
      source({
        assets: { "skill/tax-review": { status: "failed", message: sentence, retry: noop } }
      })
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain(sentence);
    expect(markup).toContain("Try again");
    expect(markup).toContain('aria-label="Back to Skills"');
    expect(markup).not.toContain("There is no skill");
  });

  it("tells a reader who may not read the asset so in their language, with nothing to try again", () => {
    const markup = page(source({ assets: { "skill/tax-review": { status: "refused" } } }));

    expect(markup).toContain("You may not read this asset.");
    expect(markup).not.toContain("Try again");
    expect(markup).not.toContain("Missing the right");
    expect(markup).toContain('aria-label="Back to Skills"');
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
