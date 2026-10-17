// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type AgentDraft } from "@work-shape/catalyst-api-client";
import { DocsAddressProvider, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  AgentEditor,
  agentConfigToForm,
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  isEditableKind,
  resolveBuildRights,
  type AgentDraftSource,
  type BuildAsset,
  type BuildAssetEditorProps,
  type BuildSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { instanceActions, platformContext } from "./chat-ui-build-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";

// AD-4, the P2 AD-1's verifier found: a save on the agent page wrote the draft, the page went on
// showing the live agent and the next save was refused with 412. The page saves against the
// live revision it loaded and the draft revision it holds, so save after save works; a draft
// somebody else wrote is refused, read again and named with its author, with the way to load it.

const LIVE_REVISION = 3;
const live = { name: "assistant", displayName: "Assistant", instructions: "Help the user." };

const agentEntry = editableAgentKind();

function editableAgentKind() {
  const [entry] = buildAssetKinds;
  if (!entry || !isEditableKind(entry) || entry.kind !== "agent") {
    throw new Error("The platform registry has no agent entry first.");
  }
  return entry;
}

/** The instance the page writes to: the live agent stays, the draft moves under its fence. */
function instance() {
  const state: { draft: AgentDraft | null; next: number } = { draft: null, next: 1 };
  const puts: { expectedRevision: number | null; expectedDraftRevision?: number | null }[] = [];
  const draftOf = (config: Record<string, unknown>, name: string): AgentDraft => ({
    agent: "assistant",
    revision: state.next++,
    baseRevision: LIVE_REVISION,
    liveRevision: LIVE_REVISION,
    stale: false,
    config,
    author: { userId: `user_${name}`, name, release: false },
    updatedAt: "2026-10-17T09:30:00.000Z"
  });
  return {
    state,
    puts,
    /** Somebody else saves the draft. */
    writtenBy(name: string, instructions: string) {
      state.draft = draftOf({ ...live, instructions }, name);
    },
    async put(input: {
      config?: Record<string, unknown>;
      expectedRevision: number | null;
      expectedDraftRevision?: number | null;
    }) {
      puts.push({
        expectedRevision: input.expectedRevision,
        expectedDraftRevision: input.expectedDraftRevision
      });
      if (input.expectedRevision !== LIVE_REVISION) {
        throw new ApiError(412, "revision", {
          error: { code: "REVISION_CONFLICT", message: "revision", details: { conflicts: [] } }
        });
      }
      if ((input.expectedDraftRevision ?? null) !== (state.draft?.revision ?? null)) {
        throw new ApiError(412, "The agent draft changed", {
          error: {
            code: "REVISION_CONFLICT",
            message: "The agent draft changed",
            details: { reason: "draft_changed" }
          }
        });
      }
      state.draft = draftOf(input.config ?? {}, "Me");
      return { revision: state.draft.revision, draftRevision: state.draft.revision };
    }
  };
}

type Instance = ReturnType<typeof instance>;

/** The agent page with a draft source that reads the test's instance. */
function DraftedAgent({ frame, world }: { frame: BuildAssetEditorProps; world: Instance }) {
  const [latest, setLatest] = useState(world.state.draft);
  const draft: AgentDraftSource = {
    latest,
    reread: async () => setLatest(world.state.draft),
    saved: () => {
      const saved = world.state.draft;
      if (saved === null) throw new Error("The save wrote no draft.");
      setLatest(saved);
      return saved;
    },
    decide: async () => undefined,
    busy: undefined,
    answerFor: () => undefined
  };
  return createElement(AgentEditor, {
    frame,
    initialForm: agentConfigToForm(latest?.config ?? live),
    isDefault: false,
    references: undefined,
    editableAgentFields: ["instructions"],
    canManageAgentModels: false,
    skillChoice: { options: [], onSearch: () => undefined },
    draft
  });
}

/** What the caller holds on the whole instance, and what the instance says it may do on the agent. */
interface Held {
  instance?: string[];
  allowed?: BuildAsset["allowed"];
}

function buildSource(world: Instance, held: Held = {}): BuildSource {
  const permissions = ["config_assets.read", "config_assets.write"];
  const context = platformContext(undefined, [
    ...instanceActions(permissions),
    ...(held.instance ?? [])
  ]);
  const rights = resolveBuildRights({ permissions }, context);
  const asset: BuildAsset = {
    ...(held.allowed === undefined ? {} : { allowed: held.allowed }),
    id: "asset_assistant",
    kind: "agent",
    name: "assistant",
    scope: { kind: "instance" },
    revision: LIVE_REVISION,
    config: live,
    updatedAt: "2026-10-17T01:00:00.000Z"
  };
  return {
    kinds: [{ kind: "agent", canCreate: true, canDelete: true }],
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
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function mount(world: Instance, held: Held = {}) {
  const kind = {
    ...agentEntry,
    Editor: (frame: BuildAssetEditorProps) => createElement(DraftedAgent, { frame, world })
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
                    location: { kindPath: "agents", name: "assistant" },
                    open: () => undefined,
                    href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
                  }
                },
                createElement(BuildFrame, { source: buildSource(world, held) })
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

function instructions(): HTMLTextAreaElement {
  const found = host.querySelector("section#instructions textarea");
  if (!(found instanceof HTMLTextAreaElement))
    throw new Error(`no instructions: ${host.innerHTML}`);
  return found;
}

function type(value: string) {
  const field = instructions();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
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

async function saveDraft() {
  await act(async () => button("Save draft").click());
  await settle();
}

const badge = () => host.querySelector("[data-agent-draft-badge]")?.textContent ?? "";
const pending = () => host.querySelector('[data-agent-draft="pending"]')?.textContent ?? "";

describe("saving the agent page", () => {
  it("writes the draft again and again, each save fenced by the draft revision it holds", async () => {
    const world = instance();
    mount(world);
    await settle();
    expect(instructions().value).toBe("Help the user.");
    expect(host.querySelector("[data-agent-draft-badge]")).toBeNull();

    type("Help the user and cite the contract.");
    await saveDraft();
    expect(world.puts).toEqual([{ expectedRevision: LIVE_REVISION, expectedDraftRevision: null }]);
    // The page shows the draft it wrote, and the badge names it.
    expect(instructions().value).toBe("Help the user and cite the contract.");
    expect(badge()).toBe("Draft revision 1");
    expect(pending()).toContain("Draft revision 1, saved by Me on ");
    expect(host.querySelector('[data-published-field="instructions"]')?.textContent).toContain(
      "Help the user."
    );

    type("Help the user, cite the contract and name the clause.");
    await saveDraft();
    expect(world.puts[1]).toEqual({ expectedRevision: LIVE_REVISION, expectedDraftRevision: 1 });
    expect(badge()).toBe("Draft revision 2");
    expect(host.querySelector("[data-agent-draft-behind]")).toBeNull();
  });

  it("says who wrote a newer draft when a save is refused, and offers to load it", async () => {
    const world = instance();
    world.writtenBy("Ana Writer", "Help the user.");
    mount(world);
    await settle();
    expect(badge()).toBe("Draft revision 1");
    expect(pending()).toContain("saved by Ana Writer on ");

    // Somebody else saves the draft while this page has it open.
    world.writtenBy("Ben Builder", "Only read the contract.");
    type("Mine.");
    await saveDraft();
    expect(world.puts.at(-1)).toEqual({
      expectedRevision: LIVE_REVISION,
      expectedDraftRevision: 1
    });
    const behind = host.querySelector('[data-agent-draft-behind="2"]');
    expect(behind?.textContent).toContain("Ben Builder saved draft revision 2 on");
    expect(behind?.textContent).toContain("Load the newer draft");
    // What was typed stays; nothing is saved over the newer draft, and Publish waits.
    expect(instructions().value).toBe("Mine.");
    expect(button("Save draft").disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("[data-agent-publish]")?.disabled).toBe(true);
  });
});

describe("the rights on the agent page", () => {
  const publish = () => host.querySelector<HTMLButtonElement>("[data-agent-publish]");

  it("follows the instance's answer on this agent: a publish grant on the agent alone", async () => {
    const world = instance();
    world.writtenBy("Ana Writer", "Help the user.");
    // Instance-wide the caller writes agents and publishes none.
    mount(world);
    await settle();
    expect(publish()?.disabled).toBe(true);
    expect(publish()?.title).toBe("Publishing needs the right “Publish agents”.");
    act(() => root.unmount());
    root = createRoot(host);
    mount(world, { allowed: ["write", "publish"] });
    await settle();
    expect(publish()?.disabled).toBe(false);
  });

  it("follows the instance's answer on this agent: a deny on the agent over an instance allow", async () => {
    const world = instance();
    world.writtenBy("Ana Writer", "Help the user.");
    mount(world, { instance: ["agent.publish"] });
    await settle();
    expect(publish()?.disabled).toBe(false);
    act(() => root.unmount());
    root = createRoot(host);
    mount(world, { instance: ["agent.publish"], allowed: ["write", "delete"] });
    await settle();
    expect(publish()?.disabled).toBe(true);
    // Writing stays: the page still edits the draft.
    type("Mine.");
    expect(button("Save draft").disabled).toBe(false);
  });
});
