import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ShippedGuardrailView } from "@work-shape/catalyst-api-client";
import {
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  resolveBuildRights,
  ShippedGuardrailsLead,
  type BuildAssetRow,
  type BuildKind,
  type BuildListLeadFilter,
  type BuildScope,
  type BuildSource,
  type ShippedGuardrailsRead
} from "@work-shape/catalyst-chat-ui/build-area";
import { instanceActions, platformContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// Build > Guardrails: the guardrail the platform ships is the first row of the one list, under
// its search and scope, with its switch and its state line (GR-PUB-1). The list says it is
// empty only where nothing, the shipped guardrail included, is in it.

const TEAM = "cws_team";
const noop = () => undefined;

const shipped: ShippedGuardrailView = {
  name: "publishing-needs-approval",
  displayName: "Publishing needs an instance admin's approval",
  reason: "A new revision of an App or a Workflow goes live once an instance admin approved it.",
  on: ["app.before_publish", "workflow.before_publish"],
  outcome: "require_approval",
  enabled: true,
  canSwitch: true
};

function ready(items: ShippedGuardrailView[]): ShippedGuardrailsRead {
  return { status: "ready", items, switching: undefined, switchTo: async () => undefined };
}

/** The guardrails' list as the frame shows it, its shipped rows read from `read`. */
function guardrailKind(read: ShippedGuardrailsRead): BuildKind {
  return {
    // The fixture's instance knows agents: the list of this test stands on their rights.
    kind: "agent",
    path: "guardrails",
    label: "guardrails.kind",
    searchLabel: "guardrails.search",
    emptyText: "guardrails.empty",
    icon: "guardrail",
    ListLead: (props) => createElement(ShippedGuardrailsLead, { read, ...props })
  };
}

function guardrail(name: string): BuildAssetRow {
  return {
    id: `asset_${name}`,
    kind: "agent",
    name,
    title: name,
    scope: { kind: "instance" },
    revision: 1,
    updatedAt: "2026-10-08T10:00:00.000Z"
  };
}

function source(
  scope: BuildScope,
  rows: BuildAssetRow[],
  listError: string | undefined
): BuildSource {
  const permissions = ["config_assets.read", "config_assets.write"];
  const context = {
    ...platformContext([], instanceActions(permissions)),
    workspaces: [
      { id: TEAM, name: "Team", kind: "shared" as const, member: true, actions: ["agent.read"] }
    ]
  };
  return {
    kinds: [{ kind: "agent", canCreate: false, canDelete: false }],
    rights: resolveBuildRights({ permissions }, context),
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: () => ({
      rows: listError === undefined ? rows : undefined,
      error: listError,
      hasMore: false,
      loadingMore: false,
      loadMore: noop,
      retry: noop
    }),
    useAsset: () => ({ status: "missing" }),
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
    scopeOf: () => scope,
    chooseScope: noop
  };
}

function renderList(
  input: {
    read?: ShippedGuardrailsRead;
    scope?: BuildScope;
    rows?: BuildAssetRow[];
    listError?: string;
  } = {},
  locale: "en" | "de" = "en"
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(
        BuildAssetKindsProvider,
        { value: [guardrailKind(input.read ?? ready([shipped]))] },
        createElement(
          BuildNavigationProvider,
          {
            value: {
              location: { kindPath: "guardrails" },
              open: noop,
              href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
            }
          },
          createElement(BuildFrame, {
            source: source(input.scope ?? { kind: "instance" }, input.rows ?? [], input.listError)
          })
        )
      )
    )
  );
}

/** The titles of the shipped rows that match a filter. */
function shippedTitles(filter: Partial<BuildListLeadFilter>, items = [shipped]): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" },
      createElement(ShippedGuardrailsLead, {
        read: ready(items),
        filter: { text: "", scope: undefined, ...filter },
        children: (lead) => lead.rows?.map((row) => row.title).join("|") ?? "loading"
      })
    )
  );
}

