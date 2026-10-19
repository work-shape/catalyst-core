// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  resolveBuildRights,
  type BuildSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { SettingsPageProvider } from "@work-shape/catalyst-chat-ui/settings-page-context";
import { DocsAddressProvider, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { platformContext } from "./chat-ui-build-fixtures";
import { buildPageSettings } from "./chat-ui-build-page-harness";
import { TranslationProvider } from "./chat-ui-render-harness";
import { CONDITION_WAIT_MS, required } from "./support/assertions";

// ACCEPT-2d E-1: creating an agent that starts available in a workspace lists what it uses that
// members there could not use, and offers to make it available, as publishing a draft and
// saving its availability do. Nothing is written until the reader answers; the choice starts
// unticked. C-1: the list names the workspace it was read for.

const validatePath = apiOperations["assets.validate"].path.replace(":kind", "agent");
const sales = { id: "ws_sales", name: "Sales" };
const contracts = {
  kind: "knowledge_base" as const,
  name: "kb_contracts",
  displayName: "Contracts",
  canMakeAvailable: true
};

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

type Put = Parameters<BuildSource["writes"]["put"]>[0];

/**
 * Build's agent list in the shared workspace Sales. The instance answers the check before a
 * create with `missing`; every create is recorded and answered as made.
 */
const inSales = {
  mode: "selected" as const,
  personalWorkspaces: false,
  collaborationWorkspaceIds: [sales.id]
};
const hidden = {
  mode: "selected" as const,
  personalWorkspaces: false,
  collaborationWorkspaceIds: []
};
const everywhere = {
  mode: "all" as const,
  personalWorkspaces: false,
  collaborationWorkspaceIds: []
};

async function mountAgents(
  missing: (typeof contracts)[],
  /** Where the instance says it read the list for: the instance's first agent starts everywhere. */
  readFor: typeof inSales | typeof everywhere | typeof hidden = inSales,
  options: {
    /** Where Build is opened: in Sales, or with no workspace, where a new agent starts hidden. */
    workspace?: typeof sales | undefined;
    /** The check is refused, as a timeout or a missing right would be. */
    checkRefused?: boolean;
    /** The check answers without the list: valid, or with an issue of the definition. */
    answerWithoutList?: "valid" | "invalid";
  } = { workspace: sales }
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const checks: unknown[] = [];
  const puts: Put[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === validatePath) {
      checks.push(await request.json());
      if (options.checkRefused) {
        return Response.json(
          { error: { code: "FORBIDDEN", message: "Not allowed" } },
          { status: 403 }
        );
      }
      if (options.answerWithoutList === "valid") {
        return Response.json({ valid: true, issues: [] });
      }
      if (options.answerWithoutList === "invalid") {
        return Response.json({
          valid: false,
          issues: [{ message: "Instructions are too long", path: ["instructions"] }]
        });
      }
      return Response.json({
        valid: true,
        issues: [],
        dependencyAvailability: { missing, administrators: [], availability: readFor }
      });
    }
    if (url.pathname === apiOperations["platform.context.get"].path) {
      return Response.json(platformContext());
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
  };
  const source: BuildSource = {
    kinds: [{ kind: "agent", canCreate: true, canDelete: true }],
    rights: resolveBuildRights({ permissions: ["config_assets.write"] }, platformContext()),
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: () => ({
      rows: [],
      error: undefined,
      hasMore: false,
      loadingMore: false,
      loadMore: () => undefined,
      retry: () => undefined
    }),
    useAsset: () => ({ status: "missing", reload: async () => "missing" }),
    exists: async () => false,
    checkName: async () => ({ available: true }),
    writes: {
      put: async (input) => {
        puts.push(input);
        return { revision: 1 };
      },
      readFiles: async () => [],
      delete: async () => undefined,
      publish: async () => ({ draftRevision: 1, publishedRevision: 1 }),
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    }
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  const mounted = createRoot(host);
  root = mounted;
  await act(async () => {
    mounted.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          SettingsPageProvider,
          { value: buildPageSettings(fetchImpl, undefined, ["displayName", "instructions"]) },
          createElement(
            UiRoot,
            { mode: "light", labels: uiLabelsEn },
            createElement(
              TranslationProvider,
              { locale: "en", children: null },
              createElement(
                DocsAddressProvider,
                { address: undefined, children: null },
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
                    createElement(BuildFrame, {
                      source,
                      ...(options.workspace ? { workspace: options.workspace } : {})
                    })
                  )
                )
              )
            )
          )
        )
      )
    );
  });
  return { checks, puts };
}

