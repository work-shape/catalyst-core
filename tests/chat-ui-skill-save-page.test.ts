// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDraft, AssetScope } from "@work-shape/catalyst-api-client";
import { DocsAddressProvider, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  isEditableKind,
  resolveBuildRights,
  SkillEditor,
  skillConfigToForm,
  type AgentDraftSource,
  type BuildAsset,
  type BuildAssetEditorProps,
  type BuildSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { instanceActions, platformContext } from "./chat-ui-build-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";

// SKILL-LIVE-1: the page of a skill saves a new live revision, with no draft and no Publish. A
// reader who holds `skill.write` alone submits the change for approval, and the form goes back to
// what is live. A draft from before stands read-only until it is published or discarded.

const LIVE_REVISION = 2;
const live = {
  name: "form-filler",
  title: "Form filler",
  description: "Use when a customer form has to be filled from a case.",
  content: "Fill the form."
};

const skillEntry = editableSkillKind();

function editableSkillKind() {
  const entry = buildAssetKinds.find((candidate) => candidate.kind === "skill");
  if (!entry || !isEditableKind(entry)) throw new Error("The platform registry has no skill.");
  return entry;
}

/** The instance the page writes to: a write is live, or filed where `files` says so. */
function instance(options: { files?: boolean; draft?: AgentDraft } = {}) {
  const state: { draft: AgentDraft | null } = { draft: options.draft ?? null };
  const puts: { expectedRevision: number | null; expectedDraftRevision?: number | null }[] = [];
  return {
    state,
    puts,
    async put(input: {
      config?: Record<string, unknown>;
      expectedRevision: number | null;
      expectedDraftRevision?: number | null;
    }) {
      puts.push({
        expectedRevision: input.expectedRevision,
        expectedDraftRevision: input.expectedDraftRevision
      });
      return options.files
        ? { revision: LIVE_REVISION, approvalRequestId: "apr_filed" }
        : { revision: LIVE_REVISION + 1 };
    }
  };
}

const oldDraft: AgentDraft = {
  agent: "form-filler",
  revision: 4,
  baseRevision: LIVE_REVISION,
  liveRevision: LIVE_REVISION,
  stale: false,
  config: { ...live, summary: "An old draft's summary." },
  author: { userId: "user_me", name: "Me", release: false },
  updatedAt: "2026-10-28T09:30:00.000Z"
};

type Instance = ReturnType<typeof instance>;

/** What the frame handed the page: whether its saves write a shared draft. */
const seen: { shared?: boolean } = {};

/** The skill page with a draft source that reads the test's instance, where it has a draft. */
function DraftedSkill({ frame, world }: { frame: BuildAssetEditorProps; world: Instance }) {
  const [latest, setLatest] = useState(world.state.draft);
  seen.shared = frame.draft?.shared;
  const draft: AgentDraftSource = {
    latest,
    reread: async () => setLatest(world.state.draft),
    saved: () => {
      throw new Error("A skill's save writes no draft.");
    },
    decide: async () => undefined,
    busy: undefined,
    answerFor: () => undefined
  };
  return createElement(SkillEditor, {
    frame,
    initialForm: skillConfigToForm(latest?.config ?? live),
    editable: true,
    ...(frame.draft?.shared ? { draft } : {})
  });
}

function buildSource(world: Instance, scope: AssetScope, allowed: BuildAsset["allowed"]) {
  const permissions = ["config_assets.read", "config_assets.write"];
  const context = platformContext(
    [{ id: "ws-mine", name: "Mine", kind: "personal", member: true, actions: ["skill.write"] }],
    instanceActions(permissions)
  );
  const rights = resolveBuildRights({ permissions }, context);
  const asset: BuildAsset = {
    allowed,
    id: "asset_form_filler",
    kind: "skill",
    name: "form-filler",
    scope,
    revision: LIVE_REVISION,
    config: live,
    updatedAt: "2026-10-28T01:00:00.000Z"
  };
  const source: BuildSource = {
    kinds: [{ kind: "skill", canCreate: true, canDelete: true }],
    rights,
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
    useAsset: () => ({ status: "ready", asset, loadedAt: 1, reload: async () => "loaded" }),
    exists: async () => true,
    checkName: async () => ({ available: true }),
    writes: {
      put: (input) => world.put(input),
      readFiles: async () => [],
      delete: async () => undefined,
      publish: async () => ({ draftRevision: 1, publishedRevision: 1 }),
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    }
  };
  return source;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  delete seen.shared;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function mount(
  world: Instance,
  scope: AssetScope = { kind: "instance" },
  allowed: BuildAsset["allowed"] = ["write"]
) {
  const kind = {
    ...skillEntry,
    Editor: (frame: BuildAssetEditorProps) => createElement(DraftedSkill, { frame, world })
  };
  act(() =>
    root.render(
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
              { value: [kind] },
              createElement(
                BuildNavigationProvider,
                {
                  value: {
                    location: { kindPath: "skills", name: "form-filler" },
                    open: () => undefined,
                    href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
                  }
                },
                createElement(BuildFrame, { source: buildSource(world, scope, allowed) })
              )
            )
          )
        )
      )
    )
  );
}

