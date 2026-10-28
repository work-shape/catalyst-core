// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
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
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { instanceActions, platformContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { required } from "./support/assertions";

// Build > Guardrails: the guardrail the platform ships is the first row of the one list, under
// its search and scope, with its switch and its state line (GR-PUB-1). The list says it is
// empty only where nothing, the shipped guardrail included, is in it.

const TEAM = "cws_team";
const noop = () => undefined;

const shipped: ShippedGuardrailView = {
  name: "publishing-needs-approval",
  displayName: "Publishing needs approval from an admin for all workspaces",
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

type ListInput = {
  read?: ShippedGuardrailsRead;
  scope?: BuildScope;
  rows?: BuildAssetRow[];
  listError?: string;
};

/** The Guardrails list in the frame, its shipped rows read from `input.read`. */
function listElement(input: ListInput = {}) {
  return createElement(
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
  );
}

function renderList(input: ListInput = {}, locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    createElement(TranslationProvider, { children: null, locale }, listElement(input))
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
    const scope = markup.indexOf('aria-label="Where: Everyone"');
    const list = markup.indexOf('aria-label="Guardrails"');
    expect(search).toBeGreaterThan(-1);
    expect(scope).toBeGreaterThan(search);
    expect(list).toBeGreaterThan(scope);

    const row = markup.slice(list);
    expect(row).toContain("Publishing needs approval from an admin for all workspaces");
    expect(row).toContain("Shipped with the platform");
    expect(row).toContain("Needs approval");
    expect(row).toContain("On, as the platform ships it.");
    expect(row).toMatch(/role="switch"[^>]*aria-checked="true"/u);
    expect(row).not.toMatch(/<button[^>]*role="switch"[^>]* disabled=""/u);
    // One guardrail is in the list: it is not empty.
    expect(markup).not.toContain("Nothing under “Everyone” yet.");
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
    expect(alone).not.toContain("Nothing under “Everyone” yet.");
  });

  it("is empty in a workspace, where the shipped guardrail does not apply", () => {
    const markup = renderList({ scope: { kind: "workspace", workspaceId: TEAM } });
    expect(markup).toContain("Nothing under “Team” yet.");
    expect(markup).not.toContain("Shipped with the platform");
  });

  it("reads in German", () => {
    const markup = renderList({}, "de");
    expect(markup).toContain(
      "Veröffentlichen braucht die Freigabe eines Admins für alle Arbeitsbereiche"
    );
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
    expect(markup).toContain("Only an admin for all workspaces can switch it.");
    expect(markup).toContain("makes a new version live with their own click");
  });

  // ERASE-ACTOR-IDS: the account deletion empties the name of who switched it.
  it("names who switched it as a deleted account once their account is gone", () => {
    const read = ready([
      {
        ...shipped,
        enabled: false,
        switchedBy: { id: "usr_gone", label: "" },
        switchedAt: "2026-10-14T21:00:00.000Z"
      }
    ]);
    expect(renderList({ read })).toContain("Switched off by Deleted account");
    expect(renderList({ read }, "de")).toContain("Gelöschtes Konto");
    expect(renderList({ read })).not.toContain("usr_gone");
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
      "Publishing needs approval from an admin for all workspaces"
    );
    expect(shippedTitles({ text: "needs-approval" })).toBe(
      "Publishing needs approval from an admin for all workspaces"
    );
    expect(shippedTitles({ text: "privacy" })).toBe("");
  });

  it("shows them in the instance's scope alone", () => {
    expect(shippedTitles({ scope: { kind: "instance" } })).not.toBe("");
    expect(shippedTitles({ scope: { kind: "workspace", workspaceId: TEAM } })).toBe("");
  });
});

// Replaces e2e/guardrails.spec.ts "Studio shows the guardrail the platform ships, on, and asks
// before it is switched off": a click on the shipped guardrail's switch asks first, and Cancel
// leaves it on without asking the instance to switch it.
describe("switching off the shipped guardrail", () => {
  it("asks first, and Cancel keeps it on", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const switched: [string, boolean][] = [];
    const read: ShippedGuardrailsRead = {
      status: "ready",
      items: [shipped],
      switching: undefined,
      switchTo: async (name, enabled) => {
        switched.push([name, enabled]);
        return undefined;
      }
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          createElement(
            TranslationProvider,
            { children: null, locale: "en" },
            createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, listElement({ read }))
          )
        )
      );
      const toggle = required(document.querySelector<HTMLButtonElement>('[role="switch"]'));
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      await act(async () => toggle.click());

      const asked = required(document.querySelector<HTMLElement>("dialog[open]"));
      expect(asked.textContent).toContain(
        "Switch off “Publishing needs approval from an admin for all workspaces”?"
      );
      expect(asked.textContent).toContain("no admin is asked");
      expect(switched).toEqual([]);

      const cancel = required(
        [...asked.querySelectorAll("button")].find((button) => button.textContent === "Cancel")
      );
      await act(async () => cancel.click());
      expect(document.querySelector("dialog[open]")).toBeNull();
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(switched).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