function button(text: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

/** Types into a field as React hears it. */
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const openDialog = () => document.querySelector<HTMLDialogElement>("dialog[open]");
const missingBanner = () => document.querySelector("[data-missing-dependencies]");

/** New agent, named "Helper", Continue, its system prompt, then the page's Create agent. */
async function startAndCreate() {
  await click(button("New agent"));
  const dialog = await vi.waitFor(() => required(openDialog()), { timeout: CONDITION_WAIT_MS });
  await type(required(dialog.querySelector<HTMLInputElement>("input")), "Helper");
  await click(button("Continue", dialog));
  const prompt = await vi.waitFor(
    () =>
      required(
        document.querySelector<HTMLTextAreaElement>("form textarea.font-mono, form textarea")
      ),
    { timeout: CONDITION_WAIT_MS }
  );
  await type(prompt, "You help the team.");
  await click(await vi.waitFor(() => button("Create agent"), { timeout: CONDITION_WAIT_MS }));
}

describe("creating an agent that starts available in a workspace", () => {
  it("checks the definition where it starts, and writes nothing before the reader answers", async () => {
    const page = await mountAgents([contracts]);
    await startAndCreate();

    const dialog = await vi.waitFor(() => required(openDialog()), { timeout: CONDITION_WAIT_MS });
    expect(page.checks).toEqual([
      {
        config: expect.objectContaining({ name: "helper" }),
        availability: inSales
      }
    ]);
    expect(page.puts).toEqual([]);
    expect(dialog.textContent).toContain("Create Helper?");
    const banner = required(missingBanner());
    expect(banner.querySelector("[data-missing-dependencies-text]")?.textContent).toBe(
      "Members in Sales cannot use:"
    );
    expect([...banner.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Contracts (knowledge base)"
    ]);
    const box = required(banner.querySelector<HTMLButtonElement>('button[role="checkbox"]'));
    expect(box.getAttribute("aria-checked")).toBe("false");
  });

  it("creates the agent with the reader's choice to make what it uses available there", async () => {
    const page = await mountAgents([contracts]);
    await startAndCreate();
    const dialog = await vi.waitFor(() => required(openDialog()), { timeout: CONDITION_WAIT_MS });
    await click(
      required(missingBanner()?.querySelector<HTMLButtonElement>('button[role="checkbox"]'))
    );
    await click(button("Create agent", dialog));

    await vi.waitFor(() => expect(page.puts).toHaveLength(1), { timeout: CONDITION_WAIT_MS });
    expect(page.puts[0]).toMatchObject({
      kind: "agent",
      name: "helper",
      expectedRevision: null,
      availableIn: { workspaceId: sales.id },
      // The choice holds for the availability the dialog named, and the instance refuses it
      // for any other.
      dependencyConsent: { expectedAvailability: inSales }
    });
  });

  it("holds the choice for where the instance read the list, when that is everywhere", async () => {
    const page = await mountAgents([contracts], everywhere);
    await startAndCreate();
    const dialog = await vi.waitFor(() => required(openDialog()), { timeout: CONDITION_WAIT_MS });
    // Everywhere names no workspace.
    expect(missingBanner()?.querySelector("[data-missing-dependencies-text]")?.textContent).toBe(
      "Members in some of this agent's workspaces cannot use:"
    );
    await click(
      required(missingBanner()?.querySelector<HTMLButtonElement>('button[role="checkbox"]'))
    );
    await click(button("Create agent", dialog));

    await vi.waitFor(() => expect(page.puts).toHaveLength(1), { timeout: CONDITION_WAIT_MS });
    expect(page.puts[0]).toMatchObject({ dependencyConsent: { expectedAvailability: everywhere } });
  });

  it("creates it without making anything available when the choice stays unticked", async () => {
    const page = await mountAgents([contracts]);
    await startAndCreate();
    const dialog = await vi.waitFor(() => required(openDialog()), { timeout: CONDITION_WAIT_MS });
    await click(button("Create agent", dialog));

    await vi.waitFor(() => expect(page.puts).toHaveLength(1), { timeout: CONDITION_WAIT_MS });
    expect(page.puts[0]).not.toHaveProperty("dependencyConsent");
  });

  it("writes nothing when the reader cancels", async () => {
    const page = await mountAgents([contracts]);
    await startAndCreate();
    const dialog = await vi.waitFor(() => required(openDialog()), { timeout: CONDITION_WAIT_MS });
    await click(button("Cancel", dialog));

    await vi.waitFor(() => expect(openDialog()).toBeNull(), { timeout: CONDITION_WAIT_MS });
    expect(page.puts).toEqual([]);
  });

  it("creates at once where nothing it uses is missing", async () => {
    const page = await mountAgents([]);
    await startAndCreate();

    await vi.waitFor(() => expect(page.puts).toHaveLength(1), { timeout: CONDITION_WAIT_MS });
    expect(page.checks).toHaveLength(1);
    expect(openDialog()).toBeNull();
  });

  it("keeps the form and creates nothing when the check fails", async () => {
    const page = await mountAgents([contracts], inSales, { workspace: sales, checkRefused: true });
    await startAndCreate();

    await vi.waitFor(
      () =>
        expect(document.body.textContent).toContain(
          "Could not check what this agent uses where it will be available. Nothing was created. Try again."
        ),
      { timeout: CONDITION_WAIT_MS }
    );
    expect(page.checks).toHaveLength(1);
    expect(page.puts).toEqual([]);
    expect(openDialog()).toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>("form textarea")?.value).toBe(
      "You help the team."
    );
  });

  // A valid answer that leaves out what is missing told nothing: the create waits.
  it("keeps the form and creates nothing when a valid check leaves out the list", async () => {
    const page = await mountAgents([contracts], inSales, {
      workspace: sales,
      answerWithoutList: "valid"
    });
    await startAndCreate();

    await vi.waitFor(
      () =>
        expect(document.body.textContent).toContain(
          "Could not check what this agent uses where it will be available. Nothing was created. Try again."
        ),
      { timeout: CONDITION_WAIT_MS }
    );
    expect(page.checks).toHaveLength(1);
    expect(page.puts).toEqual([]);
    expect(openDialog()).toBeNull();
  });

  // A definition that does not validate goes on to the create, whose refusal names the issue.
  it("goes on to the create when the check finds the definition invalid", async () => {
    const page = await mountAgents([contracts], inSales, {
      workspace: sales,
      answerWithoutList: "invalid"
    });
    await startAndCreate();

    await vi.waitFor(() => expect(page.puts).toHaveLength(1), { timeout: CONDITION_WAIT_MS });
    expect(document.body.textContent).not.toContain("Could not check what this agent uses");
  });

  // The instance's first agent becomes its default, available everywhere, even when the create
  // dialog left it hidden: the check is made and the choice holds for everywhere.
  it("checks a new agent that starts hidden, and holds the choice where the instance reads it", async () => {
    const page = await mountAgents([contracts], everywhere, { workspace: undefined });
    await startAndCreate();
    const dialog = await vi.waitFor(() => required(openDialog()), { timeout: CONDITION_WAIT_MS });
    expect(page.checks).toEqual([
      { config: expect.objectContaining({ name: "helper" }), availability: hidden }
    ]);
    await click(
      required(missingBanner()?.querySelector<HTMLButtonElement>('button[role="checkbox"]'))
    );
    await click(button("Create agent", dialog));

    await vi.waitFor(() => expect(page.puts).toHaveLength(1), { timeout: CONDITION_WAIT_MS });
    expect(page.puts[0]).toMatchObject({ dependencyConsent: { expectedAvailability: everywhere } });
    expect(page.puts[0]).not.toHaveProperty("availableIn");
  });
});