async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function typeSummary(value: string) {
  const field = [...host.querySelectorAll("input")].find(
    (candidate) => candidate.getAttribute("maxlength") !== null
  );
  if (!(field instanceof HTMLInputElement)) throw new Error(`no summary: ${host.innerHTML}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!found) throw new Error(`no button "${text}": ${host.innerHTML}`);
  return found;
}

const publish = () => host.querySelector<HTMLButtonElement>("[data-skill-publish]");
const noDraft = () => {
  expect(publish()).toBeNull();
  expect(host.querySelector('[data-asset-status="draft"]')).toBeNull();
};
const summary = () =>
  [...host.querySelectorAll("input")].find(
    (candidate) => candidate.getAttribute("maxlength") !== null
  )?.value;

describe("the page of a skill a team or the instance owns", () => {
  it("saves a live revision for a holder of the publish right, with no draft to name", async () => {
    const world = instance();
    mount(world, { kind: "instance" }, ["write", "publish"]);
    await settle();
    expect(seen.shared).toBe(true);
    noDraft();

    typeSummary("Fills a customer form.");
    await act(async () => button("Save").click());
    await settle();
    expect(world.puts).toEqual([
      { expectedRevision: LIVE_REVISION, expectedDraftRevision: undefined }
    ]);
    noDraft();
    expect(host.querySelector("[data-skill-filed]")).toBeNull();
  });

  it("submits the change for approval without the publish right, and shows what is live", async () => {
    const world = instance({ files: true });
    mount(world);
    await settle();
    noDraft();

    typeSummary("Fills a customer form.");
    await act(async () => button("Submit for approval").click());
    await settle();
    expect(world.puts).toEqual([
      { expectedRevision: LIVE_REVISION, expectedDraftRevision: undefined }
    ]);
    const filed = host.querySelector("[data-skill-filed]");
    expect(filed?.textContent).toContain("Submitted for approval.");
    expect(filed?.querySelector("a")?.getAttribute("href")).toContain("apr_filed");
    expect(summary()).toBe("");
    noDraft();
  });

  it("shows a draft from before read-only, offering its Publish to a holder of the right", async () => {
    const world = instance({ draft: oldDraft });
    mount(world);
    await settle();
    expect(host.querySelector("[data-skill-old-draft]")?.textContent).toContain(
      "from before skills went live on save"
    );
    expect(summary()).toBe(oldDraft.config.summary);
    expect(publish()?.disabled).toBe(true);
    expect(publish()?.title).toBe("Publishing needs the right “Publish skills”.");
    expect(
      [...host.querySelectorAll("button")].map((found) => found.textContent?.trim())
    ).not.toContain("Submit for approval");
    act(() => root.unmount());
    root = createRoot(host);
    mount(world, { kind: "instance" }, ["write", "publish"]);
    await settle();
    expect(publish()?.disabled).toBe(false);
  });
});

describe("the page of a skill of the reader's Personal Workspace", () => {
  it("has no draft: a save is live", async () => {
    const world = instance();
    mount(world, { kind: "workspace", workspaceId: "ws-mine" });
    await settle();
    expect(seen.shared).toBe(false);
    typeSummary("Fills a customer form.");
    await act(async () => button("Save").click());
    await settle();
    expect(world.puts).toEqual([
      { expectedRevision: LIVE_REVISION, expectedDraftRevision: undefined }
    ]);
    noDraft();
  });
});
