import type { AgentAvailability, ApiClient } from "@work-shape/catalyst-api-client";
import { ASSET_NAME_REFUSAL_REASONS } from "@work-shape/catalyst-core";

/** Where a new agent starts: everywhere, or in the shared workspace it was made in. */
export type AvailableIn = "all" | { workspaceId: string };

/**
 * A new agent's create that also makes what it uses available where it starts: the reader
 * chose so for the availability the instance's check named.
 */
export interface DependencyConsent {
  expectedAvailability: AgentAvailability;
}

/** What the instance says of a name a create would take. */
export type NameCheckAnswer =
  | {
      available: true;
      /** The reader's create of the name waits for an approval by one of these people. */
      saveApproval?: { approverNames: string[] };
    }
  | { available: false; reason: (typeof ASSET_NAME_REFUSAL_REASONS)[number]; message: string };

/** Asks the instance whether a new asset of a kind could take the name. */
export type CheckName = (name: string) => Promise<NameCheckAnswer>;

/** One asset as a write names it. Without a workspace it is one of the instance's own. */
interface AssetAddress {
  kind: string;
  name: string;
  /** The workspace that owns the asset. */
  workspaceId?: string;
}

/**
 * One file of an asset's folder as a write carries it: its path and its content, as `text`
 * for UTF-8 text and as `base64` for everything else.
 */
export type AssetFileWrite = { path: string; text: string } | { path: string; base64: string };

/** One file of an asset's folder as a read answers it, with its content. */
export interface AssetFileRead {
  path: string;
  bytes: number;
  sha256: string;
  /** The content of UTF-8 text. */
  text?: string;
  /** The content of every other file. */
  base64?: string;
}

/** One file a write of a folder stored: its path, its hash and its size. */
export interface AssetFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

/** What a write of an asset carries: its config, or the whole folder of a kind that has one. */
export type AssetContent =
  { config: Record<string, unknown> } | { files: readonly AssetFileWrite[] };

function contentOf(content: AssetContent): {
  config?: Record<string, unknown>;
  files?: AssetFileWrite[];
} {
  return "files" in content ? { files: [...content.files] } : { config: content.config };
}

function scopeOf(workspaceId: string | undefined): { workspaceId?: string } {
  return workspaceId === undefined ? {} : { workspaceId };
}

/**
 * The writes of one asset. Each names the revision its caller loaded, so a write over
 * somebody else's newer revision is answered with a conflict. The caller holds that revision
 * with the form it was loaded into: nothing here looks a later one up.
 */
export function createAssetWrites(client: ApiClient) {
  return {
    /** Whether a create would take the name, asked before it: the name's shape, then the id. */
    checkName: ({ kind, name, workspaceId }: AssetAddress): Promise<NameCheckAnswer> =>
      client.assets.check_name({ params: { kind }, body: { name, ...scopeOf(workspaceId) } }),
    /**
     * With `null` for the expected revision the call creates the asset. A new agent starts
     * where `availableIn` says, and hidden without it; with `dependencyConsent` the Knowledge
     * Bases and Connections it uses are made available there with it, by the reader's choice,
     * for the availability the reader was shown, and refused for any other. A kind whose revision holds a folder, such as a skill, is written as its config or
     * as its whole folder.
     */
    put: ({
      kind,
      name,
      workspaceId,
      expectedRevision,
      expectedDraftRevision,
      availableIn,
      dependencyConsent,
      ...content
    }: AssetAddress &
      AssetContent & {
        expectedRevision: number | null;
        /** The agent's draft revision the caller read, or `null` where it read none. */
        expectedDraftRevision?: number | null;
        availableIn?: AvailableIn;
        dependencyConsent?: DependencyConsent;
      }) =>
      client.assets.put({
        params: { kind, name },
        body: {
          ...contentOf(content),
          expectedRevision,
          ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision }),
          ...scopeOf(workspaceId),
          ...(availableIn ? { availableIn } : {}),
          ...(dependencyConsent
            ? {
                makeDependenciesAvailable: true,
                expectedAvailability: dependencyConsent.expectedAvailability
              }
            : {})
        }
      }),
    /** The whole folder of the asset's current revision, each file with its content. */
    readFiles: ({ kind, name, workspaceId }: AssetAddress) =>
      client.assets
        .get({ params: { kind, name }, query: { files: "true", ...scopeOf(workspaceId) } })
        .then((asset) => asset.files ?? []),
    delete: ({
      kind,
      name,
      workspaceId,
      expectedRevision
    }: AssetAddress & { expectedRevision: number }) =>
      client.assets.delete({
        params: { kind, name },
        body: { expectedRevision, ...scopeOf(workspaceId) }
      }),
    /** Names the revision to publish, which is the one its caller saved. */
    publish: ({ kind, name, workspaceId, revision }: AssetAddress & { revision: number }) =>
      client.assets.publish({
        params: { kind, name },
        body: { revision, ...scopeOf(workspaceId) }
      }),
    revert: ({
      kind,
      name,
      workspaceId,
      revision,
      expectedRevision,
      expectedDraftRevision
    }: AssetAddress & {
      revision: number;
      expectedRevision: number;
      /** The agent's draft revision the caller read, or `null` where it read none. */
      expectedDraftRevision?: number | null;
    }) =>
      client.assets.revert({
        params: { kind, name },
        body: {
          revision,
          expectedRevision,
          ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision }),
          ...scopeOf(workspaceId)
        }
      })
  };
}