describe("the Guardrails list", () => {
  it("shows the shipped guardrail as a row of the list, under the search and the scope", () => {
    const markup = renderList();
    const search = markup.indexOf('aria-label="Search guardrails"');
    const scope = markup.indexOf('aria-label="Scope: Instance"');
    const list = markup.indexOf('aria-label="Guardrails"');
    expect(search).toBeGreaterThan(-1);
    expect(scope).toBeGreaterThan(search);
    expect(list).toBeGreaterThan(scope);

    const row = markup.slice(list);
    expect(row).toContain("Publishing needs an instance admin&#x27;s approval");
    expect(row).toContain("Shipped with the platform");
    expect(row).toContain("Needs approval");
    expect(row).toContain("On, as the platform ships it.");
    expect(row).toMatch(/role="switch"[^>]*aria-checked="true"/u);
    expect(row).not.toMatch(/<button[^>]*role="switch"[^>]* disabled=""/u);
    // One guardrail is in the list: it is not empty.
    expect(markup).not.toContain("Nothing in Instance yet.");
  });

  it("puts the shipped guardrail before the instance's own, in the same list", () => {
    const markup = renderList({ rows: [guardrail("privacy-check")] });
    const list = markup.slice(markup.indexOf('aria-label="Guardrails"'));
    expect(list.indexOf("Shipped with the platform")).toBeGreaterThan(-1);
    expect(list.indexOf("privacy-check")).toBeGreaterThan(
      list.indexOf("Shipped with the platform")
    );
    expect(markup.match(/aria-label="Guardrails"/gu)).toHaveLength(1);
  });

  it("keeps the shipped guardrail and its switch where the instance's own could not be read", () => {
    const markup = renderList({ listError: "The guardrails could not be loaded." });
    expect(markup).toContain("The guardrails could not be loaded.");
    const list = markup.slice(markup.indexOf('aria-label="Guardrails"'));
    expect(list).toContain("Shipped with the platform");
    expect(list).toMatch(/role="switch"[^>]*aria-checked="true"/u);
    // Without a shipped row the failed list shows its error alone, as before.
    const alone = renderList({ listError: "The guardrails could not be loaded.", read: ready([]) });
    expect(alone).toContain("The guardrails could not be loaded.");
    expect(alone).not.toContain('aria-label="Guardrails"');
    expect(alone).not.toContain("Nothing in Instance yet.");
  });

  it("is empty in a workspace, where the shipped guardrail does not apply", () => {
    const markup = renderList({ scope: { kind: "workspace", workspaceId: TEAM } });
    expect(markup).toContain("Nothing in Team yet.");
    expect(markup).not.toContain("Shipped with the platform");
  });

  it("reads in German", () => {
    const markup = renderList({}, "de");
    expect(markup).toContain("Veröffentlichen braucht die Freigabe eines Instanz-Admins");
    expect(markup).toContain("Mit der Plattform geliefert");
    expect(markup).toContain("Eingeschaltet, wie die Plattform sie liefert.");
  });

  it("says who switched it off and holds the switch for a reader who may not switch it", () => {
    const markup = renderList({
      read: ready([
        {
          ...shipped,
          enabled: false,
          canSwitch: false,
          switchedBy: { id: "usr_admin", label: "Ada Admin" },
          switchedAt: "2026-10-14T21:00:00.000Z"
        }
      ])
    });
    expect(markup).toMatch(/role="switch"[^>]*aria-checked="false"/u);
    expect(markup).toMatch(/<button[^>]*role="switch"[^>]* disabled=""/u);
    expect(markup).toContain("Switched off by Ada Admin");
    expect(markup).toContain("Only an instance admin can switch it.");
    expect(markup).toContain("makes a new version live with their own click");
  });

  it("waits for the shipped guardrails and says when they could not be read", () => {
    expect(renderList({ read: { status: "loading" } })).not.toContain('aria-label="Guardrails"');
    const failed = renderList({
      read: { status: "failed", message: undefined, retry: noop }
    });
    expect(failed).toContain("The guardrails of the platform could not be loaded.");
  });
});

describe("which shipped guardrails the list shows", () => {
  it("matches the search on the title or the name, whatever the case", () => {
    expect(shippedTitles({ text: "PUBLISHING" })).toBe(
      "Publishing needs an instance admin&#x27;s approval"
    );
    expect(shippedTitles({ text: "needs-approval" })).toBe(
      "Publishing needs an instance admin&#x27;s approval"
    );
    expect(shippedTitles({ text: "privacy" })).toBe("");
  });

  it("shows them in the instance's scope alone", () => {
    expect(shippedTitles({ scope: { kind: "instance" } })).not.toBe("");
    expect(shippedTitles({ scope: { kind: "workspace", workspaceId: TEAM } })).toBe("");
  });
});
