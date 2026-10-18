import { describe, expect, it } from "vitest";
import {
  cancelOffered,
  createInstanceSource,
  editOffered,
  listedToReader,
  resolveWorkflowRights
} from "@work-shape/catalyst-chat-ui/workflows";
import { workflowsContext } from "./chat-ui-build-fixtures";
import { runsReadable, workflowRightsOn } from "./support/chat-ui";
import { recordedApiClient } from "./support/recorded-api-client";

type Verb = "read" | "write" | "publish" | "delete";
const { signal } = new AbortController();
const none = resolveWorkflowRights(workflowsContext([]), "open");
const broad = resolveWorkflowRights(
  workflowsContext(["workflow.read", "workflow.write", "workflow.publish", "workflow.delete"]),
  "open"
);

function asset(name: string, allowed: Verb[], published = true) {
  const draft = allowed.includes("write") || allowed.includes("publish");
  return {
    id: `asset-${name}`,
    kind: "workflow",
    name,
    title: name,
    scope: { kind: "instance" },
    revision: 2,
    ...(published ? { publishedRevision: 1 } : {}),
    ...(draft ? { draftRevision: 2 } : {}),
    updatedAt: "2026-10-18T10:00:00.000Z",
    allowed,
    config: {
      name,
      manifest: {
        id: name,
        name,
        inputs: { type: "object", additionalProperties: false },
        outputs: { type: "object" },
        steps: [
          { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
          { id: "result", name: "Result", type: "output", input: {} }
        ]
      }
    }
  };
}

function sourceFor(records: ReturnType<typeof asset>[], listed: string[] = []) {
  const { client, calls } = recordedApiClient(({ operation, params }) => {
    if (operation === "assets.list") return { items: records };
    if (operation === "assets.get") return records.find((record) => record.name === params.name);
    if (operation === "workflows.list")
      return {
        items: listed.map((id) => ({
          id,
          name: id,
          definitionRevisionId: `revision-${id}`,
          runnable: true,
          reasons: [],
          actions: ["workflow.read"],
          inputs: { type: "object", additionalProperties: false }
        }))
      };
    throw new Error(`Unexpected operation: ${operation}`);
  });
  return { source: createInstanceSource(client, "permission-regression"), calls };
}

describe("Workflow rights from the API answer to its controls", () => {
  it("keeps a published write-only Workflow discoverable and editable without lending write to its sibling", async () => {
    const { source, calls } = sourceFor(
      [asset("mine", ["write"]), asset("other", ["read"])],
      ["other"]
    );
    const list = await source.listWorkflows("open", { limit: 50, cursor: undefined }, signal);
    expect(list.items.find((row) => row.id === "mine")).toMatchObject({
      published: true,
      allowed: ["write"]
    });
    expect(calls.map((call) => call.operation).sort()).toEqual(["assets.list", "workflows.list"]);
    const mine = await source.getWorkflow("open", "mine", signal);
    const other = await source.getWorkflow("open", "other", signal);
    expect(mine.published).toBe(true);
    expect(mine.mayStart).toBe(false);
    expect(editOffered(none, mine)).toBe(true);
    expect(editOffered(none, other)).toBe(false);
    expect(runsReadable(none, mine)).toBe(false);
    expect(runsReadable(none, other)).toBe(true);
  });

  it("lets the per-record delete deny override an instance-wide right only on that Workflow", async () => {
    const { source } = sourceFor(
      [asset("denied", ["read"]), asset("deletable", ["read", "delete"])],
      ["denied", "deletable"]
    );
    const { items } = await source.listWorkflows("open", { limit: 50, cursor: undefined }, signal);
    expect(
      workflowRightsOn(
        broad,
        items.find((row) => row.id === "denied")
      )
    ).toEqual({ read: true, write: false, publish: false, delete: false });
    expect(
      workflowRightsOn(
        broad,
        items.find((row) => row.id === "deletable")
      ).delete
    ).toBe(true);
  });

  it("lists an unpublished draft for its publisher without turning publish into write or run-data access", async () => {
    const { source } = sourceFor([asset("publishable", ["publish"], false)]);
    const { items } = await source.listWorkflows("open", { limit: 50, cursor: undefined }, signal);
    expect(items).toHaveLength(1);
    const only = items[0];
    if (only === undefined) throw new Error("The publisher's draft was omitted");
    expect(listedToReader(only, none)).toBe(true);
    const view = await source.getWorkflow("open", "publishable", signal);
    expect(editOffered(none, view)).toBe(false);
    expect(runsReadable(none, view)).toBe(false);
    expect(workflowRightsOn(none, view).publish).toBe(true);
  });

  it("uses the matching owner's actions only when the record says no allowed, and an empty allowed denies all", () => {
    const rights = resolveWorkflowRights(
      workflowsContext([], { open: ["workflow.read", "workflow.write", "workflow.delete"] }),
      "open"
    );
    expect(workflowRightsOn(rights, { ownerWorkspaceId: "open" })).toEqual({
      read: true,
      write: true,
      publish: false,
      delete: true
    });
    expect(workflowRightsOn(rights, { ownerWorkspaceId: "elsewhere" })).toEqual({
      read: false,
      write: false,
      publish: false,
      delete: false
    });
    expect(workflowRightsOn(rights, {})).toEqual({
      read: false,
      write: false,
      publish: false,
      delete: false
    });
    expect(workflowRightsOn(rights, { ownerWorkspaceId: "open", allowed: [] })).toEqual({
      read: false,
      write: false,
      publish: false,
      delete: false
    });
  });

  it("cancels another person's run only with write on that run's own Workflow", () => {
    const run = {
      ended: false,
      workflowId: "mine",
      startedBy: { id: "starter", name: "Starter" }
    };
    expect(cancelOffered(run, "viewer", none, { id: "mine", allowed: ["write"] })).toBe(true);
    expect(cancelOffered(run, "viewer", none, { id: "other", allowed: ["write"] })).toBe(false);
    expect(cancelOffered(run, "viewer", broad, { id: "mine", allowed: ["read"] })).toBe(false);
    expect(cancelOffered(run, "starter", none, { id: "mine", allowed: ["read"] })).toBe(true);
    expect(
      cancelOffered({ ...run, ended: true }, "starter", broad, { id: "mine", allowed: ["write"] })
    ).toBe(false);
  });
});
