// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  readLastBuildScope,
  showOwnerInStudio,
  storeListsEveryOwner,
  useBuildSource,
  type BuildLocation
} from "@work-shape/catalyst-chat-ui/build-area";
import { SettingsPageProvider } from "@work-shape/catalyst-chat-ui/settings-page-context";
import { DocsAddressProvider, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { instanceActions, platformContext } from "./chat-ui-build-fixtures";
import { buildPageSettings, listedKind } from "./chat-ui-build-page-harness";
import { TranslationProvider } from "./chat-ui-render-harness";
import { settingsUser } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS } from "./support/assertions";

// An admin read "Alle" in Studio's "Wo" as every owner and missed an agent a workspace owned
// (fix/studio-where-filter). Every list of a kind a workspace can own now starts on
// "Everywhere": what each owner offered holds, in one read, each row with its owner. "Wo"
// narrows it to one owner, and names the instance "For everyone". Opening a row of another
// owner sets Studio to that owner, so its page reads it there; the list stays as wide as it was.

const PERSONAL = "cw_personal";
const STORAGE_KEY = "vivd-catalyst:build-scope";
const permissions = ["config_assets.read", "config_assets.write"];

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  storeListsEveryOwner(true);
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function skill(name: string, workspaceId: string | undefined) {
  return {
    id: `asset_${name}`,
    kind: "skill",
    name,
    title: name,
    scope: workspaceId === undefined ? { kind: "instance" } : { kind: "workspace", workspaceId },
    revision: 1,
    draftRevision: 1,
    publishedRevision: 1,
    updatedAt: "2026-10-18T09:00:00.000Z"
  };
}

/**
 * Studio's Skills list for a reader of the instance's skills and of their Personal Workspace's.
 * `held` gives the skills each owner holds; every list read is recorded as owner and page size.
 */
async function mountSkills(
  held: { instance: string[]; personal: string[] },
  /** The list Studio opens on. */
  startOn: "skills" | "agents" = "skills",
  options: {
    /** The instance's agents; the Personal Workspace holds none. */
    agents?: string[];
    /** The skill whose page Studio opens on, by its address alone. */
    open?: string;
  } = {}
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  /** Each list read, as the owners it named. */
  const reads: string[] = [];
  const agentReads: string[] = [];
  const context = {
    ...platformContext([], instanceActions(permissions)),
    workspaces: [
      {
        id: PERSONAL,
        name: "Felix Pahlke",
        kind: "personal" as const,
        member: true,
        actions: ["skill.read", "skill.write", "agent.read", "agent.write"]
      }
    ]
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === apiOperations["platform.context.get"].path) {
      return Response.json(context);
    }
    if (listedKind(request, url) === "agent") {
      const owners = ownersOf(url);
      agentReads.push(owners.join(","));
      const names = owners.includes("instance") ? (options.agents ?? []) : [];
      return Response.json({
        items: names.map((name) => ({ ...skill(name, undefined), kind: "agent" }))
      });
    }
    const asset = /^\/api\/v1\/assets\/skill\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && asset) {
      const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
      const names = workspaceId === PERSONAL ? held.personal : held.instance;
      return names.includes(asset[1] ?? "")
        ? Response.json({
            ...skill(asset[1] ?? "", workspaceId),
            config: { name: asset[1], description: "Notes", instructions: "Write notes." }
          })
        : Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
    }
    if (listedKind(request, url) === "skill") {
      const owners = ownersOf(url);
      reads.push(owners.join(","));
      const items = [
        ...(owners.includes("instance") ? held.instance.map((name) => skill(name, undefined)) : []),
        ...(owners.includes(PERSONAL) ? held.personal.map((name) => skill(name, PERSONAL)) : [])
      ].toSorted((one, other) => one.name.localeCompare(other.name));
      return Response.json({ items });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
  };
  function Studio() {
    return createElement(BuildFrame, { source: useBuildSource() });
  }
  let go: (place: BuildLocation) => void = () => undefined;
  function Navigated() {
    const [location, setLocation] = useState<BuildLocation>({
      kindPath: startOn,
      ...(options.open ? { name: options.open } : {})
    });
    go = setLocation;
    return createElement(
      BuildNavigationProvider,
      {
        value: {
          location,
          open: (place) => setLocation(place),
          href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
        }
      },
      createElement(Studio)
    );
  }
  const settings = buildPageSettings(fetchImpl, settingsUser({ permissions }));
  const configAssets = { ...settings.config.features.configAssets, allowAgentCreation: true };
  const features = { ...settings.config.features, configAssets };
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
          { value: { ...settings, config: { ...settings.config, features } } },
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
                  createElement(Navigated)
                )
              )
            )
          )
        )
      )
    );
  });
  return {
    reads,
    agentReads,
    go: (kindPath: string) => act(async () => go({ kindPath }))
  };
}

/** Picks an owner in the list's scope picker. */
async function pickScope(label: string) {
  await act(async () => scopeButton()?.click());
  const option = await vi.waitFor(
    () => {
      const row = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
        (item) => item.textContent === label
      );
      if (!row) throw new Error(`no ${label} option`);
      return row;
    },
    { timeout: CONDITION_WAIT_MS }
  );
  await act(async () => option.click());
}

