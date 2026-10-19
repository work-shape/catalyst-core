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
  useBuildSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { SettingsPageProvider } from "@work-shape/catalyst-chat-ui/settings-page-context";
import { DocsAddressProvider, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { instanceActions, platformContext } from "./chat-ui-build-fixtures";
import { buildPageSettings, listedKind } from "./chat-ui-build-page-harness";
import { TranslationProvider } from "./chat-ui-render-harness";
import { settingsUser } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS } from "./support/assertions";

// ACCEPT-2d C-5: Mara opened Skills on "Personal", empty, because an asset she had opened there
// once had set Studio's owner for good. A list now opens on the owner Studio is set to when that
// has some of the kind, otherwise on the first owner offered that has; a pick of the reader's is
// kept, and an owner Studio was only taken to is not kept for the next visit.

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
  startOn: "skills" | "agents" = "skills"
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const reads: { owner: string; limit: string | null }[] = [];
  const context = {
    ...platformContext([], instanceActions(permissions)),
    workspaces: [
      {
        id: PERSONAL,
        name: "Felix Pahlke",
        kind: "personal" as const,
        member: true,
        actions: ["skill.read", "skill.write"]
      }
    ]
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === apiOperations["platform.context.get"].path) {
      return Response.json(context);
    }
    if (listedKind(request, url) === "agent") return Response.json({ items: [] });
    if (listedKind(request, url) === "skill") {
      const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
      reads.push({ owner: workspaceId ?? "instance", limit: url.searchParams.get("limit") });
      const names = workspaceId === PERSONAL ? held.personal : held.instance;
      return Response.json({ items: names.map((name) => skill(name, workspaceId)) });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
  };
  function Studio() {
    return createElement(BuildFrame, { source: useBuildSource() });
  }
  let go: (kindPath: string) => void = () => undefined;
  function Navigated() {
    const [kindPath, setKindPath] = useState<string>(startOn);
    go = setKindPath;
    return createElement(
      BuildNavigationProvider,
      {
        value: {
          location: { kindPath },
          open: () => undefined,
          href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
        }
      },
      createElement(Studio)
    );
  }
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
          { value: buildPageSettings(fetchImpl, settingsUser({ permissions })) },
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
  return { reads, go: (kindPath: string) => act(async () => go(kindPath)) };
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
  document.querySelector<HTMLButtonElement>('button[aria-label^="Scope: "]');
const shown = (name: string) => document.body.textContent?.includes(name) ?? false;
/** The reads of a page of the list, not the look whether an owner has any. */
const pageReads = (reads: { owner: string; limit: string | null }[]) =>
  reads.filter((read) => read.limit !== "1").map((read) => read.owner);

describe("the owner Studio's Skills list opens on", () => {
  it("is the instance, with its skills, when the Personal Workspace kept from before has none", async () => {
    // An earlier visit kept the Personal Workspace, which has no skills.
    window.localStorage.setItem(STORAGE_KEY, PERSONAL);
    const page = await mountSkills({ instance: ["house-style"], personal: [] });

    await until(() => expect(scopeButton()?.getAttribute("aria-label")).toBe("Scope: Instance"));
    await until(() => expect(shown("house-style")).toBe(true));
    // The empty list of the Personal Workspace was never read, so it never showed.
    expect(pageReads(page.reads)).toEqual(["instance"]);
  });

  it("stays the owner Studio is set to when that has some", async () => {
    showOwnerInStudio(PERSONAL);
    const page = await mountSkills({ instance: ["house-style"], personal: ["my-notes"] });

    await until(() => expect(shown("my-notes")).toBe(true));
    expect(scopeButton()?.getAttribute("aria-label")).toBe("Scope: Personal");
    expect(pageReads(page.reads)).toEqual([PERSONAL]);
  });

  it("is kept as the reader picks it, even where that owner has none", async () => {
    showOwnerInStudio(undefined);
    const page = await mountSkills({ instance: ["house-style"], personal: [] });
    await until(() => expect(shown("house-style")).toBe(true));

    await pickScope("Personal");

    await until(() => expect(scopeButton()?.getAttribute("aria-label")).toBe("Scope: Personal"));
    await until(() => expect(pageReads(page.reads)).toContain(PERSONAL));
    // Nothing moves the reader off the empty owner they chose.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(scopeButton()?.getAttribute("aria-label")).toBe("Scope: Personal");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(PERSONAL);
  });

  it("is the reader's pick on another list, when Skills opens after it", async () => {
    showOwnerInStudio(undefined);
    const page = await mountSkills({ instance: ["house-style"], personal: [] }, "agents");
    await until(() => expect(scopeButton()?.getAttribute("aria-label")).toBe("Scope: Instance"));
    await pickScope("Personal");
    await until(() => expect(scopeButton()?.getAttribute("aria-label")).toBe("Scope: Personal"));

    await page.go("skills");
    await until(() => expect(pageReads(page.reads)).toContain(PERSONAL));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(scopeButton()?.getAttribute("aria-label")).toBe("Scope: Personal");
    expect(shown("house-style")).toBe(false);
  });

  it("is not kept for the next visit when Studio was only taken to an owner", () => {
    window.localStorage.setItem(STORAGE_KEY, "instance");
    showOwnerInStudio(PERSONAL);
    expect(readLastBuildScope()).toBe(PERSONAL);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("instance");
  });
});