async function until(check: () => void): Promise<void> {
  await vi.waitFor(
    async () => {
      await act(async () => undefined);
      check();
    },
    { timeout: CONDITION_WAIT_MS }
  );
}

const scopeButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label^="Where: "]');
const shown = (name: string) => document.body.textContent?.includes(name) ?? false;

/** The owners a list read names: `owners`, or the one owner it names. */
function ownersOf(url: URL): string[] {
  const owners = url.searchParams.get("owners");
  if (owners !== null) return owners.split(",");
  return [url.searchParams.get("workspaceId") ?? "instance"];
}

describe("a Studio list of a kind a workspace can own", () => {
  it("starts on Everywhere: every owner offered, in one read, each row with its owner", async () => {
    // An earlier visit kept the instance; that narrows nothing.
    window.localStorage.setItem(STORAGE_KEY, "instance");
    const page = await mountSkills({ instance: ["house-style"], personal: ["my-notes"] });

    await until(() => expect(scopeButton()?.getAttribute("aria-label")).toBe("Where: Everywhere"));
    await until(() => expect(shown("my-notes")).toBe(true));
    expect(shown("house-style")).toBe(true);
    expect(page.reads).toEqual([`instance,${PERSONAL}`]);
    // Each row names its owner in the ladder's words.
    const row = (name: string) =>
      document.querySelector(`a[href$="/${name}"]`)?.closest("li")?.textContent ?? "";
    expect(row("house-style")).toContain("Everyone");
    expect(row("my-notes")).toContain("Only me");
  });

  it("narrows to each owner Wo offers, and widens again", async () => {
    const page = await mountSkills({ instance: ["house-style"], personal: ["my-notes"] });
    await until(() => expect(shown("my-notes")).toBe(true));

    await pickScope("Only me");
    await until(() => expect(scopeButton()?.getAttribute("aria-label")).toBe("Where: Only me"));
    await until(() => expect(shown("house-style")).toBe(false));
    expect(shown("my-notes")).toBe(true);
    expect(readLastBuildScope()).toBe(PERSONAL);

    await pickScope("For everyone");
    await until(() =>
      expect(scopeButton()?.getAttribute("aria-label")).toBe("Where: For everyone")
    );
    await until(() => expect(shown("my-notes")).toBe(false));
    expect(shown("house-style")).toBe(true);

    await pickScope("Everywhere");
    await until(() => expect(shown("my-notes")).toBe(true));
    expect(shown("house-style")).toBe(true);
    expect(new Set(page.reads)).toEqual(new Set([`instance,${PERSONAL}`, PERSONAL, "instance"]));
  });

  it("is narrowed for every list at once, and Agents lists every owner as well", async () => {
    const page = await mountSkills({ instance: ["house-style"], personal: [] }, "agents", {
      agents: ["helper"]
    });
    await until(() => expect(shown("helper")).toBe(true));
    expect(page.agentReads).toEqual([`instance,${PERSONAL}`]);
    await pickScope("Only me");
    await until(() => expect(page.agentReads).toContain(PERSONAL));

    await page.go("skills");
    await until(() => expect(scopeButton()?.getAttribute("aria-label")).toBe("Where: Only me"));
    expect(page.reads).toEqual([PERSONAL]);
    expect(shown("house-style")).toBe(false);
  });

  it("opens a row of another owner with Studio set to it, and stays on Everywhere", async () => {
    showOwnerInStudio(undefined);
    const page = await mountSkills({ instance: ["house-style"], personal: ["my-notes"] });
    await until(() => expect(shown("my-notes")).toBe(true));

    const link = document.querySelector<HTMLAnchorElement>('a[href$="/my-notes"]');
    await act(async () => link?.click());

    expect(readLastBuildScope()).toBe(PERSONAL);
    await page.go("skills");
    await until(() => expect(scopeButton()?.getAttribute("aria-label")).toBe("Where: Everywhere"));
    expect(shown("house-style")).toBe(true);
  });
});

describe("an owner Studio is taken to", () => {
  /** Studio's state as a reload finds it: the module read anew from what the browser kept. */
  async function reloaded() {
    vi.resetModules();
    const fresh = await import("@work-shape/catalyst-chat-ui/build-area");
    return fresh.readLastBuildScope();
  }

  it("on the way to an asset's page is remembered across a reload", async () => {
    window.localStorage.setItem(STORAGE_KEY, "instance");
    showOwnerInStudio(PERSONAL);
    expect(readLastBuildScope()).toBe(PERSONAL);
    expect(await reloaded()).toBe(PERSONAL);
  });

  it("where the page found its asset in another owner is remembered across a reload", async () => {
    showOwnerInStudio(undefined);
    await mountSkills({ instance: [], personal: ["my-notes"] }, "skills", { open: "my-notes" });

    await until(() => expect(window.localStorage.getItem(STORAGE_KEY)).toBe(PERSONAL));
    expect(await reloaded()).toBe(PERSONAL);
  });
});
